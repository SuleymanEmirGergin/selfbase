// Routes that /v1 and /platform serve at the same path with the same handler (wave 2 Task 13).
import type { Handler } from 'hono'
import type { Env } from '../session.ts'
import { platformProjects } from './platform-projects.ts'
import { op, v1 } from './v1.ts'

/** Registers the handler on /v1 under its operationId and on /platform at the same path. */
export function both(method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, operationId: string, handler: Handler<Env>): void {
  op(v1, method, path, operationId, handler)
  platformProjects[method](path, handler)
}
