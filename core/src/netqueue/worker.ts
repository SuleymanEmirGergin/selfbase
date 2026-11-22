import { config } from '../config.ts'
import { pool } from '../db.ts'
import { listen } from '../realtime/hub.ts'

export type Bases = { fnUrl: string; coreUrl: string }
export type NetQueueOptions = Partial<Bases> & { retryDelayMs?: number; scanMs?: number }

const MAX_ATTEMPTS = 3
const CORE_PATHS = /^\/(rest|auth|storage)\/v1(\/|$)/

/**
 * Points *.supabase.co origins at the internal services (functions → FN_URL, other APIs → core);
 * other http(s) URLs pass through. Throws (blocked) for a supabase.co URL with no internal equivalent or a non-http(s) scheme.
 */
export function rewriteUrl(url: string, bases: Bases = { fnUrl: config.fnUrl, coreUrl: `http://localhost:${config.port}` }): string {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`blocked: scheme ${u.protocol} is not sent`)
  // Trailing dots (also IDNA full stops like %E3%80%82) still resolve to the same host.
  const host = u.hostname.toLowerCase().replace(/\.+$/, '')
  if (host !== 'supabase.co' && !host.endsWith('.supabase.co')) return url
  const rest = u.pathname + u.search
  if (u.pathname.startsWith('/functions/v1/')) return bases.fnUrl + rest.slice('/functions/v1'.length)
  if (CORE_PATHS.test(u.pathname)) return bases.coreUrl + rest
  throw new Error(`blocked: no internal equivalent for ${u.origin}${u.pathname}`)
}

type Row = { id: string; method: string; url: string; headers: unknown; body: unknown }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Sends pending selfbase.http_queue rows on NOTIFY selfbase_http and on a periodic scan. */
export function startWorker(opts: NetQueueOptions = {}) {
  const bases: Bases = { fnUrl: opts.fnUrl ?? config.fnUrl, coreUrl: opts.coreUrl ?? `http://localhost:${config.port}` }
  const retryDelayMs = opts.retryDelayMs ?? 2000
  let stopped = false
  let running: Promise<void> | undefined
  let again = false

  const finish = (id: string, status: string, attempts: number, error: string | null) =>
    pool.query('update selfbase.http_queue set status = $2, attempts = $3, last_error = $4 where id = $1', [id, status, attempts, error])

  async function send(row: Row) {
    let target: string
    try {
      target = rewriteUrl(row.url, bases)
    } catch (err) {
      return finish(row.id, 'blocked', 0, (err as Error).message)
    }
    // Forwarded as stored; non-string values (null, numbers, objects) are dropped.
    const stored = row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers) ? row.headers : {}
    const headers = Object.fromEntries(Object.entries(stored).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    const hasBody = row.method !== 'GET' && row.body != null
    if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
    let error = ''
    // shortcut: retries run inline, so a slow host stalls the whole queue about 19 s per row (3 x 5 s timeout + 2 x 2 s delay),
    // and there is no claim state, so only a single core instance may run the worker; move to a next_attempt_at column
    // plus a claimed status if traffic grows or core is scaled out
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(target, {
          method: row.method,
          headers,
          body: hasBody ? JSON.stringify(row.body) : undefined,
          signal: AbortSignal.timeout(5000),
          // Redirects are not followed (they could lead to *.supabase.co); a 3xx fails the attempt.
          redirect: 'manual',
        })
        await res.body?.cancel()
        if (res.ok) return finish(row.id, 'done', attempt, null)
        error = `HTTP ${res.status}`
      } catch (err) {
        error = (err as Error).message
      }
      if (attempt < MAX_ATTEMPTS) {
        if (stopped) return finish(row.id, 'pending', attempt, error)
        await sleep(retryDelayMs)
      }
    }
    return finish(row.id, 'failed', MAX_ATTEMPTS, error)
  }

  async function drain() {
    // The id cursor guarantees progress even if a row cannot be updated.
    let after = '0'
    while (!stopped) {
      const { rows } = await pool.query<Row>(
        `select id, method, url, headers, body from selfbase.http_queue where status = 'pending' and id > $1 order by id limit 20`,
        [after],
      )
      if (!rows.length) return
      for (const row of rows) {
        if (stopped) return
        after = row.id
        try {
          await send(row)
        } catch (err) {
          // One poisoned row must not hold up the rest of the queue.
          await finish(row.id, 'failed', 0, (err as Error).message).catch(() => {})
        }
      }
    }
  }

  // Single-flight: a kick during a drain makes it run once more instead of in parallel.
  const kick = () => {
    if (running) return void (again = true)
    running = (async () => {
      do {
        again = false
        await drain().catch((err) => console.error('netqueue:', (err as Error).message))
      } while (again && !stopped)
    })().finally(() => (running = undefined))
  }

  const listener = listen('selfbase_http', kick, kick)
  const timer = setInterval(kick, opts.scanMs ?? 30_000)
  return {
    ready: listener.ready,
    async stop() {
      stopped = true
      clearInterval(timer)
      await listener.stop()
      await running
    },
  }
}
