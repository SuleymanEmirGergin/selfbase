import type { Context } from 'hono'

/**
 * The client IP core trusts: when TRUST_PROXY=true, the RIGHTMOST X-Forwarded-For entry (the one our proxy
 * appended; entries to its left are client-supplied and spoofable), otherwise the socket address.
 */
export function clientIp(c: Context): string {
  if (process.env.TRUST_PROXY === 'true') {
    const xff = c.req.header('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean)
    if (xff?.length) return xff[xff.length - 1]
  }
  return (c.env as any)?.incoming?.socket?.remoteAddress ?? 'unknown'
}
