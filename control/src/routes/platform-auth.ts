// Studio sign-in on core's auth module (AC-12). Only /recover, GET /verify and PUT /user of core's router are reachable,
// under /platform/auth/v1; everything else of it (signup, otp, oauth, token, ...) is not mounted, because
// AUTH_DISABLE_SIGNUP only closes POST /signup and the others would create dashboard accounts.
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { getCookie } from 'hono/cookie'
import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { pool } from '../db.ts'
import type { Db } from '../db.ts'
import { resetPasswordUrl } from '../core-env.ts'
import { coreAuth, hashPassword, revokeSession, verify } from '../core.ts'
import { ApiError } from '../errors.ts'
import { newAccessToken } from '../ids.ts'
import { ACCESS_COOKIE, REFRESH_COOKIE, checkOrigin, clearSessionCookies, endIfExpired, sessionLive, sessionOfRefresh, setSessionCookies } from '../session.ts'
import type { Env } from '../session.ts'

export const platformAuth = new Hono<Env>()

/** Calls core's auth router in-process, with the caller's connection and X-Forwarded-For (rate limits, bans). */
function callCore(c: Context, method: string, path: string, opts: { body?: string; bearer?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' })
  const xff = c.req.header('x-forwarded-for')
  if (xff) headers.set('x-forwarded-for', xff)
  if (opts.bearer) headers.set('authorization', opts.bearer)
  return coreAuth.fetch(new Request(`http://core${path}`, { method, headers, body: opts.body }), c.env)
}

/** core's GoTrue error {code, error_code, msg} as control's {error, message}. */
async function coreError(res: Response): Promise<ApiError> {
  const j = await res.json().catch(() => null)
  return new ApiError(res.status as ContentfulStatusCode, j?.error_code ?? 'auth_error', j?.msg ?? 'request failed')
}
const passOn = async (res: Response) => {
  if (res.status >= 400) throw await coreError(res)
  return res
}

/** Runs fn in one transaction on a control-db client. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * A dashboard user whose address is taken as proven (the CLI, an accepted invitation), written on `db` so it can be
 * part of the caller's transaction. The same rows core's createUser writes, with email_confirmed_at set.
 */
export async function createConfirmedUser(email: string, password: string, db: Db = pool): Promise<{ id: string; email: string }> {
  const id = randomUUID()
  const lower = email.toLowerCase()
  await db.query(
    `insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
     values ($1, 'authenticated', 'authenticated', $2, $3, now(), '{"provider": "email", "providers": ["email"]}', '{}')`,
    [id, lower, await hashPassword(password)],
  )
  await db.query(`insert into auth.identities (provider_id, user_id, identity_data, provider) values ($1::text, $1::uuid, $2, 'email')`,
    [id, { sub: id, email: lower, email_verified: true, phone_verified: false }])
  return { id, email: lower }
}

const signedIn = (c: Context<Env>, s: { access_token: string; refresh_token: string; user: { id: string; email: string } }) => {
  setSessionCookies(c, s)
  c.set('user', { id: s.user.id, email: s.user.email, via: 'cookie' })
  // the tokens live in the httpOnly cookies only
  return c.json({ email: s.user.email })
}

platformAuth.post('/login', async (c) => {
  checkOrigin(c) // login CSRF: only Studio's own page signs in
  const body = await c.req.json().catch(() => ({}))
  const res = await callCore(c, 'POST', '/token?grant_type=password', { body: JSON.stringify({ email: body?.email, password: body?.password }) })
  if (!res.ok) throw await coreError(res)
  return signedIn(c, await res.json())
})

platformAuth.post('/refresh', async (c) => {
  checkOrigin(c)
  const token = getCookie(c, REFRESH_COOKIE)
  if (!token) throw new ApiError(401, 'unauthorized', 'Unauthorized')
  // past the absolute or idle lifetime: the session ends here, core never rotates it
  if (await endIfExpired(token)) {
    clearSessionCookies(c)
    throw new ApiError(401, 'unauthorized', 'Unauthorized')
  }
  const res = await callCore(c, 'POST', '/token?grant_type=refresh_token', { body: JSON.stringify({ refresh_token: token }) })
  if (res.status === 429) throw await coreError(res)
  if (!res.ok) {
    clearSessionCookies(c)
    throw new ApiError(401, 'unauthorized', 'Unauthorized')
  }
  return signedIn(c, await res.json())
})

// Ends the session through the access cookie and through the refresh cookie: once the access cookie has expired (1 h)
// only the refresh token names the session. A failed revoke is an error, and the cookies stay: the user must not
// believe they are signed out while the refresh token still works.
platformAuth.post('/logout', async (c) => {
  checkOrigin(c)
  const jwt = getCookie(c, ACCESS_COOKIE)
  if (jwt) {
    const res = await callCore(c, 'POST', '/logout?scope=local', { bearer: `Bearer ${jwt}` })
    // a 4xx is an expired or forged access cookie, which ends nothing by itself; the refresh cookie below still does
    if (res.status >= 500) throw new ApiError(502, 'logout_failed', 'The session could not be ended. Try again.')
  }
  const refresh = getCookie(c, REFRESH_COOKIE)
  const sid = refresh ? await sessionOfRefresh(refresh) : null
  if (sid) await revokeSession(sid)
  clearSessionCookies(c)
  return c.json({})
})

// the recovery link always lands on Studio's reset screen, whatever redirect_to the caller sent
platformAuth.post('/auth/v1/recover', async (c) =>
  passOn(await callCore(c, 'POST', `/recover?${new URLSearchParams({ redirect_to: resetPasswordUrl })}`, { body: await c.req.text() })))
// the mailed link: core redirects with the session in the fragment (#access_token=…&type=recovery)
platformAuth.get('/auth/v1/verify', async (c) => passOn(await callCore(c, 'GET', `/verify?${new URL(c.req.url).searchParams}`)))
// Studio's reset screen sends the recovery access token as the bearer. Any other Studio access token (a stolen cookie)
// also needs the current password. Only the password is passed on (no email, phone or metadata changes from here).
// Core's new password ends every other session of the user and its one-time tokens, in the same transaction under
// its per-user lock (S4): a stolen cookie or refresh token stops working with the reset.
platformAuth.put('/auth/v1/user', async (c) => {
  const b = await c.req.json().catch(() => null)
  if (typeof b?.password !== 'string') throw new ApiError(400, 'validation_failed', 'password is required')
  const bearer = c.req.header('authorization') ?? ''
  const claims = await verify(bearer.replace(/^Bearer\s+/i, '')).catch(() => null)
  if (!claims?.sub || claims.role !== 'authenticated') throw new ApiError(401, 'unauthorized', 'Unauthorized')
  // control's absolute and idle lifetimes, as at /platform/refresh: core only asks whether the session is revoked
  if (!(await sessionLive(claims.session_id))) {
    if (claims.session_id) await revokeSession(claims.session_id)
    throw new ApiError(401, 'unauthorized', 'Unauthorized')
  }
  const recovery = claims.amr?.some((a) => a?.method === 'recovery')
  if (!recovery) {
    if (typeof b.current_password !== 'string')
      throw new ApiError(403, 'reauthentication_needed', 'current_password is required without a recovery link')
    // through core's password grant, so its sign-in rate limit and ban check apply; the session it starts ends at once
    const email = (await pool.query('select email from auth.users where id = $1', [claims.sub])).rows[0]?.email ?? ''
    const check = await passOn(await callCore(c, 'POST', '/token?grant_type=password', { body: JSON.stringify({ email, password: b.current_password }) }))
    await revokeSession((await verify((await check.json()).access_token)).session_id!)
  }
  const res = await passOn(await callCore(c, 'PUT', '/user', { body: JSON.stringify({ password: b.password }), bearer }))
  // a recovery link sets one password: its session ends with the reset and the user signs in fresh (Studio's reset
  // screen sends them to the sign-in screen)
  if (recovery && claims.session_id) await revokeSession(claims.session_id)
  return res
})

// ---- personal access tokens (org.tokens: every user, for their own tokens) ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

platformAuth.get('/access-tokens', async (c) => {
  const { rows } = await pool.query(
    `select id, name, created_at, last_used_at, expires_at from control.access_tokens where user_id = $1 order by created_at, id`,
    [c.get('user').id],
  )
  return c.json(rows)
})

platformAuth.post('/access-tokens', async (c) => {
  // a token cannot mint tokens: a leaked one must not outlive its own deletion
  if (c.get('user').via !== 'cookie') throw new ApiError(403, 'forbidden', 'access tokens are created from a Studio session')
  const b = await c.req.json().catch(() => null)
  const name = b?.name
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new ApiError(400, 'validation_failed', 'name must be 1 to 100 characters')
  let expiresAt: Date | null = null
  if (b.expires_at !== undefined && b.expires_at !== null) {
    expiresAt = new Date(b.expires_at)
    if (typeof b.expires_at !== 'string' || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
      throw new ApiError(400, 'validation_failed', 'expires_at must be a future ISO date')
  }
  const { token, hash } = newAccessToken()
  const { id } = (await pool.query(
    `insert into control.access_tokens (user_id, name, token_hash, expires_at) values ($1, $2, $3, $4) returning id`,
    [c.get('user').id, name.trim(), hash, expiresAt],
  )).rows[0]
  // the only time the token is shown
  return c.json({ id, name: name.trim(), token }, 201)
})

platformAuth.delete('/access-tokens/:id', async (c) => {
  const id = c.req.param('id')
  c.set('audit', { target: id })
  const gone = UUID_RE.test(id) && (await pool.query(`delete from control.access_tokens where id = $1 and user_id = $2`, [id, c.get('user').id])).rowCount
  if (!gone) throw new ApiError(404, 'not_found', 'access token not found')
  return c.json({})
})
