// One control.audit_log row per write through /platform and /v1 (spec section 9). Rows name the JSON body's keys,
// never its values: tokens, passwords and secrets travel in bodies.
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { pool } from './db.ts'
import { clientIp } from './core.ts'
import { apiRoute } from './session.ts'
import type { Env } from './session.ts'

export const BODY_LIMIT = 256 * 1024
/** Route patterns that take larger bodies (uploads, imports) and enforce their own limit; the tasks adding them list them. */
export const largeBodyRoutes = new Set<string>()
const isJson = (c: Context) => !!c.req.header('content-type')?.toLowerCase().startsWith('application/json')
const limit = bodyLimit({
  maxSize: BODY_LIMIT,
  onError: (c) => c.json({ error: 'payload_too_large', message: 'request body larger than 256 KiB' }, 413),
})
/**
 * Caps every request body before audit or a handler parses it, except non-JSON bodies on the routes in
 * largeBodyRoutes (audit parses every JSON body, so JSON is always capped).
 */
export const bodyCap = createMiddleware((c, next) => {
  const route = apiRoute(c)
  return route && largeBodyRoutes.has(route) && !isJson(c) ? next() : limit(c, next)
})

export const audit = createMiddleware<Env>(async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next()
  let bodyKeys: string[] = []
  if (isJson(c)) {
    // parsed once here; Hono caches the body, so the handler can still read it
    const body = await c.req.json().catch(() => null)
    if (body && typeof body === 'object' && !Array.isArray(body)) bodyKeys = Object.keys(body)
  }
  await next()
  await writeAudit(c, { status: c.res.status, body_keys: bodyKeys })
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
