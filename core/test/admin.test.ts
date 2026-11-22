import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'

// config reads env at import, so set storage dir before loading app
const base = mkdtempSync(join(tmpdir(), 'sb-admin-'))
process.env.STORAGE_DIR = join(base, 'storage')

const { app } = await import('../src/app.ts')
const { pool, asUser } = await import('../src/db.ts')
const { config } = await import('../src/config.ts')
const { verify, sign } = await import('../src/jwt.ts')
const { sqlLimits } = await import('../src/admin/sql.ts')
const { SignJWT } = await import('jose')

const ADMIN_EMAIL = 'admin@example.test'
const ADMIN_PW = 'panel-test-password'
const S = 't6' // test schema
const serviceKey = process.env.SERVICE_ROLE_KEY!
let cookie = ''

type Init = { body?: unknown; headers?: Record<string, string>; raw?: BodyInit }
const call = (method: string, path: string, init: Init = {}, url = 'http://localhost') =>
  app.request(`${url}/admin${path}`, {
    method,
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  })
const json = async (res: Response) => ({ status: res.status, body: await res.json() })
const login = (email: string, password: string, ip = randomUUID()) =>
  app.request('http://localhost/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password }),
  })

beforeAll(async () => {
  config.panelAdminEmail = ADMIN_EMAIL
  config.panelAdminPasswordHash = await bcrypt.hash(ADMIN_PW, 4)
  process.env.TRUST_PROXY = 'true'
  await pool.query(`drop schema if exists ${S} cascade; create schema ${S};
    grant usage on schema ${S} to anon;
    create table ${S}.items (id int primary key, label text not null, big bigint, at timestamptz, data jsonb);
    create table ${S}.victim (id int);
    create table ${S}.nopk (v text);
    create table ${S}.docs (id int primary key, j jsonb);
    create table ${S}.floats (id int primary key, f float8, r real);
    insert into ${S}.floats values (1, 'NaN', 'Infinity'), (2, '-Infinity', 1.5);
    grant select on ${S}.items to anon;
    alter table ${S}.items enable row level security;
    insert into ${S}.items values (1, 'one', 9007199254740993, '2026-01-02 03:04:05.123456+00', '{"a":1}'), (2, 'two', null, null, null);
    insert into ${S}.nopk values ('x');`)
  const res = await login(ADMIN_EMAIL, ADMIN_PW)
  expect(res.status).toBe(200)
  cookie = res.headers.get('set-cookie')!.split(';')[0]
})

afterAll(async () => {
  await pool.query(`drop schema if exists ${S} cascade`)
  rmSync(base, { recursive: true, force: true })
})

