import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { app } from '../src/app.ts'
import { pool } from '../src/db.ts'
import { coreAuth, resetRateLimits, verify as coreVerify } from '../src/core.ts'
import { config, loadConfig } from '../src/config.ts'
import { hashToken } from '../src/ids.ts'
import { cookieNames } from '../src/session.ts'
import { ORIGIN, as, cookiesOf, login, resetDashboard, withToken } from './helpers.ts'

const OWNER = 'owner@example.test'
const PASSWORD = 'correct-horse-battery'
const controlDir = fileURLToPath(new URL('..', import.meta.url))

const cli = (args: string[], input: string) =>
  spawnSync(process.execPath, ['src/cli.ts', ...args], { cwd: controlDir, input, encoding: 'utf8', env: process.env })

// temporary catch-all routes on the real app (before its first request builds the router): authenticate must not
// depend on the route shape
app.all('/platform/x/*', (c) => c.json({ reached: true }))
app.all('/v1/x/*', (c) => c.json({ reached: true }))

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) })

beforeAll(async () => {
  await resetDashboard()
})
beforeEach(() => resetRateLimits())

describe('create-owner and login', () => {
  test('create-owner reads the password from stdin and prints only the email', () => {
    const short = cli(['create-owner', OWNER], 'too-short\n')
    expect(short.status).not.toBe(0)
    const r = cli(['create-owner', OWNER], `${PASSWORD}\n`)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(OWNER)
  })

  test('a second create-owner is refused', async () => {
    const r = cli(['create-owner', 'other@example.test'], `${PASSWORD}\n`)
    expect(r.status).not.toBe(0)
    expect(r.stdout).not.toContain(PASSWORD)
    expect((await pool.query(`select count(*)::int as n from auth.users`)).rows[0].n).toBe(1)
    const org = await pool.query(`select o.slug, m.role from control.organizations o join control.memberships m on m.org_id = o.id`)
    expect(org.rows).toEqual([{ slug: 'default', role: 'owner' }])
  })

  test('login sets both cookies and the body carries no token', async () => {
    const res = await app.request('/platform/login', json({ email: OWNER, password: PASSWORD }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ email: OWNER })
    expect(text).not.toMatch(/token|eyJ/)
    const set = res.headers.getSetCookie()
    const access = set.find((c) => c.startsWith('__Host-sb_studio='))!
    const refresh = set.find((c) => c.startsWith('__Host-sb_studio_refresh='))!
    for (const c of [access, refresh]) {
      expect(c).toMatch(/HttpOnly/i)
      expect(c).toMatch(/SameSite=Strict/i)
      expect(c).toMatch(/Secure/i) // PUBLIC_URL is https in the tests
      // __Host-: a sibling host under a shared parent domain cannot set or shadow them
      expect(c).toMatch(/; Path=\/(;|$)/)
      expect(c).not.toMatch(/Domain=/i)
    }
    expect(access).toMatch(/Max-Age=3600/)
    // plain HTTP (local dev) cannot carry __Host- cookies: the bare names
    expect(cookieNames(false)).toEqual({ access: 'sb_studio', refresh: 'sb_studio_refresh' })
  })

  test('wrong password is 400 {error,message}; the sixth attempt in the window is 429', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/platform/login', json({ email: OWNER, password: 'wrong-password-123' }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_credentials', message: 'Invalid login credentials' })
    }
    const sixth = await app.request('/platform/login', json({ email: OWNER, password: PASSWORD }))
    expect(sixth.status).toBe(429)
    expect(await sixth.json()).toMatchObject({ error: 'over_request_rate_limit' })
  })

  test('refresh rotates the session from the refresh cookie; logout ends it', async () => {
    const cookie = await login(OWNER, PASSWORD)
    const refreshCookie = cookie.split('; ').find((c) => c.startsWith('__Host-sb_studio_refresh='))!
    const r = await app.request('/platform/refresh', { method: 'POST', headers: { cookie: refreshCookie, origin: ORIGIN } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ email: OWNER })
    const fresh = cookiesOf(r)
    expect(fresh).toMatch(/__Host-sb_studio=/)
    expect((await as(fresh, 'GET', '/platform/me')).status).toBe(200)
    const out = await as(fresh, 'POST', '/platform/logout')
    expect(out.status).toBe(200)
    expect(out.headers.getSetCookie().join()).toMatch(/__Host-sb_studio=;/)
    // the access token is still signed, but its session is gone
    expect((await as(fresh, 'GET', '/platform/me')).status).toBe(401)
  })
})

