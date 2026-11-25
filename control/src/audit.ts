// One control.audit_log row per write through /platform and /v1 (spec section 9). Rows name the JSON body's keys,
// never its values: tokens, passwords and secrets travel in bodies.
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { pool } from './db.ts'
import { clientIp, take } from './core.ts'
import { ApiError } from './errors.ts'
import { apiRoute, checkOrigin, PUBLIC } from './session.ts'
import type { Env } from './session.ts'

export const BODY_LIMIT = 256 * 1024
/** Route patterns that take larger bodies (uploads, imports) and enforce their own limit; the tasks adding them list them. */
export const largeBodyRoutes = new Set<string>()
const isJson = (c: Context) => !!c.req.header('content-type')?.toLowerCase().startsWith('application/json')
/** A file upload through the admin forward: any type (a .json file too) streams under the project's upload limit. */
export const isUpload = (c: Context) => /^\/platform\/projects\/[^/]+\/admin\/files\//.test(c.req.path)
const limit = bodyLimit({
  maxSize: BODY_LIMIT,
  onError: (c) => c.json({ error: 'payload_too_large', message: 'request body larger than 256 KiB' }, 413),
})
const isWrite = (c: Context) => c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS'
/**
 * Caps every request body before audit or a handler parses it, except uploads on the routes in largeBodyRoutes
 * (wholeBody reads every other body, so it must be bounded).
 */
export const bodyCap = createMiddleware((c, next) => {
  const route = apiRoute(c)
  return route && largeBodyRoutes.has(route) && isUpload(c) ? next() : limit(c, next)
})

/**
 * Reads every write's whole body (uploads aside, which stream) before authenticate: a request authorized while its
 * body is still on the way could otherwise act after a password reset or logout ended its session. Hono caches it
 * for the handler. After bodyCap, so at most 256 KiB.
 */
export const wholeBody = createMiddleware(async (c, next) => {
  if (isWrite(c) && !isUpload(c)) await c.req.arrayBuffer()
  return next()
})

const MAX_KEYS = 32
const MAX_KEY_LENGTH = 64
// core limits these per IP itself (signIn and refresh buckets)
const CORE_LIMITED = /^\/platform\/(login|refresh)$/
/**
 * Per-IP limit on the other public writes (invitations/accept, logout, auth/v1/*), before audit: a refused request
 * writes no row. Reuses core's limiter, in its own key spaces: logout with the refresh budget (signing out must not
 * compete with invitations for five tries, yet an anonymous flood stays bounded), the others with the signIn budget.
 */
export const publicLimit = createMiddleware(async (c, next) => {
  const write = c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS'
  if (!write || !PUBLIC.test(c.req.path) || CORE_LIMITED.test(c.req.path)) return next()
  const logout = c.req.path === '/platform/logout'
  // a foreign Origin is refused before it is counted: another site's page must not use up an address's logouts
  if (logout) checkOrigin(c)
  const ok = logout ? take('refresh', `logout:${clientIp(c)}`) : take('signIn', `public:${clientIp(c)}`)
  if (!ok) throw new ApiError(429, 'over_request_rate_limit', 'Too many requests from this address. Try again in a few minutes.')
  return next()
})

export const audit = createMiddleware<Env>(async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next()
  let bodyKeys: string[] = []
  if (isJson(c) && !isUpload(c)) {
    // parsed once here; Hono caches the body, so the handler can still read it
    const body = await c.req.json().catch(() => null)
    if (body && typeof body === 'object' && !Array.isArray(body))
      bodyKeys = Object.keys(body).slice(0, MAX_KEYS).map((k) => k.slice(0, MAX_KEY_LENGTH))
  }
  await next()
  // Rows the internet could otherwise write at will: an anonymous caller gets none when it was refused before anything
  // ran (401 or 403: no session or token, a foreign Origin, a refresh without its cookie; login and refresh are outside
  // publicLimit, so these refusals are unlimited), when no route answers the path, or when a rate limit refused it.
  // Failed sign-ins (400 from core) keep their row: core's signIn bucket bounds them.
  if (!c.get('user') && ([401, 403, 429].includes(c.res.status) || !apiRoute(c))) return
  // a logout that named no real session (no cookie, or a forged value) ended nothing: it answers 200, and a row each
  // would let anyone fill the log. The handler sets an audit scope once core or the refresh token found the session.
  if (c.req.path === '/platform/logout' && !c.get('audit')) return
  const path = c.get('audit')?.path
  await writeAudit(c, { status: c.res.status, body_keys: bodyKeys, ...(path ? { path } : {}) })
})

/** The row for this request, from c.get('audit'); reads that disclose a secret call it themselves (GETs are not audited). */
export async function writeAudit(c: Context<Env>, details: Record<string, unknown>): Promise<void> {
  const scope = c.get('audit') ?? {}
  await pool
    .query(
      `insert into control.audit_log (actor, org_id, project_id, action, target, ip, details) values ($1, $2, $3, $4, $5, $6, $7)`,
      [c.get('user')?.email ?? 'anonymous', scope.orgId ?? null, scope.projectId ?? null, `${c.req.method} ${apiRoute(c) ?? c.req.path}`,
        scope.target ?? null, clientIp(c), details],
    )
    // the answer already happened (or is about to); a lost row is logged, without the request's data
    .catch((e: Error) => console.error(`audit: ${e.message}`))
}