describe('panel session', () => {
  const routes: [string, string][] = [
    ['POST', '/logout'], ['GET', '/me'], ['GET', '/schemas'], ['GET', '/tables?schema=public'],
    ['GET', `/rows/${S}/items`], ['POST', `/rows/${S}/items`], ['PATCH', `/rows/${S}/items`], ['DELETE', `/rows/${S}/items`],
    ['GET', '/policies'], ['POST', '/policies'], ['DELETE', '/policies'], ['POST', '/rls'], ['POST', '/sql'],
    ['GET', '/users'], ['PATCH', `/users/${randomUUID()}`], ['DELETE', `/users/${randomUUID()}`],
    ['GET', '/buckets'], ['POST', '/buckets'], ['GET', '/files/b'], ['GET', '/files/b/x.txt'],
    ['POST', '/files/b/x.txt'], ['DELETE', '/files/b/x.txt'], ['GET', '/nope'],
  ]

  it('answers 401 on every route without the panel cookie', async () => {
    for (const [m, p] of routes) {
      const res = await app.request(`/admin${p}`, { method: m })
      expect(res.status, `${m} ${p}`).toBe(401)
    }
  })

  it('does not accept the service_role key or a user JWT instead of the cookie', async () => {
    const user = await sign({ sub: randomUUID(), role: 'authenticated' }, 60)
    for (const token of [serviceKey, user]) {
      for (const [m, p] of routes) {
        const res = await app.request(`/admin${p}`, { method: m, headers: { authorization: `Bearer ${token}`, apikey: token } })
        expect(res.status, `${m} ${p}`).toBe(401)
      }
    }
  })

  it('rejects a forged or role-carrying cookie', async () => {
    const asCookie = (v: string) => app.request('/admin/me', { headers: { cookie: `sb_panel=${v}` } })
    expect((await asCookie(serviceKey)).status).toBe(401)
    expect((await asCookie(cookie.split('=')[1] + 'x')).status).toBe(401)
  })

  it('sets an HttpOnly SameSite=Strict cookie, Secure except on http localhost', async () => {
    const local = (await login(ADMIN_EMAIL, ADMIN_PW)).headers.get('set-cookie')!
    expect(local).toMatch(/HttpOnly/)
    expect(local).toMatch(/SameSite=Strict/)
    expect(local).toMatch(/Path=\/admin/)
    expect(local).not.toMatch(/Secure/)
    const remote = await app.request('http://panel.example.test/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': randomUUID() },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PW }),
    })
    expect(remote.headers.get('set-cookie')).toMatch(/Secure/)
  })

  it('panel cookie is never a valid API token', async () => {
    await expect(verify(decodeURIComponent(cookie.split('=')[1]))).rejects.toThrow()
    const res = await app.request('/auth/v1/user', { headers: { authorization: `Bearer ${cookie.split('=')[1]}` } })
    expect(res.status).toBe(401)
  })

  it('GET /me returns the admin email', async () => {
    expect(await json(await call('GET', '/me'))).toEqual({ status: 200, body: { email: ADMIN_EMAIL } })
  })

  it('rejects wrong password and unknown email with 401', async () => {
    expect((await login(ADMIN_EMAIL, 'wrong')).status).toBe(401)
    expect((await login('other@example.test', ADMIN_PW)).status).toBe(401)
  })

  it('disables login when the hash env is empty', async () => {
    const saved = config.panelAdminPasswordHash
    config.panelAdminPasswordHash = ''
    try {
      expect((await login(ADMIN_EMAIL, ADMIN_PW)).status).toBe(401)
      expect((await login(ADMIN_EMAIL, '')).status).toBe(401)
    } finally {
      config.panelAdminPasswordHash = saved
    }
  })

  it('locks an IP for 15 minutes after 5 failed logins', async () => {
    const ip = randomUUID()
    for (let i = 0; i < 5; i++) expect((await login(ADMIN_EMAIL, 'wrong', ip)).status).toBe(401)
    expect((await login(ADMIN_EMAIL, 'wrong', ip)).status).toBe(429)
    expect((await login(ADMIN_EMAIL, ADMIN_PW, ip)).status).toBe(429)
    expect((await login(ADMIN_EMAIL, ADMIN_PW)).status).toBe(200) // other IPs unaffected
  })

  it('throttles by socket IP when TRUST_PROXY is off', async () => {
    const saved = process.env.TRUST_PROXY
    process.env.TRUST_PROXY = 'false'
    const viaSocket = (ip: string, password: string, xff = randomUUID()) =>
      app.request('http://localhost/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
        body: JSON.stringify({ email: ADMIN_EMAIL, password }),
      }, { incoming: { socket: { remoteAddress: ip } } })
    try {
      const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
      for (let i = 0; i < 5; i++) expect((await viaSocket(ip, 'wrong')).status).toBe(401)
      // a fresh X-Forwarded-For value is ignored without TRUST_PROXY
      expect((await viaSocket(ip, ADMIN_PW)).status).toBe(429)
      expect((await viaSocket('10.9.9.9', ADMIN_PW)).status).toBe(200)
    } finally {
      process.env.TRUST_PROXY = saved
    }
  })

  it('behind a trusted proxy keys on the rightmost X-Forwarded-For entry', async () => {
    const proxySeen = randomUUID()
    for (let i = 0; i < 5; i++) expect((await login(ADMIN_EMAIL, 'wrong', `${randomUUID()}, ${proxySeen}`)).status).toBe(401)
    // a spoofed leftmost entry does not open a fresh bucket
    expect((await login(ADMIN_EMAIL, ADMIN_PW, `1.2.3.4, ${proxySeen}`)).status).toBe(429)
  })

  it('rejects a role-carrying panel token and an alg:none token', async () => {
    const key = new TextEncoder().encode(process.env.JWT_SECRET!)
    const withRole = await new SignJWT({ panel: true, role: 'service_role', email: ADMIN_EMAIL })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(key)
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ panel: true, email: ADMIN_EMAIL, exp: Math.floor(Date.now() / 1000) + 3600 })}.`
    for (const t of [withRole, none]) expect((await app.request('/admin/me', { headers: { cookie: `sb_panel=${t}` } })).status).toBe(401)
  })

  it('treats http://[::1] as local (no Secure)', async () => {
    const res = await app.request('http://[::1]/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': randomUUID() },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PW }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).not.toMatch(/Secure/)
  })

  it('accepts PUBLIC_URL origin and a missing Origin on state-changing requests', async () => {
    const pub = new URL(config.publicUrl).origin
    expect(pub).not.toBe('http://localhost')
    expect((await call('POST', '/sql', { body: { query: 'select 1' }, headers: { origin: pub } })).status).toBe(200)
    expect((await call('POST', '/sql', { body: { query: 'select 1' } })).status).toBe(200)
  })

  it('rejects a cross-origin state-changing request with 403', async () => {
    const res = await call('POST', '/sql', { body: { query: 'select 1' }, headers: { origin: 'http://evil.example' } })
    expect(res.status).toBe(403)
    const same = await call('POST', '/sql', { body: { query: 'select 1' }, headers: { origin: 'http://localhost' } })
    expect(same.status).toBe(200)
  })

  it('logout clears the cookie', async () => {
    const res = await call('POST', '/logout')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(/sb_panel=;.*Max-Age=0/)
  })
})

describe('tables and rows', () => {
  it('lists schemas without system schemas', async () => {
    const { body } = await json(await call('GET', '/schemas'))
    expect(body).toContain(S)
    expect(body).toContain('public')
    expect(body.some((s: string) => s.startsWith('pg_') || s === 'information_schema')).toBe(false)
  })

  it('lists tables with columns', async () => {
    const { body } = await json(await call('GET', `/tables?schema=${S}`))
    const items = body.find((t: any) => t.name === 'items')
    expect(items).toMatchObject({ schema: S, rls_enabled: true })
    expect(typeof items.row_estimate).toBe('number')
    expect(items.columns[0]).toEqual({ name: 'id', type: 'integer', nullable: false, default: null, is_pk: true })
    expect(items.columns[1]).toMatchObject({ name: 'label', type: 'text', is_pk: false })
  })

  it('reads rows with exact strings for bigint and timestamps', async () => {
    const { status, body } = await json(await call('GET', `/rows/${S}/items?order=id.asc`))
    expect(status).toBe(200)
    expect(body.total).toBe(2)
    expect(body.rows[0]).toEqual({ id: 1, label: 'one', big: '9007199254740993', at: '2026-01-02 03:04:05.123456+00', data: { a: 1 } })
  })

  it('supports limit, offset, order and filters', async () => {
    let r = await json(await call('GET', `/rows/${S}/items?order=id.desc&limit=1`))
    expect(r.body.rows.map((x: any) => x.id)).toEqual([2])
    expect(r.body.total).toBe(2)
    r = await json(await call('GET', `/rows/${S}/items?order=id.asc&limit=1&offset=1`))
    expect(r.body.rows.map((x: any) => x.id)).toEqual([2])
    r = await json(await call('GET', `/rows/${S}/items?filter=label.eq.one`))
    expect(r.body).toMatchObject({ total: 1, rows: [{ id: 1 }] })
    r = await json(await call('GET', `/rows/${S}/items?filter=id.gte.2&filter=label.ilike.T%25`))
    expect(r.body).toMatchObject({ total: 1, rows: [{ id: 2 }] })
    r = await json(await call('GET', `/rows/${S}/items?filter=big.is.null`))
    expect(r.body).toMatchObject({ total: 1, rows: [{ id: 2 }] })
  })

  it('round-trips insert, update and delete', async () => {
    let r = await json(await call('POST', `/rows/${S}/items`, { body: { values: { id: 10, label: 'ten', big: '9007199254740995' } } }))
    expect(r).toMatchObject({ status: 200, body: { id: 10, label: 'ten', big: '9007199254740995' } })
    r = await json(await call('PATCH', `/rows/${S}/items`, { body: { pk: { id: 10 }, values: { label: 'TEN', data: { x: [1] } } } }))
    expect(r).toMatchObject({ status: 200, body: { id: 10, label: 'TEN', data: { x: [1] } } })
    const db = await pool.query(`select label, big::text, data from ${S}.items where id = 10`)
    expect(db.rows[0]).toEqual({ label: 'TEN', big: '9007199254740995', data: { x: [1] } })
    r = await json(await call('DELETE', `/rows/${S}/items`, { body: { pk: { id: 10 } } }))
    expect(r.status).toBe(200)
    expect((await pool.query(`select 1 from ${S}.items where id = 10`)).rowCount).toBe(0)
    expect((await call('DELETE', `/rows/${S}/items`, { body: { pk: { id: 10 } } })).status).toBe(404)
    const audit = await pool.query(`select action from selfbase.admin_audit where target = $1 order by id desc limit 3`, [`${S}.items`])
    expect(audit.rows.map((a) => a.action)).toEqual(['rows.delete', 'rows.update', 'rows.insert'])
  })

  it('round-trips jsonb values exactly, strings included', async () => {
    const cases: unknown[] = ['123', 'true', 'hello', 123, true, { a: [1, 'x'] }, [1, 2], null]
    for (const [i, v] of cases.entries()) {
      const r = await json(await call('POST', `/rows/${S}/docs`, { body: { values: { id: i, j: v } } }))
      expect(r, JSON.stringify(v)).toMatchObject({ status: 200, body: { id: i, j: v } })
      const upd = await json(await call('PATCH', `/rows/${S}/docs`, { body: { pk: { id: i }, values: { j: v } } }))
      expect(upd.body.j).toEqual(v)
      expect((await pool.query(`select j from ${S}.docs where id = $1`, [i])).rows[0].j).toEqual(v)
    }
  })

  it('returns NaN and infinities as strings', async () => {
    const { body } = await json(await call('GET', `/rows/${S}/floats?order=id.asc`))
    expect(body.rows).toEqual([{ id: 1, f: 'NaN', r: 'Infinity' }, { id: 2, f: '-Infinity', r: 1.5 }])
  })

  it('answers database errors as 400 with the message', async () => {
    const r = await json(await call('POST', `/rows/${S}/items`, { body: { values: { id: 'abc', label: 'x' } } }))
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/invalid input syntax/)
  })

  it('refuses PATCH and DELETE on a table without a primary key, and partial pk', async () => {
    expect((await call('PATCH', `/rows/${S}/nopk`, { body: { pk: { v: 'x' }, values: { v: 'y' } } })).status).toBe(400)
    expect((await call('DELETE', `/rows/${S}/nopk`, { body: { pk: { v: 'x' } } })).status).toBe(400)
    expect((await call('DELETE', `/rows/${S}/items`, { body: { pk: { label: 'one' } } })).status).toBe(400)
  })

  it('rejects unknown and injected identifiers before any SQL runs', async () => {
    const evilTable = encodeURIComponent(`users"; drop table ${S}.victim; --`)
    expect((await call('GET', `/rows/${S}/${evilTable}`)).status).toBe(404)
    expect((await call('POST', `/rows/${S}/${evilTable}`, { body: { values: {} } })).status).toBe(404)
    expect((await call('GET', `/rows/${encodeURIComponent(`${S}"; drop table ${S}.victim; --`)}/items`)).status).toBe(404)
    expect((await call('GET', `/rows/${S}/items?order=${encodeURIComponent(`id;drop table ${S}.victim`)}`)).status).toBe(400)
    expect((await call('GET', `/rows/${S}/items?filter=${encodeURIComponent(`id;drop table ${S}.victim.eq.1`)}`)).status).toBe(400)
    expect((await call('GET', `/rows/${S}/items?filter=id.exec.1`)).status).toBe(400)
    expect((await call('POST', `/rows/${S}/items`, { body: { values: { [`id"); drop table ${S}.victim; --`]: 1 } } })).status).toBe(400)
    expect((await pool.query(`select to_regclass('${S}.victim') is not null as ok`)).rows[0].ok).toBe(true)
  })
})