describe('fail closed', () => {
  test('login needs Studio’s origin', async () => {
    for (const origin of [undefined, 'https://evil.example']) {
      const res = await app.request('/platform/login', {
        method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ email: OWNER, password: PASSWORD }),
      })
      expect(res.status).toBe(403)
      expect(res.headers.getSetCookie()).toEqual([])
    }
  })

  test('ALL and wildcard routes need a caller too; an unknown path is 404 only after sign-in', async () => {
    for (const path of ['/platform/x/a', '/v1/x/a/b']) {
      const res = await app.request(path, { method: 'POST' })
      expect(res.status, path).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Unauthorized' })
    }
    const cookie = await login(OWNER, PASSWORD)
    expect(await (await as(cookie, 'POST', '/platform/x/a')).json()).toEqual({ reached: true })
    const unknown = await as(cookie, 'GET', '/platform/nope')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: 'not_found', message: expect.any(String) })
  })

  test('a JSON body over 256 KiB is refused before it is parsed', async () => {
    const cookie = await login(OWNER, PASSWORD)
    const res = await as(cookie, 'POST', '/platform/access-tokens', { name: 'big', pad: 'x'.repeat(300 * 1024) })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large', message: expect.any(String) })
    expect((await pool.query(`select 1 from control.access_tokens where name = 'big'`)).rowCount).toBe(0)
  })
})

describe('signup and other sign-in routes are not reachable', () => {
  test('POST signup under any mounted path creates no user', async () => {
    for (const path of ['/auth/v1/signup', '/platform/auth/v1/signup', '/v1/auth/v1/signup', '/platform/auth/v1/otp']) {
      const res = await app.request(path, json({ email: 'intruder@example.test', password: PASSWORD }))
      // /v1 has no public paths: no caller is a 401 there, before any route lookup
      expect(res.status, path).toBe(path.startsWith('/v1') ? 401 : 404)
    }
    expect((await app.request('/platform/auth/v1/authorize?provider=google')).status).toBe(404)
    expect((await app.request('/platform/auth/v1/token?grant_type=password', json({ email: OWNER, password: PASSWORD }))).status).toBe(404)
    expect((await pool.query(`select 1 from auth.users where email = 'intruder@example.test'`)).rowCount).toBe(0)
  })
})

