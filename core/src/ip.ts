import type { Context } from 'hono'

// Who may set X-Forwarded-For. Core: the addresses in TRUSTED_PROXY_IPS, which the provisioner sets on every project
// to the proxy container's address (empty while the proxy is down: no peer). Other containers on the shared proxy
// network reach core's 8080 directly, so trusting every peer would let them pick their own client IP. Unset (tests
// only): every peer. Control: the addresses its source answers (the provisioner reads the proxy container by exact
// name; a DNS answer is steerable by any container on the proxy network with an alias) plus fixed IP literals.
const bare = (a: string) => a.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '')
const fromEnv = process.env.TRUSTED_PROXY_IPS
let trusted: Set<string> | null = fromEnv === undefined ? null : new Set(fromEnv.split(',').map((a) => bare(a.trim())).filter(Boolean))
let source: (() => Promise<string[]>) | null = null
let fixed: string[] = []
let askedAt = 0
let timer: NodeJS.Timeout | undefined

async function reask(): Promise<void> {
  const from = source
  if (!from) return
  askedAt = Date.now()
  try {
    const addrs = await from()
    if (source === from) trusted = new Set([...fixed, ...addrs].map(bare))
  } catch (e) {
    // the proxy is not running (503 proxy_unavailable): another container may take its old address, so only the
    // literals stay. Anything else (an unreachable provisioner) keeps what was trusted: it must not open the door
    if ((e as { code?: string }).code === 'proxy_unavailable' && source === from) trusted = new Set(fixed.map(bare))
  }
}

/**
 * Trusts the addresses `from` answers (asked now, every 60 s, and early when an unknown peer forwards) and `literals`;
 * null goes back to trusting every peer. `refresh` re-asks and resolves when the answer is in.
 */
export function trustProxies(from: (() => Promise<string[]>) | null, literals: string[] = []) {
  clearInterval(timer)
  source = from
  fixed = literals
  trusted = from ? new Set(literals.map(bare)) : null
  if (from) {
    void reask()
    timer = setInterval(() => void reask(), 60_000)
    timer.unref()
  }
  return { refresh: reask }
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
      // a restarted proxy has a new address: ask again soon, not on every request
      if (Date.now() - askedAt > 5000) void reask()
    }
  }
  return peer ?? 'unknown'
}