describe('policies', () => {
  const anonCount = () => asUser(null, async (c) => (await c.query(`select count(*)::int as n from ${S}.items`)).rows[0].n)

  it('creates a policy that changes RLS behaviour, lists and drops it', async () => {
    expect(await anonCount()).toBe(0)
    const create = await call('POST', '/policies', {
      body: { schema: S, table: 'items', name: 'anon reads one', command: 'SELECT', roles: ['anon'], using: 'id = 1' },
    })
    expect(create.status).toBe(200)
    expect((await pool.query(`select 1 from pg_policies where schemaname = $1 and policyname = 'anon reads one'`, [S])).rowCount).toBe(1)
    expect(await anonCount()).toBe(1)
    const { body } = await json(await call('GET', `/policies?schema=${S}&table=items`))
    expect(body).toEqual([{ name: 'anon reads one', schema: S, table: 'items', command: 'SELECT', roles: ['anon'], using: '(id = 1)', check: null, permissive: true }])
    expect((await call('DELETE', '/policies', { body: { schema: S, table: 'items', name: 'anon reads one' } })).status).toBe(200)
    expect(await anonCount()).toBe(0)
    expect((await call('DELETE', '/policies', { body: { schema: S, table: 'items', name: 'anon reads one' } })).status).toBe(404)
  })

  it('policy expression text cannot leave session state in the pool', async () => {
    const res = await call('POST', '/policies', {
      body: { schema: S, table: 'items', name: 'leaky', command: 'SELECT', roles: ['anon'], using: 'false); set statement_timeout = 7; select (1' },
    })
    expect(res.status).toBe(200)
    for (let i = 0; i < 12; i++) expect((await pool.query('show statement_timeout')).rows[0].statement_timeout).toBe('0')
    await pool.query(`drop policy leaky on ${S}.items`)
  })

  it('validates command and roles', async () => {
    const p = { schema: S, table: 'items', name: 'p', using: 'true' }
    expect((await call('POST', '/policies', { body: { ...p, command: 'SELECT; drop table x', roles: ['anon'] } })).status).toBe(400)
    expect((await call('POST', '/policies', { body: { ...p, command: 'SELECT', roles: ['no_such_role'] } })).status).toBe(400)
  })

  it('toggles RLS', async () => {
    expect((await call('POST', '/rls', { body: { schema: S, table: 'items', enabled: false } })).status).toBe(200)
    expect(await anonCount()).toBe(2)
    expect((await call('POST', '/rls', { body: { schema: S, table: 'items', enabled: true } })).status).toBe(200)
    expect(await anonCount()).toBe(0)
  })
})

