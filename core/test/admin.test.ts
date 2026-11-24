import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// config reads env at import, so set storage dir before loading app
const base = mkdtempSync(join(tmpdir(), 'sb-admin-'))
process.env.STORAGE_DIR = join(base, 'storage')

const { app, adminApp } = await import('../src/app.ts')
const { pool, asUser } = await import('../src/db.ts')
const { config } = await import('../src/config.ts')
const { sign } = await import('../src/jwt.ts')
const { sqlLimits } = await import('../src/admin/sql.ts')
const { TOKEN_TYPES, sha256 } = await import('../src/auth/mail.ts')

const S = 't6' // test schema
const serviceKey = process.env.SERVICE_ROLE_KEY!
const token = process.env.ADMIN_TOKEN!

type Init = { body?: unknown; headers?: Record<string, string>; raw?: BodyInit }
const call = (method: string, path: string, init: Init = {}) =>
  adminApp.request(`http://localhost/admin${path}`, {
    method,
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  })
const json = async (res: Response) => ({ status: res.status, body: await res.json() })

beforeAll(async () => {
  await pool.query(`drop schema if exists ${S} cascade; create schema ${S};
    grant usage on schema ${S} to anon;
    create table ${S}.items (id int primary key, label text not null, big bigint, at timestamptz, data jsonb);
    create table ${S}.victim (id int);
    create table ${S}.nopk (v text);
    create view ${S}.items_v as select id, label from ${S}.items;
    create table ${S}.docs (id int primary key, j jsonb);
    create table ${S}.floats (id int primary key, f float8, r real);
    insert into ${S}.floats values (1, 'NaN', 'Infinity'), (2, '-Infinity', 1.5);
    grant select on ${S}.items to anon;
    alter table ${S}.items enable row level security;
    insert into ${S}.items values (1, 'one', 9007199254740993, '2026-01-02 03:04:05.123456+00', '{"a":1}'), (2, 'two', null, null, null);
    insert into ${S}.nopk values ('x');`)
})

afterAll(async () => {
  await pool.query(`drop schema if exists ${S} cascade`)
  rmSync(base, { recursive: true, force: true })
})

