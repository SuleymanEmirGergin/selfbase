// Who is calling: the Studio session cookies (/platform only) or a personal access token (/platform and /v1).
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { matchedRoutes } from 'hono/route'
import { config } from './config.ts'
import { pool } from './db.ts'
import type { Db } from './db.ts'
import { ApiError } from './errors.ts'
import { hashToken } from './ids.ts'
import { revokeSession, verify } from './core.ts'

/** sessionId: the Studio session behind a cookie caller (a write that must not outlive it checks it again) */
export type User = { id: string; email: string; via: 'cookie' | 'token'; sessionId?: string }
/** What authorize() learned, for the audit row. */
export type AuditScope = { orgId?: string; projectId?: string; target?: string; path?: string }
export type Env = { Variables: { user: User; audit: AuditScope } }

const ORIGIN = new URL(config.publicUrl).origin
const secure = new URL(config.publicUrl).protocol === 'https:'
// sslip.io is not on the Public Suffix List, so a sibling host can set a same-named cookie for the parent domain
// (fixing or shadowing ours). A __Host- cookie (Secure, Path=/, no Domain) cannot be set that way; plain HTTP (local
// dev) cannot carry one, so it keeps the bare names. The refresh cookie is Path=/ too, as __Host- requires.
export const cookieNames = (https: boolean) => https
  ? { access: '__Host-sb_studio', refresh: '__Host-sb_studio_refresh' }
  : { access: 'sb_studio', refresh: 'sb_studio_refresh' }
export const { access: ACCESS_COOKIE, refresh: REFRESH_COOKIE } = cookieNames(secure)
const TOKEN_RE = /^Bearer (sbp_[0-9a-f]{40})$/
// reachable without a session: they start one, end one, or are core's own sign-in routes (which check the bearer)
export const PUBLIC = /^\/platform\/(login|refresh|logout|invitations\/accept|auth\/v1\/.*)$/

/** The API route pattern that answers this request, if any (middleware and Studio's `*` fallback are not routes). */
export const apiRoute = (c: Context): string | undefined =>
  matchedRoutes(c).filter((r) => r.method !== 'ALL' && !r.path.endsWith('*')).at(-1)?.path

const unauthorized = () => new ApiError(401, 'unauthorized', 'Unauthorized')

/** Cookie requests that change something must come from Studio's own origin (CSRF). */
export function checkOrigin(c: Context): void {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return
  if (c.req.header('origin') !== ORIGIN) throw new ApiError(403, 'forbidden', 'Cross-origin request refused')
}

export function setSessionCookies(c: Context, s: { access_token: string; refresh_token: string }): void {
  const base = { httpOnly: true, sameSite: 'Strict', secure } as const
  setCookie(c, ACCESS_COOKIE, s.access_token, { ...base, path: '/', maxAge: 3600 })
  // the server ends the session at the same age (sessionState); the cookie is only the browser's copy of that limit
  setCookie(c, REFRESH_COOKIE, s.refresh_token, { ...base, path: '/', maxAge: Math.round(config.sessionMaxAgeDays * 86400) })
}

/**
 * A Studio session (core's refresh tokens of one session_id, in control-db) and whether it is over: older than
 * STUDIO_SESSION_MAX_AGE_DAYS since sign-in, or STUDIO_SESSION_IDLE_HOURS since its last refresh (each refresh adds
 * a token). Core gives its refresh tokens no lifetime, so control enforces both, at refresh and on every cookie request.
 */
async function sessionState(sessionId: string, db: Db = pool): Promise<{ open: boolean; expired: boolean }> {
  const r = (await db.query(
    `select coalesce(bool_or(not revoked), false) as open,
            coalesce(min(created_at) < now() - $2::float8 * interval '1 day' or max(created_at) < now() - $3::float8 * interval '1 hour', false) as expired
       from auth.refresh_tokens where session_id = $1`,
    [sessionId, config.sessionMaxAgeDays, config.sessionIdleHours],
  )).rows[0]
  return { open: r.open, expired: r.expired }
}

/** Live: not revoked (logout, a password reset) and not past either lifetime. */
export async function sessionLive(sessionId: string | undefined, db: Db = pool): Promise<boolean> {
  if (!sessionId) return false
  const s = await sessionState(sessionId, db)
  return s.open && !s.expired
}

/** The session a refresh token belongs to, if any. */
export const sessionOfRefresh = async (token: string): Promise<string | null> =>
  (await pool.query('select session_id from auth.refresh_tokens where token = $1', [token])).rows[0]?.session_id ?? null

/** Ends the session behind a refresh token when it is past a lifetime; true when it did. */
export async function endIfExpired(token: string): Promise<boolean> {
  const sid = await sessionOfRefresh(token)
  if (!sid || !(await sessionState(sid)).expired) return false
  await revokeSession(sid)
  return true
}

export function clearSessionCookies(c: Context): void {
  deleteCookie(c, ACCESS_COOKIE, { path: '/', secure })
  deleteCookie(c, REFRESH_COOKIE, { path: '/', secure })
}

/** The user behind a token: live, not expired, not banned. Bumps last_used_at at most once a minute. */
async function tokenUser(token: string): Promise<User | null> {
  const { rows } = await pool.query(
    `with t as (select id, user_id, last_used_at from control.access_tokens
                 where token_hash = $1 and (expires_at is null or expires_at > now())),
          bump as (update control.access_tokens a set last_used_at = now() from t
                    where a.id = t.id and (t.last_used_at is null or t.last_used_at < now() - interval '1 minute'))
     select u.id, u.email from t join auth.users u on u.id = t.user_id
      where u.banned_until is null or u.banned_until <= now()`,
    [hashToken(token)],
  )
  return rows[0] ? { id: rows[0].id, email: rows[0].email, via: 'token' } : null
}

/** The user behind the access cookie: a valid core JWT whose session is still live (logout ends it at once). */
async function cookieUser(jwt: string): Promise<User | null> {
  const claims = await verify(jwt).catch(() => null)
  if (!claims?.sub || claims.role !== 'authenticated' || !(await sessionLive(claims.session_id))) return null
  const { rows } = await pool.query(`select id, email from auth.users where id = $1 and (banned_until is null or banned_until <= now())`, [claims.sub])
  return rows[0] ? { id: rows[0].id, email: rows[0].email, via: 'cookie', sessionId: claims.session_id } : null
}

/** The Studio session behind the request's cookie (same-origin checked), or null; for PUBLIC routes that use one. */
export async function sessionUser(c: Context): Promise<User | null> {
  const jwt = getCookie(c, ACCESS_COOKIE)
  const user = jwt ? await cookieUser(jwt) : null
  if (user) checkOrigin(c)
  return user
}

/**
 * Sets c.get('user'). /platform: the cookie or `Bearer sbp_…`; /v1: the bearer only. Fails closed: every path but
 * PUBLIC needs a caller, whether or not a route answers it (an unknown path is a 404 only after this).
 */
export const authenticate = (scope: 'platform' | 'v1') =>
  createMiddleware<Env>(async (c, next) => {
    if (scope === 'platform' && PUBLIC.test(c.req.path)) return next()
    const header = c.req.header('authorization')
    let user: User | null = null
    if (header) {
      const token = header.match(TOKEN_RE)?.[1]
      user = token ? await tokenUser(token) : null
    } else if (scope === 'platform') {
      user = await sessionUser(c)
    }
    if (!user) throw unauthorized()
    c.set('user', user)
    return next()
  })