describe('sql runner', () => {
  const sql = async (query: string) => json(await call('POST', '/sql', { body: { query } }))

  it('returns columns and rows', async () => {
    const { status, body } = await sql('select 1 as a')
    expect(status).toBe(200)
    expect(body).toMatchObject({ columns: ['a'], rows: [[1]], rowCount: 1 })
    expect(typeof body.durationMs).toBe('number')
  })

  it('returns errors as data with HTTP 200', async () => {
    const { status, body } = await sql('selec 1')
    expect(status).toBe(200)
    expect(body.error.message).toMatch(/syntax error/)
    expect(body.error.position).toBe(1)
  })

  it('returns the last statement of a script and caps rows at 1000', async () => {
    const { body } = await sql('select 1; select g from generate_series(1, 1500) g')
    expect(body.columns).toEqual(['g'])
    expect(body.rows).toHaveLength(1000)
    expect(body.truncated).toBe(true)
  })

  it('applies a 30 s statement_timeout that does not leak into the pool', async () => {
    expect((await sql('show statement_timeout')).body.rows).toEqual([['30s']])
    await sql('set statement_timeout = 1')
    for (let i = 0; i < 12; i++) expect((await pool.query('show statement_timeout')).rows[0].statement_timeout).toBe('0')
  })

  it('keeps the timeout after a commit inside the script', async () => {
    sqlLimits.statementTimeout = '200ms'
    try {
      const { body } = await sql('commit; select pg_sleep(2)')
      expect(body.error.message).toMatch(/statement timeout/)
    } finally {
      sqlLimits.statementTimeout = '30s'
    }
  })

  it('audits every execution', async () => {
    const marker = `select '${randomUUID()}'`
    await sql(marker)
    const { rows } = await pool.query(`select action, detail from selfbase.admin_audit where detail->>'query' = $1`, [marker])
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('sql')
  })
})

