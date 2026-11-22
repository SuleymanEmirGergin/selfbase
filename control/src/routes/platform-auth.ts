// Studio sign-in on core's auth module (AC-12). Only /recover, GET /verify and PUT /user of core's router are reachable,
// under /platform/auth/v1; everything else of it (signup, otp, oauth, token, ...) is not mounted, because
// AUTH_DISABLE_SIGNUP only closes POST /signup and the others would create dashboard accounts.
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { getCookie } from 'hono/cookie'
import { pool } from '../db.ts'
import { resetPasswordUrl } from '../core-env.ts'
import { coreAuth, createUser } from '../core.ts'
import { ApiError } from '../errors.ts'
import { newAccessToken } from '../ids.ts'
import { ACCESS_COOKIE, REFRESH_COOKIE, checkOrigin, clearSessionCookies, setSessionCookies } from '../session.ts'
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

/** A dashboard user whose address is taken as proven (the CLI, an accepted invitation). */
export async function createConfirmedUser(email: string, password: string) {
  const user = await createUser({ email, password, provider: 'email' })
  await pool.query(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1`, [user.id])
  await pool.query(`update auth.identities set identity_data = identity_data || '{"email_verified": true}' where user_id = $1`, [user.id])
  return user
}

const signedIn = (c: Context<Env>, s: { access_token: string; refresh_token: string; user: { id: string; email: string } }) => {
  setSessionCookies(c, s)
  c.set('user', { id: s.user.id, email: s.user.email, via: 'cookie' })
  // the tokens live in the httpOnly cookies only
  return c.json({ email: s.user.email })
}

platformAuth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const res = await callCore(c, 'POST', '/token?grant_type=password', { body: JSON.stringify({ email: body?.email, password: body?.password }) })
  if (!res.ok) throw await coreError(res)
  return signedIn(c, await res.json())
})

platformAuth.post('/refresh', async (c) => {
  checkOrigin(c)
  const token = getCookie(c, REFRESH_COOKIE)
  if (!token) throw new ApiError(401, 'unauthorized', 'Unauthorized')
  const res = await callCore(c, 'POST', '/token?grant_type=refresh_token', { body: JSON.stringify({ refresh_token: token }) })
  if (res.status === 429) throw await coreError(res)
  if (!res.ok) {
    clearSessionCookies(c)
    throw new ApiError(401, 'unauthorized', 'Unauthorized')
  }
  return signedIn(c, await res.json())
})

platformAuth.post('/logout', async (c) => {
  checkOrigin(c)
  const jwt = getCookie(c, ACCESS_COOKIE)
  // ends the session behind the cookie; an expired or forged cookie has nothing to end
  if (jwt) await callCore(c, 'POST', '/logout?scope=local', { bearer: `Bearer ${jwt}` })
  clearSessionCookies(c)
  return c.json({})
})

// the recovery link always lands on Studio's reset screen, whatever redirect_to the caller sent
platformAuth.post('/auth/v1/recover', async (c) =>
  passOn(await callCore(c, 'POST', `/recover?${new URLSearchParams({ redirect_to: resetPasswordUrl })}`, { body: await c.req.text() })))
// the mailed link: core redirects with the session in the fragment (#access_token=…&type=recovery)
platformAuth.get('/auth/v1/verify', async (c) => passOn(await callCore(c, 'GET', `/verify?${new URL(c.req.url).searchParams}`)))
// Studio's reset screen sends the recovery access token as the bearer; core checks it and its session
platformAuth.put('/auth/v1/user', async (c) =>
  passOn(await callCore(c, 'PUT', '/user', { body: await c.req.text(), bearer: c.req.header('authorization') })))

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
