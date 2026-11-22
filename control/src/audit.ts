// One control.audit_log row per write through /platform and /v1 (spec section 9). Rows name the JSON body's keys,
// never its values: tokens, passwords and secrets travel in bodies.
import { createMiddleware } from 'hono/factory'
import { pool } from './db.ts'
import { clientIp } from './core.ts'
import { apiRoute } from './session.ts'
import type { Env } from './session.ts'

export const audit = createMiddleware<Env>(async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next()
  let bodyKeys: string[] = []
  if (c.req.header('content-type')?.startsWith('application/json')) {
    // parsed once here; Hono caches the body, so the handler can still read it
    const body = await c.req.json().catch(() => null)
    if (body && typeof body === 'object' && !Array.isArray(body)) bodyKeys = Object.keys(body)
  }
  await next()
  const scope = c.get('audit') ?? {}
  await pool
    .query(
      `insert into control.audit_log (actor, org_id, project_id, action, target, ip, details) values ($1, $2, $3, $4, $5, $6, $7)`,
      [c.get('user')?.email ?? 'anonymous', scope.orgId ?? null, scope.projectId ?? null, `${c.req.method} ${apiRoute(c) ?? c.req.path}`,
        scope.target ?? null, clientIp(c), { status: c.res.status, body_keys: bodyKeys }],
    )
    // the answer already happened; a lost row is logged, without the request's data
    .catch((e: Error) => console.error(`audit: ${e.message}`))
})
