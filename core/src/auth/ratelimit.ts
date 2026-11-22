import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { config } from '../config.ts'
import { clientIp } from '../ip.ts'
import { authError } from './users.ts'

export type Bucket = keyof typeof config.authRateLimits
const WINDOW_MS = 5 * 60 * 1000

// shortcut: in memory and per process, so correct only for a single core instance and reset by a restart;
// move to the database or a shared store when core is scaled out
const hits = new Map<string, { count: number; resetAt: number }>()
let nextPrune = 0

/** Counts one request against the bucket for this IP; false once the bucket's limit is used up in the window. */
export function take(bucket: Bucket, ip: string, now = Date.now()): boolean {
  const max = config.authRateLimits[bucket]
  if (!max) return true
  if (now >= nextPrune) {
    for (const [k, h] of hits) if (h.resetAt <= now) hits.delete(k)
    nextPrune = now + 10_000
  }
  const key = `${bucket}:${ip}`
  const h = hits.get(key)
  if (!h || h.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }
  h.count++
  return h.count <= max
}

/** 429 over_request_rate_limit (GoTrue's shape) when the bucket chosen for the request is used up; null = not limited. */
export const rateLimit = (pick: (c: Context) => Bucket | null) =>
  createMiddleware(async (c, next) => {
    const bucket = pick(c)
    if (bucket && !take(bucket, clientIp(c))) throw authError(429, 'over_request_rate_limit', 'Request rate limit reached')
    return next()
  })

/** Test hook: forget every counter. */
export const resetRateLimits = () => hits.clear()
