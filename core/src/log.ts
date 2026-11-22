// JSON lines on stdout, one object each. Request lines carry only the fields below: never a header, a body or the
// query string (tokens travel there, e.g. /auth/v1/verify?token=).
import { randomUUID } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import { config } from './config.ts'

type Level = 'info' | 'warn' | 'error'
const project = config.projectRef
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/

const write = (o: object) => process.stdout.write(JSON.stringify(o) + '\n')

/** One non-request log line. */
export const logLine = (level: Level, msg: string, fields: Record<string, unknown> = {}) =>
  write({ ts: new Date().toISOString(), level, svc: 'core', project, msg, ...fields })

/** Logs each request once it has an answer and echoes its request id in x-request-id. */
export const requestLog = (svc: string) =>
  createMiddleware(async (c, next) => {
    const started = performance.now()
    const incoming = c.req.header('x-request-id')
    const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID()
    await next()
    c.res.headers.set('x-request-id', id)
    const status = c.res.status
    write({
      ts: new Date().toISOString(), level: status >= 500 ? 'error' : 'info', svc, project, request_id: id,
      method: c.req.method, path: c.req.path, status, latency_ms: Math.round(performance.now() - started),
    })
  })
