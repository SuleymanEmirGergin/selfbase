import type { Context } from 'hono'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// TRUSTED_PROXY_HOSTS (comma-separated names or addresses): only a socket peer among their addresses may set
// X-Forwarded-For. Unset (core: its only way in is the proxy's route) means every peer counts as the proxy.
let trusted: Set<string> | null = null
let refreshedAt = 0
let hosts: string | undefined

const bare = (a: string) => a.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '')

/** Resolves the trusted proxies again (at start, every 60 s, and early when an unknown peer sends forwarded headers). */
export async function refreshTrustedProxies(list = process.env.TRUSTED_PROXY_HOSTS): Promise<void> {
  hosts = list
  refreshedAt = Date.now()
  if (!list?.trim()) {
    trusted = null
    return
  }
  const next = new Set<string>()
  await Promise.all(list.split(',').map((h) => h.trim()).filter(Boolean).map(async (h) => {
    if (isIP(h)) return next.add(bare(h))
    // a proxy that is down resolves to nothing: its old address may belong to another container by now
    for (const a of await lookup(h, { all: true }).catch(() => [])) next.add(bare(a.address))
  }))
  if (hosts === list) trusted = next
}

if (process.env.TRUSTED_PROXY_HOSTS) {
  trusted = new Set() // nothing is trusted until the first lookup answers
  void refreshTrustedProxies()
  setInterval(() => void refreshTrustedProxies(hosts), 60_000).unref()
}

/**
 * The client IP core trusts: when TRUST_PROXY=true and the socket peer is a trusted proxy, the RIGHTMOST
 * X-Forwarded-For entry (the one our proxy appended; entries to its left are client-supplied and spoofable),
 * otherwise the socket address.
 */
export function clientIp(c: Context): string {
  const peer = (c.env as any)?.incoming?.socket?.remoteAddress as string | undefined
  if (process.env.TRUST_PROXY === 'true') {
    const xff = c.req.header('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean)
    if (xff?.length) {
      if (!trusted || (peer && trusted.has(bare(peer)))) return xff[xff.length - 1]
      // a restarted proxy has a new address: look again soon, not on every request
      if (Date.now() - refreshedAt > 5000) void refreshTrustedProxies(hosts)
    }
  }
  return peer ?? 'unknown'
}
