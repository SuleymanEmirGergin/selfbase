import { beforeAll, describe, expect, test } from 'vitest'
import { app } from '../src/app.ts'
import { resetRateLimits } from '../src/core.ts'
import { pool } from '../src/db.ts'
import { reconcileOnce } from '../src/reconcile.ts'
import { createConfirmedUser } from '../src/routes/platform-auth.ts'
import { FakeProvisioner } from './fake-provisioner.ts'
import { ORIGIN, as, login, resetDashboard, withToken } from './helpers.ts'

const PASSWORD = 'correct-horse-battery'
let cookie: string
let orgId: string

beforeAll(async () => {
  await resetDashboard()
  const user = await createConfirmedUser('owner@example.test', PASSWORD)
  orgId = (await pool.query(`insert into control.organizations (slug, name) values ('acme', 'Acme') returning id`)).rows[0].id
  await pool.query(`insert into control.memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [orgId, user.id])
  cookie = await login('owner@example.test', PASSWORD)
  await pool.query(`truncate control.audit_log`) // the login above is a write too
})

const rows = async () => (await pool.query(`select * from control.audit_log order by id`)).rows

test('POST /platform/access-tokens writes one row with body keys, never the token', async () => {
  const res = await as(cookie, 'POST', '/platform/access-tokens', { name: 'ci' })
  const { token } = await res.json()
  const [row, ...rest] = await rows()
  expect(rest).toEqual([])
  expect(row).toMatchObject({
    actor: 'owner@example.test',
    action: 'POST /platform/access-tokens',
    details: { status: 201, body_keys: ['name'] },
  })
  expect(JSON.stringify(row)).not.toContain(token)
  expect(JSON.stringify(row)).not.toContain('"ci"')
})

test('a GET writes nothing', async () => {
  await pool.query(`truncate control.audit_log`)
  await as(cookie, 'GET', '/platform/me')
  await as(cookie, 'GET', '/platform/organizations/acme/members')
  expect(await rows()).toEqual([])
})

test('org writes carry org_id, the route pattern and the target; refusals are recorded, unauthenticated calls are not', async () => {
  await pool.query(`truncate control.audit_log`)
  await as(cookie, 'POST', '/platform/organizations/acme/invitations', { email: 'dev@example.test', role: 'developer' })
  await as(cookie, 'POST', '/platform/organizations/acme/invitations', { email: 'dev@example.test', role: 'nope', extra: 1 })
  await as('', 'POST', '/platform/access-tokens', { name: 'x' })
  const [ok, bad, ...anon] = await rows()
  expect(ok).toMatchObject({ org_id: orgId, action: 'POST /platform/organizations/:slug/invitations', target: 'dev@example.test',
    details: { status: 201, body_keys: ['email', 'role'] } })
  expect(bad).toMatchObject({ org_id: orgId, details: { status: 400, body_keys: ['email', 'role', 'extra'] } })
  expect(anon).toEqual([])
  expect(JSON.stringify(await rows())).not.toContain('nope')
})

test('audit-log pages by id, newest first', async () => {
  await pool.query(`truncate control.audit_log`)
  for (let i = 0; i < 3; i++) await as(cookie, 'POST', '/platform/access-tokens', { name: `t${i}` })
  // tokens are personal: their rows have no org, so give them this org to page through
  await pool.query(`update control.audit_log set org_id = $1, at = '2026-01-01T00:00:00Z'`, [orgId])
  const { token } = await (await as(cookie, 'POST', '/platform/access-tokens', { name: 'reader' })).json()
  const first = await (await withToken(token, 'GET', '/platform/organizations/acme/audit-log?limit=2')).json()
  expect(first).toHaveLength(2)
  expect(typeof first[0].id).toBe('number')
  expect(first[0].id).toBeGreaterThan(first[1].id)
  expect(first[0]).toEqual({ id: expect.any(Number), at: expect.any(String), actor: 'owner@example.test', org_id: orgId, project_id: null,
    action: 'POST /platform/access-tokens', target: null, ip: expect.any(String), details: { status: 201, body_keys: ['name'] } })
  // same `at` on every row: only the id cursor separates the pages
  const next = await (await withToken(token, 'GET', `/platform/organizations/acme/audit-log?limit=2&before=${first[1].id}`)).json()
  expect(next.map((r: any) => r.id)).toEqual([first[1].id - 1])
  expect((await withToken(token, 'GET', '/platform/organizations/acme/audit-log?before=2026-01-01')).status).toBe(400)
})

describe('S6: anonymous requests cannot grow the audit log', () => {
  const anon = (path: string, body: unknown, ip = '203.0.113.7') => app.request(path, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': ip }, body: JSON.stringify(body) })

  test('an anonymous write to an unknown path under a public prefix writes no row', async () => {
    resetRateLimits()
    await pool.query(`truncate control.audit_log`)
    for (const path of ['/platform/auth/v1/nope', '/platform/auth/v1/x/y', '/platform/auth/v1/token'])
      expect((await anon(path, { k0: 0 })).status, path).toBe(404)
    expect(await rows()).toEqual([])
  })

  test('a row keeps at most 32 body key names, each cut to 64 characters', async () => {
    resetRateLimits()
    await pool.query(`truncate control.audit_log`)
    const body = Object.fromEntries([['k'.repeat(100), 1], ...Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])])
    expect((await anon('/platform/login', body)).status).toBe(400)
    const [row, ...rest] = await rows()
    expect(rest).toEqual([])
    expect(row.details.body_keys).toHaveLength(32)
    expect(row.details.body_keys[0]).toBe('k'.repeat(64))
    expect(row.details.body_keys.every((k: string) => k.length <= 64)).toBe(true)
    // a signed-in caller's row is capped the same way
    await as(cookie, 'POST', '/platform/access-tokens', body)
    expect((await rows()).at(-1).details.body_keys).toHaveLength(32)
  })

  test('the 6th failed sign-in from one IP is refused (429) and writes no row', async () => {
    resetRateLimits()
    await pool.query(`truncate control.audit_log`)
    const statuses = []
    for (let i = 0; i < 6; i++) statuses.push((await anon('/platform/login', { email: 'owner@example.test', password: 'wrong-password-value' }, '203.0.113.8')).status)
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429])
    expect((await rows()).map((r) => r.details.status)).toEqual([400, 400, 400, 400, 400])
  })

  test('other public writes are limited per IP before audit', async () => {
    resetRateLimits()
    await pool.query(`truncate control.audit_log`)
    const statuses = []
    for (let i = 0; i < 6; i++) statuses.push((await anon('/platform/invitations/accept', { token: 'x', password: 'y' }, '203.0.113.9')).status)
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true)
    expect(statuses[5]).toBe(429)
    expect((await rows())).toHaveLength(5)
  })

  test('the reconcile pass prunes audit rows older than 90 days', async () => {
    await pool.query(`truncate control.audit_log`)
    await pool.query(`insert into control.audit_log (actor, action, at) values ('a', 'old', now() - interval '91 days'), ('a', 'recent', now() - interval '89 days')`)
    await reconcileOnce({ db: pool, provisioner: new FakeProvisioner(), probe: async () => 'ok' })
    expect((await rows()).map((r) => r.action)).toEqual(['recent'])
  })
})
