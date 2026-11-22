import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { app } from '../src/app.ts'
import { pool } from '../src/db.ts'
import { resetRateLimits } from '../src/core.ts'
import { forwardTarget } from '../src/forward.ts'
import { setProvisioner } from '../src/provisioner.ts'
import { getSecrets } from '../src/secrets.ts'
import { FakeProvisioner } from './fake-provisioner.ts'
import { join, login, org, PASSWORD, project, resetDashboard, user, withToken } from './helpers.ts'
import { stubCore } from './stub-core.ts'

const fake = new FakeProvisioner()
let core: Awaited<ReturnType<typeof stubCore>>
let acme: { id: string; slug: string }
let owner: Awaited<ReturnType<typeof user>>
let dev: Awaited<ReturnType<typeof user>>
let reader: Awaited<ReturnType<typeof user>>
let stranger: Awaited<ReturnType<typeof user>>
let p: Awaited<ReturnType<typeof project>>

beforeAll(async () => {
  await resetDashboard()
  setProvisioner(fake)
  core = await stubCore()
  forwardTarget.url = () => core.url
  acme = await org('acme')
  const other = await org('other')
  owner = await user('owner@example.test')
  dev = await user('dev@example.test')
  reader = await user('reader@example.test')
  stranger = await user('stranger@example.test')
  await join(acme.id, owner.id, 'owner')
  await join(acme.id, dev.id, 'developer')
  await join(acme.id, reader.id, 'read_only')
  await join(other.id, stranger.id, 'owner')
  p = await project(acme.id, { name: 'corteqs' })
  fake.running(p.ref, 'test')
})
afterAll(() => core.close())
beforeEach(() => resetRateLimits())

