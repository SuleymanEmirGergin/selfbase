import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { app } from '../src/app.ts'
import { pool } from '../src/db.ts'
import { config } from '../src/config.ts'
import { verify } from '../src/jwt.ts'

const PW = 'correct-horse-battery'
const anonKey = process.env.ANON_KEY!
const serviceKey = process.env.SERVICE_ROLE_KEY!
const confirmDefault = config.authConfirmEmail
afterEach(() => {
  config.authConfirmEmail = confirmDefault
})

const email = () => `u-${randomUUID()}@example.test`
const call = (method: string, path: string, body?: unknown, token = anonKey) =>
  app.request(`/auth/v1${path}`, {
    method,
    headers: { apikey: anonKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function signUp(e = email(), password = PW) {
  config.authConfirmEmail = false
  const res = await call('POST', '/signup', { email: e, password })
  expect(res.status).toBe(200)
  return res.json()
}
const signIn = (e: string, password = PW) => call('POST', '/token?grant_type=password', { email: e, password })
const refresh = (refresh_token: string) => call('POST', '/token?grant_type=refresh_token', { refresh_token })

describe('auth core', () => {
  it('signup with confirm off returns a session and stores a bcrypt hash', async () => {
    const e = email()
    const s = await signUp(e)
    expect(s).toMatchObject({ token_type: 'bearer', expires_in: 3600, user: { email: e, aud: 'authenticated' } })
    expect(s.refresh_token).toBeTruthy()
    const row = (await pool.query('select encrypted_password from auth.users where id = $1', [s.user.id])).rows[0]
    expect(row.encrypted_password).toMatch(/^\$2[aby]\$/)
    expect(await bcrypt.compare(PW, row.encrypted_password)).toBe(true)
  })

  it('signup with confirm on returns the user without a session and blocks sign-in', async () => {
    config.authConfirmEmail = true
    const e = email()
    const res = await call('POST', '/signup', { email: e, password: PW, data: { name: 'A' } })
    expect(res.status).toBe(200)
    const u = await res.json()
    expect(u.access_token).toBeUndefined()
    expect(u).toMatchObject({ email: e, email_confirmed_at: null, user_metadata: { name: 'A' } })
    const r = await signIn(e)
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ code: 400, error_code: 'email_not_confirmed' })
  })

  it('signup for a registered email returns a fake user without leaking (confirm on)', async () => {
    const s = await signUp()
    config.authConfirmEmail = true
    const res = await call('POST', '/signup', { email: s.user.email, password: PW })
    expect(res.status).toBe(200)
    const u = await res.json()
    expect(u.email).toBe(s.user.email)
    expect(u.id).not.toBe(s.user.id)
    expect(u.access_token).toBeUndefined()
  })

  it('short password is 422 weak_password', async () => {
    config.authConfirmEmail = false
    const res = await call('POST', '/signup', { email: email(), password: '12345' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 422, error_code: 'weak_password' })
  })

  it('correct password gives a verifiable authenticated access token', async () => {
    const s = await signUp()
    const res = await signIn(s.user.email)
    expect(res.status).toBe(200)
    const body = await res.json()
    const claims = await verify(body.access_token)
    expect(claims).toMatchObject({ role: 'authenticated', aud: 'authenticated', sub: s.user.id, email: s.user.email })
    expect(claims.session_id).toBeTruthy()
    expect(body.user.last_sign_in_at).toBeTruthy()
  })

  it('wrong password is 400 invalid_credentials', async () => {
    const s = await signUp()
    const res = await signIn(s.user.email, 'wrong-password-123')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 400, error_code: 'invalid_credentials' })
  })

  it('banned user is 400 user_banned', async () => {
    const s = await signUp()
    await pool.query(`update auth.users set banned_until = now() + interval '1 day' where id = $1`, [s.user.id])
    const res = await signIn(s.user.email)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error_code: 'user_banned' })
  })

  it('banned user: refresh and /user are 400 user_banned', async () => {
    const s = await signUp()
    await pool.query(`update auth.users set banned_until = now() + interval '1 day' where id = $1`, [s.user.id])
    const u = await call('GET', '/user', undefined, s.access_token)
    expect(u.status).toBe(400)
    expect(await u.json()).toMatchObject({ error_code: 'user_banned' })
    const r = await refresh(s.refresh_token)
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error_code: 'user_banned' })
  })

  it('a $2a$ hash (exported from Supabase) signs in', async () => {
    const e = email()
    const hash = bcrypt.hashSync(PW, 10).replace(/^\$2b\$/, '$2a$')
    expect(hash.startsWith('$2a$')).toBe(true)
    await pool.query(
      `insert into auth.users (aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
       values ('authenticated', 'authenticated', $1, $2, now(), '{"provider":"email","providers":["email"]}', '{}')`,
      [e, hash],
    )
    const res = await signIn(e)
    expect(res.status).toBe(200)
  })

  it('refresh rotates to a new pair; reusing the old token is 400 and revokes the new one', async () => {
    const s = await signUp()
    const r1 = await refresh(s.refresh_token)
    expect(r1.status).toBe(200)
    const s2 = await r1.json()
    expect(s2.refresh_token).not.toBe(s.refresh_token)
    expect(s2.access_token).toBeTruthy()
    expect((await verify(s2.access_token)).session_id).toBe((await verify(s.access_token)).session_id)

    const reuse = await refresh(s.refresh_token)
    expect(reuse.status).toBe(400)
    expect(await reuse.json()).toMatchObject({ error_code: 'refresh_token_already_used' })
    const after = await refresh(s2.refresh_token)
    expect(after.status).toBe(400)
  })

  it('unknown refresh token is 400', async () => {
    const res = await refresh('nope')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error_code: 'refresh_token_not_found' })
  })

  it('GET /user returns the user; anon key is rejected', async () => {
    const s = await signUp()
    const res = await call('GET', '/user', undefined, s.access_token)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: s.user.id, email: s.user.email, identities: [{ provider: 'email' }] })
    expect((await call('GET', '/user')).status).toBe(403)
  })

  it('PUT /user {data} merges raw_user_meta_data and changes password', async () => {
    config.authConfirmEmail = false
    const e = email()
    const s = await (await call('POST', '/signup', { email: e, password: PW, data: { a: 1 } })).json()
    const res = await call('PUT', '/user', { data: { x: 1 } }, s.access_token)
    expect(res.status).toBe(200)
    expect((await res.json()).user_metadata).toEqual({ a: 1, x: 1 })
    const row = (await pool.query('select raw_user_meta_data from auth.users where id = $1', [s.user.id])).rows[0]
    expect(row.raw_user_meta_data).toEqual({ a: 1, x: 1 })

    expect((await call('PUT', '/user', { password: 'abc' }, s.access_token)).status).toBe(422)
    expect((await call('PUT', '/user', { password: 'new-password-456' }, s.access_token)).status).toBe(200)
    expect((await signIn(e, 'new-password-456')).status).toBe(200)
  })

  it('PUT /user with a taken email is 422 and writes nothing', async () => {
    config.authConfirmEmail = false
    const other = await signUp()
    const e = email()
    const s = await (await call('POST', '/signup', { email: e, password: PW, data: { a: 1 } })).json()
    const res = await call('PUT', '/user', { data: { x: 1 }, password: 'new-password-456', email: other.user.email }, s.access_token)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error_code: 'email_exists' })
    const row = (await pool.query('select raw_user_meta_data, email from auth.users where id = $1', [s.user.id])).rows[0]
    expect(row).toEqual({ raw_user_meta_data: { a: 1 }, email: e })
    expect((await signIn(e)).status).toBe(200)
  })

  it('logout scope=local ends only this session, scope=others keeps only this one', async () => {
    const s = await signUp()
    const a = await (await signIn(s.user.email)).json()
    const b = await (await signIn(s.user.email)).json()
    expect((await call('POST', '/logout?scope=local', undefined, a.access_token)).status).toBe(204)
    expect((await refresh(a.refresh_token)).status).toBe(400)
    expect((await call('GET', '/user', undefined, b.access_token)).status).toBe(200)

    expect((await call('POST', '/logout?scope=others', undefined, b.access_token)).status).toBe(204)
    expect((await refresh(s.refresh_token)).status).toBe(400)
    expect((await call('GET', '/user', undefined, b.access_token)).status).toBe(200)
    expect((await refresh(b.refresh_token)).status).toBe(200)
  })

  it('logout revokes the session: refresh fails and /user is 403', async () => {
    const s = await signUp()
    const res = await call('POST', '/logout', undefined, s.access_token)
    expect(res.status).toBe(204)
    expect((await refresh(s.refresh_token)).status).toBe(400)
    expect((await call('GET', '/user', undefined, s.access_token)).status).toBe(403)
  })

  it('admin endpoints need service_role', async () => {
    const s = await signUp()
    const noToken = await app.request(`/auth/v1/admin/users/${s.user.id}`, { method: 'DELETE' })
    expect(noToken.status).toBe(401)
    expect(await noToken.json()).toMatchObject({ error_code: 'no_authorization' })
    const listNoToken = await app.request('/auth/v1/admin/users')
    expect(listNoToken.status).toBe(401)
    const asAnon = await call('DELETE', `/admin/users/${s.user.id}`)
    expect([401, 403]).toContain(asAnon.status)
    expect((await call('DELETE', `/admin/users/${s.user.id}`, undefined, s.access_token)).status).toBe(403)

    const list = await call('GET', '/admin/users?per_page=1000', undefined, serviceKey)
    expect(list.status).toBe(200)
    expect((await list.json()).users.some((u: { id: string }) => u.id === s.user.id)).toBe(true)

    const del = await call('DELETE', `/admin/users/${s.user.id}`, undefined, serviceKey)
    expect(del.status).toBe(200)
    expect((await pool.query('select 1 from auth.users where id = $1', [s.user.id])).rowCount).toBe(0)
    expect((await call('DELETE', `/admin/users/${s.user.id}`, undefined, serviceKey)).status).toBe(404)
  })
})
