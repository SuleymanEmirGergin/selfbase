// Every error body is {error: <code>, message}; Studio's api.ts reads this shape.
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { HTTPException } from 'hono/http-exception'

export class ApiError extends Error {
  status: ContentfulStatusCode
  code: string
  constructor(status: ContentfulStatusCode, code: string, message: string = code) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function onError(err: Error, c: Context) {
  // a refusal's numbers (admission: neededMb, freeMb; host cap: cap, retryAfter) travel with it
  const details = (err as { details?: Record<string, unknown> }).details
  if (err instanceof ApiError) return c.json({ error: err.code, message: err.message, ...(details ? { details } : {}) }, err.status)
  if (err instanceof HTTPException) return c.json({ error: 'http_error', message: err.message || 'request failed' }, err.status)
  // unexpected: the details stay in the log (name and message only), the client gets nothing it could leak
  console.error(`control: ${err.name}: ${err.message}`)
  return c.json({ error: 'internal', message: 'internal error' }, 500)
}

export const notFound = (c: Context) => c.json({ error: 'not_found', message: 'not found' }, 404)