describe('/v1/projects', () => {
  test('create answers 201 COMING_UP and enqueues project.create', async () => {
    const res = await withToken(owner.token, 'POST', '/v1/projects',
      { name: 'demo', organization_slug: 'acme', db_pass: 'a-url-safe_password.123', region: 'eu-central-1', desired_instance_size: 'micro' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ id: body.ref, name: 'demo', organization_id: 'acme', organization_slug: 'acme', region: 'main', status: 'COMING_UP' })
    const row = (await pool.query(`select id, ref, size from control.projects where ref = $1`, [body.ref])).rows[0]
    expect(row.size).toBe('micro')
    const jobs = (await pool.query(`select type from control.jobs where project_id = $1`, [row.id])).rows
    expect(jobs).toEqual([{ type: 'project.create' }])
    // db_pass is the superuser password, as at Supabase
    expect((await getSecrets(pool, row)).POSTGRES_PASSWORD).toBe('a-url-safe_password.123')
  })

  test('create refuses a size we do not have, a password that is not URL-safe, a developer', async () => {
    const base = { name: 'x', organization_slug: 'acme', db_pass: 'a-url-safe_password.123' }
    expect((await withToken(owner.token, 'POST', '/v1/projects', { ...base, desired_instance_size: 'large' })).status).toBe(400)
    expect((await withToken(owner.token, 'POST', '/v1/projects', { ...base, db_pass: 'has space/and?query' })).status).toBe(400)
    expect((await withToken(dev.token, 'POST', '/v1/projects', base)).status).toBe(403)
    expect((await withToken(stranger.token, 'POST', '/v1/projects', base)).status).toBe(404)
  })

  test('list shows the projects of the caller\'s organizations only', async () => {
    const mine = await (await withToken(owner.token, 'GET', '/v1/projects')).json()
    expect(mine.map((x: any) => x.ref)).toContain(p.ref)
    expect(await (await withToken(stranger.token, 'GET', '/v1/projects')).json()).toEqual([])
  })

  test('get has the Management API fields with neutral values', async () => {
    const res = await withToken(reader.token, 'GET', `/v1/projects/${p.ref}`)
    expect(await res.json()).toEqual({
      id: p.ref, ref: p.ref, organization_id: 'acme', organization_slug: 'acme', name: 'corteqs', region: 'main',
      status: 'ACTIVE_HEALTHY', created_at: expect.any(String),
      database: { host: 'db', version: '17', postgres_engine: '17', release_channel: 'ga' },
    })
  })

  test('a member of another organization gets 404, the same as an unknown ref', async () => {
    const real = await withToken(stranger.token, 'GET', `/v1/projects/${p.ref}`)
    const missing = await withToken(stranger.token, 'GET', '/v1/projects/zzzzzzzzzzzzzzzzzzzz')
    expect([real.status, missing.status]).toEqual([404, 404])
    expect(await real.json()).toEqual(await missing.json())
  })

  test('a developer cannot delete; an owner can', async () => {
    const q = await project(acme.id)
    expect((await withToken(dev.token, 'DELETE', `/v1/projects/${q.ref}`)).status).toBe(403)
    const res = await withToken(owner.token, 'DELETE', `/v1/projects/${q.ref}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 0, ref: q.ref, name: q.name })
    expect((await pool.query(`select type from control.jobs where project_id = $1`, [q.id])).rows).toEqual([{ type: 'project.delete' }])
  })

  test('pause enqueues project.pause; restore refused by admission is a 400 with the message', async () => {
    const q = await project(acme.id)
    expect((await withToken(owner.token, 'POST', `/v1/projects/${q.ref}/pause`)).status).toBe(200)
    expect((await pool.query(`select type from control.jobs where project_id = $1`, [q.id])).rows).toEqual([{ type: 'project.pause' }])
    const paused = await project(acme.id, { status: 'INACTIVE', size: 'medium' })
    const budget = (await pool.query(`select memory_budget_mb from control.nodes`)).rows[0].memory_budget_mb
    await pool.query(`update control.nodes set memory_budget_mb = 4000`)
    try {
      const res = await withToken(owner.token, 'POST', `/v1/projects/${paused.ref}/restore`)
      expect(res.status).toBe(400)
      expect((await res.json()).message).toMatch(/MiB of memory free/)
      expect((await pool.query(`select 1 from control.jobs where project_id = $1`, [paused.id])).rowCount).toBe(0)
    } finally {
      await pool.query(`update control.nodes set memory_budget_mb = $1`, [budget])
    }
  })

  test('health answers per service from container health', async () => {
    const res = await withToken(reader.token, 'GET', `/v1/projects/${p.ref}/health?services=db,auth,pooler`)
    expect(await res.json()).toEqual([
      { name: 'db', healthy: true, status: 'ACTIVE_HEALTHY' },
      { name: 'auth', healthy: true, status: 'ACTIVE_HEALTHY' },
      { name: 'pooler', healthy: true, status: 'ACTIVE_HEALTHY' },
    ])
    fake.set(p.ref, 'core', { health: 'unhealthy' })
    try {
      const [auth] = await (await withToken(reader.token, 'GET', `/v1/projects/${p.ref}/health?services=auth`)).json()
      expect(auth).toEqual({ name: 'auth', healthy: false, status: 'UNHEALTHY' })
    } finally {
      fake.set(p.ref, 'core', { health: 'healthy' })
    }
    expect((await withToken(reader.token, 'GET', `/v1/projects/${p.ref}/health?services=nope`)).status).toBe(400)
  })
})

describe('/v1/projects/{ref}/api-keys', () => {
  test('without reveal no full key is shown', async () => {
    const text = await (await withToken(reader.token, 'GET', `/v1/projects/${p.ref}/api-keys`)).text()
    const keys = JSON.parse(text)
    expect(keys.map((k: any) => [k.name, k.type])).toEqual([['anon', 'legacy'], ['service_role', 'legacy']])
    expect(text).not.toContain(p.secrets.ANON_KEY)
    expect(text).not.toContain(p.secrets.SERVICE_ROLE_KEY)
  })

  test('reveal=true needs project.keys', async () => {
    expect((await withToken(reader.token, 'GET', `/v1/projects/${p.ref}/api-keys?reveal=true`)).status).toBe(403)
    const keys = await (await withToken(dev.token, 'GET', `/v1/projects/${p.ref}/api-keys?reveal=true`)).json()
    expect(keys.map((k: any) => k.api_key)).toEqual([p.secrets.ANON_KEY, p.secrets.SERVICE_ROLE_KEY])
  })
})

describe('/v1/projects/{ref}/database/query', () => {
  test('select 1 as a answers rows as objects', async () => {
    const res = await withToken(dev.token, 'POST', `/v1/projects/${p.ref}/database/query`, { query: 'select 1 as a' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual([{ a: 1 }])
    const last = core.seen.at(-1)!
    expect(last.url).toBe('/admin/sql')
    expect(last.headers.authorization).toBe(`Bearer ${p.secrets.ADMIN_TOKEN}`)
    expect(last.headers['x-selfbase-actor']).toBe('dev@example.test')
  })

  test('an SQL error is a 400 with the message', async () => {
    const res = await withToken(dev.token, 'POST', `/v1/projects/${p.ref}/database/query`, { query: 'selec 1' })
    expect(res.status).toBe(400)
    expect((await res.json()).message).toMatch(/syntax error/)
  })

  test('read_only cannot run SQL', async () => {
    expect((await withToken(reader.token, 'POST', `/v1/projects/${p.ref}/database/query`, { query: 'select 1 as a' })).status).toBe(403)
  })
})

test('a cookie is not accepted on /v1', async () => {
  const cookie = await login('owner@example.test', PASSWORD)
  const res = await app.request('/v1/projects', { headers: { cookie } })
  expect(res.status).toBe(401)
})