describe('sessions and tokens', () => {
  test('/platform/me without a cookie is 401 {error, message:"Unauthorized"}', async () => {
    const res = await app.request('/platform/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Unauthorized' })
  })

  test('/platform/me with the cookie', async () => {
    const cookie = await login(OWNER, PASSWORD)
    const res = await as(cookie, 'GET', '/platform/me')
    expect(res.status).toBe(200)
    const me = await res.json()
    expect(me).toEqual({ id: expect.any(String), email: OWNER, organizations: [
      { id: expect.any(String), slug: 'default', name: 'Default', role: 'owner', projects: [] },
    ] })
  })

  test('a cookie POST from another origin is 403', async () => {
    const cookie = await login(OWNER, PASSWORD)
    for (const origin of ['https://evil.example', undefined]) {
      const res = await app.request('/platform/access-tokens', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ name: 'x' }),
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden', message: expect.any(String) })
    }
  })

  test('an access token works on /v1 and /platform, is stored hashed, and dies when deleted', async () => {
    const cookie = await login(OWNER, PASSWORD)
    const created = await as(cookie, 'POST', '/platform/access-tokens', { name: 'ci' })
    expect(created.status).toBe(201)
    const { id, name, token } = await created.json()
    expect(name).toBe('ci')
    expect(token).toMatch(/^sbp_[0-9a-f]{40}$/)

    const row = (await pool.query(`select token_hash from control.access_tokens where id = $1`, [id])).rows[0]
    expect(row.token_hash).toBe(hashToken(token))
    expect(JSON.stringify((await pool.query(`select * from control.access_tokens`)).rows)).not.toContain(token)

    const orgs = await withToken(token, 'GET', '/v1/organizations')
    expect(orgs.status).toBe(200)
    expect(await orgs.json()).toEqual([{ id: 'default', slug: 'default', name: 'Default' }])
    expect((await withToken(token, 'GET', '/platform/me')).status).toBe(200)

    const list = await (await as(cookie, 'GET', '/platform/access-tokens')).json()
    expect(list).toEqual([{ id, name: 'ci', created_at: expect.any(String), last_used_at: expect.any(String), expires_at: null }])
    expect(JSON.stringify(list)).not.toContain(token)

    // a token cannot mint another token
    const minted = await withToken(token, 'POST', '/platform/access-tokens', { name: 'child' })
    expect(minted.status).toBe(403)
    expect(await minted.json()).toEqual({ error: 'forbidden', message: expect.any(String) })
    // the scheme is matched exactly
    const lower = await app.request('/v1/organizations', { headers: { authorization: `bearer ${token}` } })
    expect(lower.status).toBe(401)

    expect((await as(cookie, 'DELETE', `/platform/access-tokens/${id}`)).status).toBe(200)
    expect((await withToken(token, 'GET', '/v1/organizations')).status).toBe(401)
  })

  test('the cookie is not accepted on /v1; a JWT or malformed bearer is not a token', async () => {
    const cookie = await login(OWNER, PASSWORD)
    const res = await app.request('/v1/organizations', { headers: { cookie } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Unauthorized' })
    expect((await withToken('sbp_' + '0'.repeat(40), 'GET', '/v1/organizations')).status).toBe(401)
    const jwt = cookie.match(/__Host-sb_studio=([^;]+)/)![1]
    expect((await withToken(jwt, 'GET', '/v1/organizations')).status).toBe(401)
  })

  test('an expired token is refused; last_used_at moves at most once a minute', async () => {
    const cookie = await login(OWNER, PASSWORD)
    const past = await as(cookie, 'POST', '/platform/access-tokens', { name: 'old', expires_at: '2020-01-01T00:00:00Z' })
    expect(past.status).toBe(400)
    const { id, token } = await (await as(cookie, 'POST', '/platform/access-tokens', { name: 'soon' })).json()
    await withToken(token, 'GET', '/v1/organizations')
    const first = (await pool.query(`select last_used_at from control.access_tokens where id = $1`, [id])).rows[0].last_used_at
    await withToken(token, 'GET', '/v1/organizations')
    const second = (await pool.query(`select last_used_at from control.access_tokens where id = $1`, [id])).rows[0].last_used_at
    expect(second).toEqual(first)
    await pool.query(`update control.access_tokens set expires_at = now() - interval '1 second' where id = $1`, [id])
    expect((await withToken(token, 'GET', '/v1/organizations')).status).toBe(401)
  })
})

