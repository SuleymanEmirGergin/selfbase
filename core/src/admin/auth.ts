import { createHash, timingSafeEqual } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import { config } from '../config.ts'
import { adminError } from './ident.ts'

// Only control holds ADMIN_TOKEN; it names the dashboard user it acts for in x-selfbase-actor (an email, <= 320).
export type AdminEnv = { Variables: { actor: string } }

const digest = (s: string) => createHash('sha256').update(s).digest()

/** 401 unless Authorization is `Bearer <ADMIN_TOKEN>`; JWTs (service_role included) grant nothing here. */
export const requireAdminToken = createMiddleware<AdminEnv>(async (c, next) => {
  const m = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')
  // digests have equal length, so timingSafeEqual neither throws nor leaks the token's length
  if (config.adminToken.length < 32 || !m || !timingSafeEqual(digest(m[1]), digest(config.adminToken)))
    throw adminError(401, 'admin token required')
  const actor = c.req.header('x-selfbase-actor') || 'control'
  if (actor.length > 320) throw adminError(400, 'x-selfbase-actor is longer than 320 characters')
  c.set('actor', actor)
  return next()
})