describe('users', () => {
  const PW = 'user-password-1'
  async function newUser() {
    const email = `t6-${randomUUID()}@example.test`
    const saved = config.authConfirmEmail
    config.authConfirmEmail = false
    try {
      const res = await app.request('/auth/v1/signup', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }),
      })
      const s = await res.json()
      return { email, id: s.user.id as string, refresh: s.refresh_token as string }
    } finally {
      config.authConfirmEmail = saved
    }
  }
  const signIn = (email: string, password = PW) =>
    app.request('/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    })

  it('lists and searches users', async () => {
    const u = await newUser()
    const { body } = await json(await call('GET', `/users?search=${encodeURIComponent(u.email)}&limit=10`))
    expect(body.total).toBe(1)
    expect(body.users[0]).toMatchObject({ id: u.id, email: u.email, banned_until: null })
  })

  it('banning blocks sign-in and revokes sessions; unban restores', async () => {
    const u = await newUser()
    const r = await call('PATCH', `/users/${u.id}`, { body: { banned_until: '2999-01-01T00:00:00Z' } })
    expect(r.status).toBe(200)
    const login = await json(await signIn(u.email))
    expect(login).toMatchObject({ status: 400, body: { error_code: 'user_banned' } })
    const refresh = await app.request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: u.refresh }),
    })
    expect(refresh.status).toBe(400)
    expect((await call('PATCH', `/users/${u.id}`, { body: { banned_until: null } })).status).toBe(200)
    expect((await signIn(u.email)).status).toBe(200)
  })

  it('sets password with the auth length rule and confirms email', async () => {
    const u = await newUser()
    expect((await call('PATCH', `/users/${u.id}`, { body: { password: '123' } })).status).toBe(422)
    expect((await call('PATCH', `/users/${u.id}`, { body: { password: 'new-password-2', email_confirmed: true } })).status).toBe(200)
    expect((await signIn(u.email, 'new-password-2')).status).toBe(200)
    expect((await call('PATCH', `/users/${u.id}`, { body: { banned_until: 'not a date' } })).status).toBe(400)
  })

  it('deletes a user and their sessions', async () => {
    const u = await newUser()
    expect((await call('DELETE', `/users/${u.id}`)).status).toBe(200)
    expect((await pool.query('select 1 from auth.users where id = $1', [u.id])).rowCount).toBe(0)
    expect((await pool.query('select 1 from auth.refresh_tokens where user_id = $1', [u.id])).rowCount).toBe(0)
    expect((await call('DELETE', `/users/${u.id}`)).status).toBe(404)
  })
})