describe('S4: logout and session lifetime', () => {
  const part = (cookie: string, name: string) => cookie.split('; ').find((c) => c.startsWith(`${name}=`))!
  const refreshWith = (cookie: string) => app.request('/platform/refresh', { method: 'POST', headers: { cookie, origin: ORIGIN } })
  const sessionOf = async (cookie: string) => (await pool.query('select session_id from auth.refresh_tokens where token = $1',
    [decodeURIComponent(part(cookie, '__Host-sb_studio_refresh').split('=')[1])])).rows[0].session_id as string
  const age = (sessionId: string, sql: string) => pool.query(`update auth.refresh_tokens set created_at = ${sql} where session_id = $1`, [sessionId])

  test('logout with the refresh cookie only (access cookie expired) ends the session', async () => {
    const cookie = await login(OWNER, PASSWORD)
    const out = await app.request('/platform/logout', { method: 'POST', headers: { cookie: part(cookie, '__Host-sb_studio_refresh'), origin: ORIGIN } })
    expect(out.status).toBe(200)
    expect(out.headers.getSetCookie().join()).toMatch(/__Host-sb_studio_refresh=;/)
    expect((await refreshWith(part(cookie, '__Host-sb_studio_refresh'))).status).toBe(401)
    // the access cookie of that session is dead as well
    expect((await as(cookie, 'GET', '/platform/me')).status).toBe(401)
  })

  test("logout answers 502 and keeps the cookies when core's revoke fails", async () => {
    const cookie = await login(OWNER, PASSWORD)
    const spy = vi.spyOn(coreAuth, 'fetch').mockResolvedValue(new Response('{"msg":"boom"}', { status: 500 }))
    try {
      const out = await as(cookie, 'POST', '/platform/logout')
      expect(out.status).toBe(502)
      expect(await out.json()).toMatchObject({ error: 'logout_failed' })
      expect(out.headers.getSetCookie()).toEqual([])
    } finally {
      spy.mockRestore()
    }
    expect((await as(cookie, 'GET', '/platform/me')).status).toBe(200)
  })

  test('the refresh cookie lives as long as the absolute lifetime', async () => {
    const res = await app.request('/platform/login', json({ email: OWNER, password: PASSWORD }))
    expect(res.headers.getSetCookie().find((c) => c.startsWith('__Host-sb_studio_refresh='))).toMatch(/Max-Age=604800/)
  })

  test('a session older than 7 days is refused at refresh and by its access cookie, and revoked', async () => {
    const cookie = await login(OWNER, PASSWORD)
    const sid = await sessionOf(cookie)
    // refreshed an hour ago (not idle), started 8 days ago
    const r = await refreshWith(part(cookie, '__Host-sb_studio_refresh'))
    expect(r.status).toBe(200)
    const fresh = cookiesOf(r)
    await pool.query(`update auth.refresh_tokens set created_at = now() - interval '8 days' where session_id = $1 and revoked`, [sid])
    await pool.query(`update auth.refresh_tokens set created_at = now() - interval '1 hour' where session_id = $1 and not revoked`, [sid])
    expect((await as(fresh, 'GET', '/platform/me')).status).toBe(401)
    expect((await refreshWith(part(fresh, '__Host-sb_studio_refresh'))).status).toBe(401)
    expect((await pool.query('select count(*)::int as n from auth.refresh_tokens where session_id = $1 and not revoked', [sid])).rows[0].n).toBe(0)
  })

  test('a session not refreshed for 24 hours is refused; one refreshed in time lives on', async () => {
    const idle = await login(OWNER, PASSWORD)
    await age(await sessionOf(idle), `now() - interval '25 hours'`)
    expect((await refreshWith(part(idle, '__Host-sb_studio_refresh'))).status).toBe(401)
    const active = await login(OWNER, PASSWORD)
    await age(await sessionOf(active), `now() - interval '23 hours'`)
    expect((await refreshWith(part(active, '__Host-sb_studio_refresh'))).status).toBe(200)
  })

  test('both lifetimes are settings', async () => {
    const env = { ...process.env }
    expect(loadConfig(env)).toMatchObject({ sessionMaxAgeDays: 7, sessionIdleHours: 24 })
    expect(loadConfig({ ...env, STUDIO_SESSION_MAX_AGE_DAYS: '1', STUDIO_SESSION_IDLE_HOURS: '2' })).toMatchObject({ sessionMaxAgeDays: 1, sessionIdleHours: 2 })
    const before = config.sessionIdleHours
    config.sessionIdleHours = 1
    try {
      const cookie = await login(OWNER, PASSWORD)
      await age(await sessionOf(cookie), `now() - interval '2 hours'`)
      expect((await refreshWith(part(cookie, '__Host-sb_studio_refresh'))).status).toBe(401)
    } finally {
      config.sessionIdleHours = before
    }
  })
})

describe('v1 organizations', () => {
  test('get and members match the Management API fields', async () => {
    const cookie = await login(OWNER, PASSWORD)
    const { token } = await (await as(cookie, 'POST', '/platform/access-tokens', { name: 'v1' })).json()
    const org = await withToken(token, 'GET', '/v1/organizations/default')
    expect(org.status).toBe(200)
    expect(await org.json()).toEqual({ id: 'default', name: 'Default', plan: 'free', opt_in_tags: [], allowed_release_channels: ['ga'] })
    const members = await withToken(token, 'GET', '/v1/organizations/default/members')
    expect(await members.json()).toEqual([
      { user_id: expect.any(String), user_name: OWNER, email: OWNER, role_name: 'Owner', mfa_enabled: false, avatar_url: null },
    ])
    expect((await withToken(token, 'GET', '/v1/organizations/nope')).status).toBe(404)
  })
})