describe('admin token', () => {
  const routes: [string, string][] = [
    ['GET', '/ready'], ['GET', '/schemas'], ['GET', '/tables?schema=public'],
    ['GET', `/rows/${S}/items`], ['POST', `/rows/${S}/items`], ['PATCH', `/rows/${S}/items`], ['DELETE', `/rows/${S}/items`],
    ['GET', '/policies'], ['POST', '/policies'], ['DELETE', '/policies'], ['POST', '/rls'], ['POST', '/sql'],
    ['GET', '/users'], ['PATCH', `/users/${randomUUID()}`], ['DELETE', `/users/${randomUUID()}`],
    ['GET', '/buckets'], ['POST', '/buckets'], ['GET', '/files/b'], ['GET', '/files/b/x.txt'],
    ['POST', '/files/b/x.txt'], ['DELETE', '/files/b/x.txt'], ['GET', '/nope'],
  ]

  it('answers 401 on every route without the token', async () => {
    for (const [m, p] of routes) {
      const res = await adminApp.request(`/admin${p}`, { method: m })
      expect(res.status, `${m} ${p}`).toBe(401)
      expect(await res.json()).toEqual({ error: 'admin token required' })
    }
  })

  it('does not accept the service_role key or a user JWT instead of the token', async () => {
    const user = await sign({ sub: randomUUID(), role: 'authenticated' }, 60)
    for (const t of [serviceKey, user]) {
      for (const [m, p] of routes) {
        const res = await adminApp.request(`/admin${p}`, { method: m, headers: { authorization: `Bearer ${t}`, apikey: t } })
        expect(res.status, `${m} ${p}`).toBe(401)
      }
    }
  })

  it('refuses every request while ADMIN_TOKEN is shorter than 32 characters', async () => {
    const saved = config.adminToken
    config.adminToken = 'short'
    try {
      expect((await adminApp.request('/admin/ready', { headers: { authorization: 'Bearer short' } })).status).toBe(401)
    } finally {
      config.adminToken = saved
    }
  })

  it('GET /ready answers ok with the token', async () => {
    expect(await json(await call('GET', '/ready'))).toEqual({ status: 200, body: { ok: true } })
  })

  it('stores the actor header on audit rows, control by default; an over-long actor is refused', async () => {
    const marker = `select '${randomUUID()}'`
    expect((await call('POST', '/sql', { body: { query: marker }, headers: { 'x-selfbase-actor': 'ops@example.test' } })).status).toBe(200)
    const other = `select '${randomUUID()}'`
    expect((await call('POST', '/sql', { body: { query: other } })).status).toBe(200)
    const { rows } = await pool.query(`select detail->>'query' as q, actor from selfbase.admin_audit where detail->>'query' = any($1)`, [[marker, other]])
    expect(Object.fromEntries(rows.map((r) => [r.q, r.actor]))).toEqual({ [marker]: 'ops@example.test', [other]: 'control' })
    const long = await call('POST', '/sql', { body: { query: 'select 1' }, headers: { 'x-selfbase-actor': 'a'.repeat(321) } })
    expect(long.status).toBe(400)
  })

  it('the public app has no admin routes', async () => {
    expect((await app.request('/admin/schemas', { headers: { authorization: `Bearer ${token}` } })).status).toBe(404)
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
    expect(items).toMatchObject({ schema: S, rls_enabled: true, relkind: 'r' })
    expect(body.find((t: any) => t.name === 'items_v')).toMatchObject({ relkind: 'v', rls_enabled: false })
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
      return { email, id: s.user.id as string, refresh: s.refresh_token as string, access: s.access_token as string }
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
    // identities come along, so the panel's provider column is right for non-email users
    expect(body.users[0].identities.map((i: { provider: string }) => i.provider)).toEqual(['email'])
    await pool.query(`insert into auth.identities (provider_id, user_id, identity_data, provider) values ($1, $2, '{}', 'google')`,
      [randomUUID(), u.id])
    const again = await json(await call('GET', `/users?search=${encodeURIComponent(u.email)}&limit=10`))
    expect(again.body.users[0].identities.map((i: { provider: string }) => i.provider).sort()).toEqual(['email', 'google'])
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

  it('a password reset ends every session of the user and clears the one-time tokens', async () => {
    const u = await newUser()
    const other = await (await signIn(u.email)).json()
    await pool.query(`insert into auth.one_time_tokens (user_id, token_type, token_hash, relates_to)
      values ($1, 'recovery_token', 'stolen-link-hash', $2)`, [u.id, u.email])
    expect((await call('PATCH', `/users/${u.id}`, { body: { password: 'new-password-2' } })).status).toBe(200)
    for (const refresh_token of [u.refresh, other.refresh_token]) {
      const r = await app.request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token }),
      })
      expect(r.status).toBe(400)
    }
    expect((await pool.query('select 1 from auth.refresh_tokens where user_id = $1 and not revoked', [u.id])).rowCount).toBe(0)
    expect((await pool.query('select 1 from auth.one_time_tokens where user_id = $1', [u.id])).rowCount).toBe(0)
    expect((await signIn(u.email, 'new-password-2')).status).toBe(200)
  })

  // B, fix round 1: a reset must win over a sign-in or a password change already in flight
  const live = async (userId: string) =>
    (await pool.query('select session_id from auth.refresh_tokens where user_id = $1 and not revoked', [userId])).rows.map((r) => r.session_id)
  const refreshOf = (refresh_token: string) => app.request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token }),
  })
  // holds the next bcrypt call of `fn` after it returned, until `release`
  function holdNext(fn: 'compare' | 'hash') {
    const real = bcrypt[fn] as (...a: unknown[]) => Promise<unknown>
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const inside = new Promise<void>((r) => { entered = r })
    const spy = vi.spyOn(bcrypt, fn).mockImplementationOnce((async (...a: unknown[]) => {
      const out = await real(...a)
      entered()
      await gate
      return out
    }) as never)
    return { inside, release, restore: () => spy.mockRestore() }
  }

  it('B: a sign-in that checked the old password before an admin reset gets no session', async () => {
    const u = await newUser()
    const hold = holdNext('compare')
    try {
      const signing = signIn(u.email)
      await hold.inside
      expect((await call('PATCH', `/users/${u.id}`, { body: { password: 'new-password-3' } })).status).toBe(200)
      hold.release()
      expect((await signing).status).toBe(400)
      expect(await live(u.id)).toEqual([])
    } finally {
      hold.restore()
    }
  })

  // (an admin reset waits on the user row the insert's foreign key locks; PUT /user's update does not)
  it('B: a session the sign-in is inserting while the owner changes the password is revoked by it', async () => {
    const u = await newUser()
    const owner = (await pool.query('select session_id from auth.refresh_tokens where token = $1', [u.refresh])).rows[0].session_id
    await pool.query(`create table if not exists public.b_hold (user_id uuid primary key)`)
    await pool.query(`create or replace function public.b_hold() returns trigger language plpgsql as $$
      begin if exists (select 1 from public.b_hold where user_id = new.user_id) then perform pg_sleep(1.5); end if; return new; end $$`)
    await pool.query(`create or replace trigger b_hold after insert on auth.refresh_tokens for each row
      when (new.parent is null) execute function public.b_hold()`)
    try {
      await pool.query('insert into public.b_hold values ($1)', [u.id])
      const signing = signIn(u.email)
      for (let i = 0; !(await pool.query(`select 1 from pg_stat_activity where wait_event = 'PgSleep'
        and query like '%insert into auth.refresh_tokens%'`)).rowCount; i++) {
        if (i > 100) throw new Error('the sign-in never reached the trigger')
        await new Promise((r) => setTimeout(r, 20))
      }
      const reset = app.request('/auth/v1/user', { method: 'PUT',
        headers: { authorization: `Bearer ${u.access}`, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'new-password-4' }) })
      const [s, r] = await Promise.all([signing, reset])
      expect(r.status).toBe(200)
      if (s.status === 200) expect((await refreshOf((await s.json()).refresh_token)).status).toBe(400)
      expect(await live(u.id)).toEqual([owner])
    } finally {
      await pool.query('drop trigger if exists b_hold on auth.refresh_tokens')
      await pool.query('drop function if exists public.b_hold()')
      await pool.query('drop table if exists public.b_hold')
    }
  })

  it('B: a password change from a session revoked while it was hashing writes nothing', async () => {
    const u = await newUser()
    const attacker = await (await signIn(u.email)).json()
    const hold = holdNext('hash')
    try {
      const changing = app.request('/auth/v1/user', { method: 'PUT',
        headers: { authorization: `Bearer ${attacker.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'attacker-password-1' }) })
      await hold.inside
      expect((await call('PATCH', `/users/${u.id}`, { body: { password: 'owner-password-1' } })).status).toBe(200)
      hold.release()
      expect((await changing).status).toBe(403)
      expect((await signIn(u.email, 'owner-password-1')).status).toBe(200)
      expect((await signIn(u.email, 'attacker-password-1')).status).toBe(400)
    } finally {
      hold.restore()
    }
  })

  it('B: a recovery link spent while an admin reset runs gets no session', async () => {
    const u = await newUser()
    const link = randomUUID()
    await pool.query(`insert into auth.one_time_tokens (user_id, token_type, token_hash, relates_to) values ($1, $2, $3, $4)`,
      [u.id, TOKEN_TYPES.recovery, sha256(link), u.email])
    // the link's delete sleeps before it commits, so the reset lands between the spend and the session
    await pool.query(`create table if not exists public.b_hold (user_id uuid primary key)`)
    await pool.query(`create or replace function public.b_ott() returns trigger language plpgsql as $$
      begin if exists (select 1 from public.b_hold where user_id = old.user_id) then perform pg_sleep(1.5); end if; return old; end $$`)
    await pool.query(`create or replace trigger b_ott after delete on auth.one_time_tokens for each row execute function public.b_ott()`)
    try {
      await pool.query('insert into public.b_hold values ($1)', [u.id])
      const verifying = app.request(`/auth/v1/verify?token=${link}&type=recovery`)
      for (let i = 0; !(await pool.query(`select 1 from pg_stat_activity where wait_event = 'PgSleep'
        and query like '%delete from auth.one_time_tokens%'`)).rowCount; i++) {
        if (i > 100) throw new Error('the verify never reached the trigger')
        await new Promise((r) => setTimeout(r, 20))
      }
      const reset = call('PATCH', `/users/${u.id}`, { body: { password: 'new-password-6' } })
      const [v, r] = await Promise.all([verifying, reset])
      expect(r.status).toBe(200)
      expect(v.headers.get('location')).toContain('error_code=otp_expired')
      expect(await live(u.id)).toEqual([])
    } finally {
      await pool.query('drop trigger if exists b_ott on auth.one_time_tokens')
      await pool.query('drop function if exists public.b_ott()')
      await pool.query('drop table if exists public.b_hold')
    }
  })

  it('B: an admin reset during a refresh waits for it instead of deadlocking, and revokes the new token', async () => {
    const u = await newUser()
    const session = (await pool.query('select session_id from auth.refresh_tokens where token = $1', [u.refresh])).rows[0].session_id
    // the rotation holds the S4 lock and sleeps before it inserts the child (which takes FOR KEY SHARE on the user row)
    await pool.query(`create table if not exists public.b_hold (session_id uuid primary key)`)
    await pool.query(`create or replace function public.b_rot() returns trigger language plpgsql as $$
      begin if new.revoked and not old.revoked and exists (select 1 from public.b_hold where session_id = new.session_id)
        then perform pg_sleep(1.5); end if; return new; end $$`)
    await pool.query(`create or replace trigger b_rot before update on auth.refresh_tokens for each row execute function public.b_rot()`)
    try {
      await pool.query('insert into public.b_hold values ($1)', [session])
      const rotating = refreshOf(u.refresh)
      for (let i = 0; !(await pool.query(`select 1 from pg_stat_activity where wait_event = 'PgSleep'
        and query like '%update auth.refresh_tokens%'`)).rowCount; i++) {
        if (i > 100) throw new Error('the rotation never reached the trigger')
        await new Promise((r) => setTimeout(r, 20))
      }
      // the rotation's own revoke trigger must not hold the reset's revoke too
      await pool.query('delete from public.b_hold')
      const [r, reset] = await Promise.all([rotating, call('PATCH', `/users/${u.id}`, { body: { password: 'new-password-5' } })])
      expect([r.status, reset.status]).toEqual([200, 200])
      expect((await refreshOf((await r.json()).refresh_token)).status).toBe(400)
      expect(await live(u.id)).toEqual([])
    } finally {
      await pool.query('drop trigger if exists b_rot on auth.refresh_tokens')
      await pool.query('drop function if exists public.b_rot()')
      await pool.query('drop table if exists public.b_hold')
    }
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