describe('files', () => {
  const B = `t6-${randomUUID().slice(0, 8)}`
  afterAll(async () => {
    await pool.query('delete from storage.objects where bucket_id = $1', [B])
    await pool.query('delete from storage.buckets where id = $1', [B])
  })

  it('creates buckets, uploads, lists, downloads and deletes files', async () => {
    expect((await call('POST', '/buckets', { body: { id: B, public: false } })).status).toBe(200)
    expect((await call('POST', '/buckets', { body: { id: B, public: false } })).status).toBe(409)
    expect((await json(await call('GET', '/buckets'))).body.some((b: any) => b.id === B)).toBe(true)
    const up = await call('POST', `/files/${B}/dir/a.txt`, { raw: 'hello', headers: { 'content-type': 'text/plain' } })
    expect(up.status).toBe(200)
    const list = await json(await call('GET', `/files/${B}?prefix=dir`))
    expect(list.body.map((o: any) => o.name)).toEqual(['a.txt'])
    const dl = await call('GET', `/files/${B}/dir/a.txt`)
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('hello')
    expect((await call('DELETE', `/files/${B}/dir/a.txt`)).status).toBe(200)
    expect((await call('GET', `/files/${B}/dir/a.txt`)).status).toBe(404)
    expect((await call('DELETE', `/files/${B}/dir/a.txt`)).status).toBe(404)
  })

  it('rejects path escapes', async () => {
    expect((await call('POST', `/files/${B}/..%2F..%2Fescape.txt`, { raw: 'x' })).status).toBe(400)
    expect((await call('POST', '/buckets', { body: { id: '../x', public: false } })).status).toBe(400)
  })
})
