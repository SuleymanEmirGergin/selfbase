// Who is calling: the Studio session cookies (/platform only) or a personal access token (/platform and /v1).
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { matchedRoutes } from 'hono/route'
import { config } from './config.ts'
import { pool } from './db.ts'
import { ApiError } from './errors.ts'
import { hashToken } from './ids.ts'
import { sessionActive, verify } from './core.ts'

export type User = { id: string; email: string; via: 'cookie' | 'token' }
/** What authorize() learned, for the audit row. */
export type AuditScope = { orgId?: string; projectId?: string; target?: string }
export type Env = { Variables: { user: User; audit: AuditScope } }

export const ACCESS_COOKIE = 'sb_studio'
export const REFRESH_COOKIE = 'sb_studio_refresh'
const REFRESH_PATH = '/platform/refresh'
const ORIGIN = new URL(config.publicUrl).origin
const secure = new URL(config.publicUrl).protocol === 'https:'
const TOKEN_RE = /^Bearer (sbp_[0-9a-f]{40})$/
// reachable without a session: they start one, end one, or are core's own sign-in routes (which check the bearer)
const PUBLIC = /^\/platform\/(login|refresh|logout|invitations\/accept|auth\/v1\/.*)$/

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
  // shortcut: 30 days, core's refresh tokens have no lifetime of their own; revisit with session timeboxes (8.2)
  setCookie(c, REFRESH_COOKIE, s.refresh_token, { ...base, path: REFRESH_PATH, maxAge: 30 * 86400 })
}

export function clearSessionCookies(c: Context): void {
  deleteCookie(c, ACCESS_COOKIE, { path: '/', secure })
  deleteCookie(c, REFRESH_COOKIE, { path: REFRESH_PATH, secure })
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
  if (!claims?.sub || claims.role !== 'authenticated' || !(await sessionActive(claims.session_id))) return null
  const { rows } = await pool.query(`select id, email from auth.users where id = $1 and (banned_until is null or banned_until <= now())`, [claims.sub])
  return rows[0] ? { id: rows[0].id, email: rows[0].email, via: 'cookie' } : null
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
