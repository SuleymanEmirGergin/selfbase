// Our /v1 routes against Supabase's published Management API document (docs/reference/management-api.json).
import { afterAll, beforeAll, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { app } from '../src/app.ts'
import { resetRateLimits } from '../src/core.ts'
import { forwardTarget } from '../src/forward.ts'
import { setProvisioner } from '../src/provisioner.ts'
import { operations } from '../src/routes/v1.ts'
import { FakeProvisioner } from './fake-provisioner.ts'
import { join, org, project, resetDashboard, user, withToken } from './helpers.ts'
import { stubCore } from './stub-core.ts'

const doc = JSON.parse(readFileSync(new URL('../../docs/reference/management-api.json', import.meta.url), 'utf8'))
const toOpenApi = (path: string) => path.replace(/:(\w+)/g, '{$1}')
const registered = () =>
  [...new Set(app.routes.filter((r) => r.path.startsWith('/v1/') && r.method !== 'ALL').map((r) => `${r.method} ${r.path}`))].sort()

const deref = (s: any): any => (s?.$ref ? deref(doc.components.schemas[s.$ref.split('/').pop()]) : s)

/** Required fields present, types equal (and enum values allowed), recursively; extra fields are allowed. */
function check(schema: any, v: unknown, at: string, errors: string[]): void {
  const s = deref(schema)
  if (!s) return
  if (v === null) {
    if (!s.nullable && s.type !== 'null' && !(s.oneOf ?? s.anyOf)?.some((x: any) => deref(x).type === 'null')) errors.push(`${at}: null`)
    return
  }
  const alts = s.oneOf ?? s.anyOf
  if (alts) {
    const fits = alts.some((x: any) => { const e: string[] = []; check(x, v, at, e); return !e.length })
    if (!fits) errors.push(`${at}: fits none of ${alts.length} alternatives`)
    return
  }
  const type = Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v
  if (s.type && s.type !== type && !(s.type === 'number' && type === 'integer')) return void errors.push(`${at}: ${type}, want ${s.type}`)
  if (s.enum && !s.enum.includes(v)) errors.push(`${at}: ${JSON.stringify(v)} not in enum`)
  if (type === 'array') (v as unknown[]).forEach((x, i) => check(s.items, x, `${at}[${i}]`, errors))
  if (type === 'object') {
    for (const k of s.required ?? []) if (!(k in (v as object))) errors.push(`${at}.${k}: missing`)
    for (const [k, x] of Object.entries(v as object)) if (s.properties?.[k]) check(s.properties[k], x, `${at}.${k}`, errors)
  }
}

let core: Awaited<ReturnType<typeof stubCore>>
let cases: Record<string, () => Promise<Response>>

beforeAll(async () => {
  await resetDashboard()
  resetRateLimits()
  const fake = new FakeProvisioner()
  setProvisioner(fake)
  core = await stubCore()
  forwardTarget.url = () => core.url
  const acme = await org('acme')
  const owner = await user('owner@example.test')
  await join(acme.id, owner.id, 'owner')
  const p = await project(acme.id)
  const paused = await project(acme.id, { status: 'INACTIVE' })
  const doomed = await project(acme.id)
  fake.running(p.ref, 'test')
  const t = (method: string, path: string, body?: unknown) => () => withToken(owner.token, method, path, body)
  cases = {
    'GET /v1/organizations': t('GET', '/v1/organizations'),
    'GET /v1/organizations/:slug': t('GET', '/v1/organizations/acme'),
    'GET /v1/organizations/:slug/members': t('GET', '/v1/organizations/acme/members'),
    'GET /v1/projects': t('GET', '/v1/projects'),
    'POST /v1/projects': t('POST', '/v1/projects', { name: 'n', organization_slug: 'acme', db_pass: 'long-enough-password' }),
    'GET /v1/projects/:ref': t('GET', `/v1/projects/${p.ref}`),
    'DELETE /v1/projects/:ref': t('DELETE', `/v1/projects/${doomed.ref}`),
    'POST /v1/projects/:ref/pause': t('POST', `/v1/projects/${p.ref}/pause`),
    'POST /v1/projects/:ref/restore': t('POST', `/v1/projects/${paused.ref}/restore`),
    'GET /v1/projects/:ref/health': t('GET', `/v1/projects/${p.ref}/health?services=db,rest,auth,realtime,storage,pooler`),
    'GET /v1/projects/:ref/api-keys': t('GET', `/v1/projects/${p.ref}/api-keys`),
    'POST /v1/projects/:ref/database/query': t('POST', `/v1/projects/${p.ref}/database/query`, { query: 'select 1 as a' }),
    'GET /v1/projects/:ref/config/auth': t('GET', `/v1/projects/${p.ref}/config/auth`),
    'PATCH /v1/projects/:ref/config/auth': t('PATCH', `/v1/projects/${p.ref}/config/auth`, { site_url: 'https://app.example.test' }),
  }
})
afterAll(() => core.close())

test('every /v1 route exists in the snapshot with its method and declared operationId', () => {
  const routes = registered()
  expect(routes.length).toBeGreaterThan(0)
  for (const key of routes) {
    const [method, path] = key.split(' ')
    const op = doc.paths[toOpenApi(path)]?.[method.toLowerCase()]
    expect(op, `${key} is not in the snapshot`).toBeDefined()
    expect(operations[key], `${key} declares no operationId`).toBeDefined()
    expect(operations[key], key).toBe(op.operationId)
  }
  // nothing declared that is not registered
  expect(Object.keys(operations).sort()).toEqual(routes)
})

test('a response of each route validates against the snapshot schema for its status', async () => {
  expect(Object.keys(cases).sort()).toEqual(registered())
  for (const [key, run] of Object.entries(cases)) {
    const [method, path] = key.split(' ')
    const res = await run()
    const op = doc.paths[toOpenApi(path)][method.toLowerCase()]
    const spec = op.responses[String(res.status)]
    expect(spec, `${key} answered ${res.status}, which the snapshot does not list`).toBeDefined()
    const schema = spec.content?.['application/json']?.schema
    if (!schema) continue
    const errors: string[] = []
    check(schema, await res.json(), key, errors)
    expect(errors, key).toEqual([])
  }
})