describe('invitations', () => {
  const invite = async (cookie: string, email: string) => {
    const res = await as(cookie, 'POST', '/platform/organizations/default/invitations', { email, role: 'developer' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toEqual({ id: expect.any(String), expires_at: expect.any(String), link: expect.stringMatching(/\/invite\/[A-Za-z0-9_-]{43}$/) })
    expect(new Date(body.expires_at).getTime() - Date.now()).toBeGreaterThan(6.9 * 86400_000)
    return { ...body, token: body.link.split('/invite/')[1] as string }
  }

  // the address travels in a header (x-selfbase-actor) on every admin call, which takes ASCII only
  test('a non-ASCII address is refused at invite (400 email_not_ascii) and when an account is created', async () => {
    const cookie = await login(OWNER, PASSWORD)
    for (const email of ['şule@example.test', 'dev@örnek.test', 'ığdır@example.test']) {
      const res = await as(cookie, 'POST', '/platform/organizations/default/invitations', { email, role: 'developer' })
      expect(res.status, email).toBe(400)
      expect(await res.json(), email).toEqual({ error: 'email_not_ascii', message: expect.any(String) })
    }
    expect((await pool.query(`select count(*)::int as n from control.invitations where email !~ '^[ -~]*$'`)).rows[0].n).toBe(0)
    const { createConfirmedUser } = await import('../src/routes/platform-auth.ts')
    await expect(createConfirmedUser('şule@example.test', PASSWORD)).rejects.toMatchObject({ status: 400, code: 'email_not_ascii' })
    const r = cli(['create-owner', 'şule@example.test'], `${PASSWORD}
`)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/ASCII/)
    expect((await pool.query(`select count(*)::int as n from auth.users where email !~ '^[ -~]*$'`)).rows[0].n).toBe(0)
  })

  test('accept creates the account and membership; the same token twice fails; the hash is stored', async () => {
    const cookie = await login(OWNER, PASSWORD)
    const inv = await invite(cookie, 'dev@example.test')
    const stored = (await pool.query(`select token_hash from control.invitations where id = $1`, [inv.id])).rows[0]
    expect(stored.token_hash).toBe(hashToken(inv.token))

    const ok = await app.request('/platform/invitations/accept', json({ token: inv.token, password: PASSWORD }))
    expect(ok.status).toBe(200)
    expect(ok.headers.getSetCookie()).toEqual([]) // accepting does not sign in
    const m = await pool.query(`select m.role, m.project_id from control.memberships m join auth.users u on u.id = m.user_id
      where u.email = 'dev@example.test'`)
    expect(m.rows).toEqual([{ role: 'developer', project_id: null }])
    expect((await login('dev@example.test', PASSWORD)).length).toBeGreaterThan(0)

    const again = await app.request('/platform/invitations/accept', json({ token: inv.token, password: PASSWORD }))
    expect(again.status).toBe(400)
    expect(await again.json()).toEqual({ error: 'invalid_invitation', message: expect.any(String) })
  })

  test('an invitation for an existing account needs that account’s session, never a password (takeover)', async () => {
    // org A (default): its owner invites X, X accepts and so has an account
    const ownerA = await login(OWNER, PASSWORD)
    const first = await invite(ownerA, 'x@example.test')
    expect((await app.request('/platform/invitations/accept', json({ token: first.token, password: PASSWORD }))).status).toBe(200)

    // org B: another user owns it and invites X
    await pool.query(`insert into control.organizations (slug, name) values ('orgb', 'Org B')`)
    const b = await app.request('/platform/invitations/accept', json({ token: (await invite(ownerA, 'bowner@example.test')).token, password: PASSWORD }))
    expect(b.status).toBe(200)
    await pool.query(`insert into control.memberships (org_id, user_id, role)
      select o.id, u.id, 'owner' from control.organizations o, auth.users u where o.slug = 'orgb' and u.email = 'bowner@example.test'`)
    const ownerB = await login('bowner@example.test', PASSWORD)
    const res = await as(ownerB, 'POST', '/platform/organizations/orgb/invitations', { email: 'x@example.test', role: 'administrator' })
    expect(res.status).toBe(201)
    const token = (await res.json()).link.split('/invite/')[1]

    // anonymous, with a password of the attacker's choosing: refused, X's password is unchanged
    const anon = await app.request('/platform/invitations/accept', json({ token, password: 'attacker-password-1' }))
    expect(anon.status).toBe(400)
    expect(await anon.json()).toEqual({ error: 'account_exists', message: expect.any(String) })
    expect((await app.request('/platform/invitations/accept', json({ token }))).status).toBe(401)
    // signed in as somebody else
    expect((await as(ownerB, 'POST', '/platform/invitations/accept', { token })).status).toBe(403)
    const inB = () => pool.query(`select m.role from control.memberships m join control.organizations o on o.id = m.org_id
      join auth.users u on u.id = m.user_id where o.slug = 'orgb' and u.email = 'x@example.test'`)
    expect((await inB()).rows).toEqual([])
    resetRateLimits()
    expect((await app.request('/platform/login', json({ email: 'x@example.test', password: 'attacker-password-1' }))).status).toBe(400)

    // signed in as X: accepted
    const x = await login('x@example.test', PASSWORD)
    const ok = await as(x, 'POST', '/platform/invitations/accept', { token })
    expect(ok.status).toBe(200)
    expect((await inB()).rows).toEqual([{ role: 'administrator' }])
  })

  test('an expired invitation fails', async () => {
    const cookie = await login(OWNER, PASSWORD)
    const inv = await invite(cookie, 'late@example.test')
    await pool.query(`update control.invitations set expires_at = now() - interval '1 second' where id = $1`, [inv.id])
    const res = await app.request('/platform/invitations/accept', json({ token: inv.token, password: PASSWORD }))
    expect(res.status).toBe(400)
    expect((await pool.query(`select 1 from auth.users where email = 'late@example.test'`)).rowCount).toBe(0)
  })
})

describe('password reset', () => {
  test('recover mails a /platform/auth/v1/verify link; it lands with the implicit-flow fragment; PUT user sets the password', async () => {
    // a session from before the reset (think: a stolen cookie pair)
    const old = await login(OWNER, PASSWORD)
    const oldRefresh = old.split('; ').find((c) => c.startsWith('__Host-sb_studio_refresh='))!
    const recover = await app.request('/platform/auth/v1/recover', json({ email: OWNER }))
    expect(recover.status).toBe(200)
    // the mail goes out in the background (SMTP_HOST is empty: core writes it to selfbase.mail_log)
    let html = ''
    for (let i = 0; i < 50 && !html; i++) {
      html = (await pool.query(`select html from selfbase.mail_log where to_email = $1 order by id desc limit 1`, [OWNER])).rows[0]?.html ?? ''
      if (!html) await new Promise((r) => setTimeout(r, 50))
    }
    const link = html.match(/href="([^"]+)"/)![1].replaceAll('&amp;', '&')
    const url = new URL(link)
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/platform/auth/v1/verify`)
    expect(url.searchParams.get('redirect_to')).toBe(`${ORIGIN}/reset-password`)

    const verify = await app.request(url.pathname + url.search)
    expect(verify.status).toBe(302)
    const location = verify.headers.get('location')!
    expect(location.startsWith(`${ORIGIN}/reset-password#`)).toBe(true)
    expect(location).not.toContain('?code=')
    const frag = new URLSearchParams(location.split('#')[1])
    expect(frag.get('type')).toBe('recovery')
    const access = frag.get('access_token')!

    const putWith = (body: unknown) => app.request('/platform/auth/v1/user', {
      method: 'PUT',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    // refusals first: they leave the recovery session as it was
    const short = await putWith({ password: 'short' })
    expect(short.status).toBe(422)
    expect(await short.json()).toEqual({ error: 'weak_password', message: expect.any(String) })
    expect((await putWith({ email: 'hijack@example.test' })).status).toBe(400)
    // only the password is passed on to core
    const put = await putWith({ password: 'a-brand-new-password', email: 'hijack@example.test', data: { a: 1 } })
    expect(put.status).toBe(200)
    expect((await pool.query(`select email, raw_user_meta_data from auth.users where email in ($1, 'hijack@example.test')`, [OWNER])).rows)
      .toEqual([{ email: OWNER, raw_user_meta_data: {} }])
    // the reset ended the other sessions: the old access cookie and the old refresh cookie are dead
    expect((await as(old, 'GET', '/platform/me')).status).toBe(401)
    expect((await app.request('/platform/refresh', { method: 'POST', headers: { cookie: oldRefresh, origin: ORIGIN } })).status).toBe(401)
    // C: and the recovery session itself: the link's token sets one password, then the user signs in fresh
    const recoverySession = (await coreVerify(access)).session_id
    expect((await pool.query('select 1 from auth.refresh_tokens where session_id = $1 and not revoked', [recoverySession])).rowCount).toBe(0)
    expect((await putWith({ password: 'a-second-new-password' })).status).toBe(401)
    resetRateLimits()
    const fresh = await login(OWNER, 'a-brand-new-password')
    expect(fresh.length).toBeGreaterThan(0)
    // back to the password the other tests use
    const freshAccess = decodeURIComponent(fresh.split('; ').find((c) => c.startsWith('__Host-sb_studio='))!.split('=')[1])
    expect((await app.request('/platform/auth/v1/user', {
      method: 'PUT',
      headers: { authorization: `Bearer ${freshAccess}`, 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD, current_password: 'a-brand-new-password' }),
    })).status).toBe(200)
  })
})

// A Studio access token alone (a stolen cookie) must not set a new password: it needs a recovery session or the
// current password, and control's own lifetimes apply here as on every other cookie request.
describe('the password route', () => {
  const put = (bearer: string, body: unknown) => app.request('/platform/auth/v1/user', {
    method: 'PUT', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const accessOf = (cookie: string) => decodeURIComponent(cookie.split('; ').find((c) => c.startsWith('__Host-sb_studio='))!.split('=')[1])
  const sessionOfJwt = async (jwt: string) => (await coreVerify(jwt)).session_id as string
  async function recoveryAccess(): Promise<string> {
    await pool.query(`update auth.users set recovery_sent_at = null where email = $1`, [OWNER])
    const before = (await pool.query(`select count(*)::int as n from selfbase.mail_log where to_email = $1`, [OWNER])).rows[0].n
    expect((await app.request('/platform/auth/v1/recover', json({ email: OWNER }))).status).toBe(200)
    let html = ''
    for (let i = 0; i < 50 && !html; i++) {
      html = (await pool.query(`select html from selfbase.mail_log where to_email = $1 order by id offset $2 limit 1`, [OWNER, before])).rows[0]?.html ?? ''
      if (!html) await new Promise((r) => setTimeout(r, 50))
    }
    const url = new URL(html.match(/href="([^"]+)"/)![1].replaceAll('&amp;', '&'))
    const location = (await app.request(url.pathname + url.search)).headers.get('location')!
    return new URLSearchParams(location.split('#')[1]).get('access_token')!
  }

  test('a normal Studio access token without the current password is refused', async () => {
    const jwt = accessOf(await login(OWNER, PASSWORD))
    const res = await put(jwt, { password: 'a-brand-new-password' })
    expect([401, 403]).toContain(res.status)
    resetRateLimits()
    expect((await login(OWNER, PASSWORD)).length).toBeGreaterThan(0)
  })

  test('with the current password it works, and the check leaves no session behind; a wrong one is refused', async () => {
    const jwt = accessOf(await login(OWNER, PASSWORD))
    const wrong = await put(jwt, { password: 'a-brand-new-password', current_password: 'not-the-password' })
    expect(wrong.status).toBe(400)
    const ok = await put(jwt, { password: 'a-brand-new-password', current_password: PASSWORD })
    expect(ok.status).toBe(200)
    const live = await pool.query(`select distinct t.session_id from auth.refresh_tokens t join auth.users u on u.id = t.user_id
      where u.email = $1 and not t.revoked`, [OWNER])
    expect(live.rows.map((r) => r.session_id)).toEqual([await sessionOfJwt(jwt)])
    expect((await put(jwt, { password: PASSWORD, current_password: 'a-brand-new-password' })).status).toBe(200)
  })

  // a stolen cookie can mint a token: the reset that ends the stolen session must end that token too
  test("a password change ends the user's access tokens; a refused change keeps them", async () => {
    const cookie = await login(OWNER, PASSWORD)
    const { token } = await (await as(cookie, 'POST', '/platform/access-tokens', { name: 'minted' })).json()
    expect((await withToken(token, 'GET', '/v1/organizations')).status).toBe(200)
    const jwt = accessOf(cookie)
    expect((await put(jwt, { password: 'a-brand-new-password', current_password: 'not-the-password' })).status).toBe(400)
    expect((await withToken(token, 'GET', '/v1/organizations')).status).toBe(200)
    expect((await put(jwt, { password: 'a-brand-new-password', current_password: PASSWORD })).status).toBe(200)
    expect((await withToken(token, 'GET', '/v1/organizations')).status).toBe(401)
    expect((await put(jwt, { password: PASSWORD, current_password: 'a-brand-new-password' })).status).toBe(200)
  })

  // reviewer's PoC: a mint authorized before the reset, whose body arrives after it, must not leave a working token
  test('a token mint whose body is held back across a password change leaves no working token', async () => {
    const stolen = await login(OWNER, PASSWORD)
    const jwt = accessOf(await login(OWNER, PASSWORD)) // the owner's own session, elsewhere
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const body = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        await gate
        ctl.enqueue(new TextEncoder().encode('{"name":"late"}'))
        ctl.close()
      },
    })
    const mint = app.request('/platform/access-tokens', {
      method: 'POST', body, duplex: 'half', headers: { cookie: stolen, origin: ORIGIN, 'content-type': 'text/plain', 'content-length': '15' },
    } as RequestInit)
    await new Promise((r) => setTimeout(r, 300))
    expect((await put(jwt, { password: 'a-brand-new-password', current_password: PASSWORD })).status).toBe(200)
    expect((await as(stolen, 'GET', '/platform/me')).status).toBe(401)
    release()
    const res = await mint
    const minted = await res.json()
    if (minted.token) expect((await withToken(minted.token, 'GET', '/platform/me')).status).toBe(401)
    expect((await pool.query(`select count(*)::int as n from control.access_tokens a join auth.users u on u.id = a.user_id
      where u.email = $1 and a.name = 'late'`, [OWNER])).rows[0].n).toBe(0)
    expect((await put(jwt, { password: PASSWORD, current_password: 'a-brand-new-password' })).status).toBe(200)
  })

  test('a recovery token works without the current password', async () => {
    expect((await put(await recoveryAccess(), { password: PASSWORD })).status).toBe(200)
  })

  test('C: two PUTs racing with one recovery token: exactly one sets a password, and the session ends with it', async () => {
    const access = await recoveryAccess()
    const sid = await sessionOfJwt(access)
    // the first password write sleeps before it commits, so the second PUT is already queued on the user's lock
    await pool.query(`create table if not exists public.c_hold (user_id uuid primary key)`)
    await pool.query(`create or replace function public.c_hold() returns trigger language plpgsql as $$
      begin delete from public.c_hold where user_id = new.id; if found then perform pg_sleep(1); end if; return new; end $$`)
    await pool.query(`create or replace trigger c_hold after update of encrypted_password on auth.users for each row execute function public.c_hold()`)
    let statuses: number[]
    try {
      await pool.query(`insert into public.c_hold select id from auth.users where email = $1`, [OWNER])
      statuses = (await Promise.all([put(access, { password: PASSWORD }), put(access, { password: 'a-racing-password-1' })]))
        .map((r) => r.status)
    } finally {
      await pool.query('drop trigger if exists c_hold on auth.users')
      await pool.query('drop function if exists public.c_hold()')
      await pool.query('drop table if exists public.c_hold')
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect((await pool.query('select 1 from auth.refresh_tokens where session_id = $1 and not revoked', [sid])).rowCount).toBe(0)
    // back to the password the other tests use, whichever won
    resetRateLimits()
    if (statuses[1] === 200) {
      const jwt = accessOf(await login(OWNER, 'a-racing-password-1'))
      expect((await put(jwt, { password: PASSWORD, current_password: 'a-racing-password-1' })).status).toBe(200)
    }
    resetRateLimits()
    expect((await login(OWNER, PASSWORD)).length).toBeGreaterThan(0)
  })

  test('a token minted before the absolute deadline is refused after it, and so is an idle session', async () => {
    const access = await recoveryAccess()
    const sid = await sessionOfJwt(access)
    await pool.query(`update auth.refresh_tokens set created_at = now() - interval '8 days' where session_id = $1`, [sid])
    expect((await put(access, { password: PASSWORD })).status).toBe(401)
    expect((await pool.query('select 1 from auth.refresh_tokens where session_id = $1 and not revoked', [sid])).rowCount).toBe(0)

    const idle = await recoveryAccess()
    await pool.query(`update auth.refresh_tokens set created_at = now() - interval '25 hours' where session_id = $1`, [await sessionOfJwt(idle)])
    expect((await put(idle, { password: PASSWORD })).status).toBe(401)
  })
})
