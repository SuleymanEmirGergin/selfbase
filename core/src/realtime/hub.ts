import pg from 'pg'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { config } from '../config.ts'
import { asUser } from '../db.ts'
import { verify } from '../jwt.ts'
import type { JwtClaims } from '../jwt.ts'

/**
 * Keeps one dedicated LISTEN connection on `channel`, reconnecting 1 s after it drops.
 * Resolves once the first LISTEN is in place; the returned stop() ends it for good.
 */
export function listen(channel: string, onPayload: (payload: string) => void, onListening?: () => void) {
  let stopped = false
  let client: pg.Client | undefined
  let timer: NodeJS.Timeout | undefined
  let firstReady: () => void
  const ready = new Promise<void>((r) => (firstReady = r))
  const connect = () => {
    const c = (client = new pg.Client(config.db))
    let dropped = false
    const retry = () => {
      if (dropped) return
      dropped = true
      c.end().catch(() => {})
      if (!stopped) timer = setTimeout(connect, 1000)
    }
    c.on('error', retry)
    c.on('end', retry)
    c.on('notification', (n) => n.channel === channel && onPayload(n.payload ?? ''))
    c.connect()
      .then(() => c.query(`listen ${pg.escapeIdentifier(channel)}`))
      .then(() => (onListening?.(), firstReady()), retry)
  }
  connect()
  const stop = async () => {
    stopped = true
    clearTimeout(timer)
    await client?.end().catch(() => {})
  }
  return { ready, stop }
}

type Sub = { schema: string; table: string; event: string; filter?: { col: string; value: string } }
type Conn = { ws: WebSocket; claims: JwtClaims; subs: Map<string, Sub>; queue: Promise<unknown>; pending: number; dropped: boolean }
type Change = { schema: string; table: string; type: 'INSERT' | 'UPDATE' | 'DELETE'; id: unknown }

const conns = new Set<Conn>()
const EVENTS = ['INSERT', 'UPDATE', 'DELETE', '*']
const FILTER = /^([A-Za-z_][A-Za-z0-9_]*)=eq\.(.*)$/s
const MAX_SUBS = 100
const MAX_PAYLOAD = 16 * 1024
const MAX_PENDING = 200
let statementTimeout = '5s'
/** Tests only: shorten the per-query timeout of the hub's queries. */
export const setStatementTimeout = (v: string) => void (statementTimeout = v)
const ident = pg.escapeIdentifier
const send = (c: Conn, msg: object) => c.ws.send(JSON.stringify(msg))
const live = (c: Conn) => c.claims.exp * 1000 > Date.now()
/** asUser with a statement timeout, so a lock or slow policy cannot stall a connection's queue. */
const asHub = <T>(claims: JwtClaims, fn: (db: pg.PoolClient) => Promise<T>) =>
  asUser(claims, async (db) => {
    await db.query(`select set_config('statement_timeout', $1, true)`, [statementTimeout])
    return fn(db)
  })
// Per-connection FIFO: a connection's messages and deliveries run one at a time, in order.
// Over MAX_PENDING queued items the client is not keeping up (or is flooding): close and drop the queue.
const enqueue = (c: Conn, fn: () => Promise<unknown>) => {
  if (c.dropped) return
  if (++c.pending > MAX_PENDING) {
    c.dropped = true
    c.subs.clear()
    conns.delete(c)
    return c.ws.close(1013, 'too many pending messages')
  }
  c.queue = c.queue
    .then(() => (c.dropped ? undefined : fn()))
    .catch(() => {})
    .finally(() => c.pending--)
}
/** eq compares as text against a non-null value; `col=eq.null` matches nothing. */
const matches = (row: Record<string, unknown>, f?: Sub['filter']) => {
  if (!f) return true
  const v = row[f.col]
  return v != null && (typeof v === 'object' ? JSON.stringify(v) : String(v)) === f.value
}

async function onMessage(c: Conn, raw: string) {
  let m: any
  try {
    m = JSON.parse(raw)
  } catch {
    return send(c, { type: 'error', ref: null, message: 'invalid JSON' })
  }
  const ref = m?.ref ?? null
  if (m?.type === 'ping') return send(c, { type: 'pong' })
  if (m?.type === 'unsubscribe') return c.subs.delete(ref)
  if (m?.type === 'auth') {
    try {
      c.claims = await verify(String(m.token))
    } catch {
      c.ws.close(4401, 'invalid token')
    }
    return
  }
  if (m?.type !== 'subscribe') return send(c, { type: 'error', ref, message: 'unknown message type' })
  const schema = m.schema ?? 'public'
  const f = m.filter === undefined ? undefined : FILTER.exec(String(m.filter))
  if (typeof ref !== 'string' || typeof schema !== 'string' || typeof m.table !== 'string' || !EVENTS.includes(m.event) || f === null)
    return send(c, { type: 'error', ref, message: 'invalid subscription (only eq filters are supported)' })
  if (!c.subs.has(ref) && c.subs.size >= MAX_SUBS)
    return send(c, { type: 'error', ref, message: `at most ${MAX_SUBS} subscriptions per connection` })
  try {
    // Fails early on a missing table or filter column, or no SELECT grant, as the subscriber's own role.
    await asHub(c.claims, (db) => db.query(`select ${f ? ident(f[1]) : ''} from ${ident(schema)}.${ident(m.table)} limit 0`))
  } catch (err) {
    return send(c, { type: 'error', ref, message: (err as Error).message })
  }
  c.subs.set(ref, { schema, table: m.table, event: m.event, filter: f ? { col: f[1], value: f[2] } : undefined })
  send(c, { type: 'subscribed', ref })
}

// shortcut: one query per subscribed connection per change; batch by identical claims when a table exceeds ~100 subscribers
// refs are snapshotted when the change arrives; an unsubscribe queued before it may have run since.
const current = (c: Conn, ref: string, sub: Sub) => c.subs.get(ref) === sub
/** Re-reads the changed row once for this connection and sends it to each of its matching refs. */
async function deliver(c: Conn, refs: [string, Sub][], ch: Change) {
  if (!live(c)) return
  const base = { type: 'change', eventType: ch.type, schema: ch.schema, table: ch.table, commit_timestamp: new Date().toISOString() }
  if (ch.type === 'DELETE') {
    // The row is gone so RLS cannot be asked; only service_role may learn the id.
    if (c.claims.role !== 'service_role') return
    for (const [ref, sub] of refs) if (current(c, ref, sub) && matches({ id: ch.id }, sub.filter)) send(c, { ...base, ref, new: {}, old: { id: ch.id } })
    return
  }
  const claims = c.claims
  const row = await asHub(claims, async (db) =>
    (await db.query(`select to_jsonb(t) as r from ${ident(ch.schema)}.${ident(ch.table)} t where id = $1`, [ch.id])).rows[0]?.r,
  ).catch(() => undefined)
  if (!row || !live(c) || c.claims !== claims || c.ws.readyState !== c.ws.OPEN) return
  for (const [ref, sub] of refs) if (current(c, ref, sub) && matches(row, sub.filter)) send(c, { ...base, ref, new: row, old: {} })
}

function onChange(payload: string) {
  let ch: Change
  try {
    ch = JSON.parse(payload)
  } catch {
    return
  }
  for (const c of conns) {
    const refs = [...c.subs].filter(([, s]) => s.schema === ch.schema && s.table === ch.table && (s.event === '*' || s.event === ch.type))
    if (refs.length) enqueue(c, () => deliver(c, refs, ch))
  }
}

let wss: WebSocketServer | undefined
let listener: ReturnType<typeof listen> | undefined
let detach: (() => void) | undefined

/** Serves GET /realtime/v1 (WebSocket upgrade, token in ?token=) on server; resolves once LISTEN is up. */
export function startHub(server: Server): Promise<void> {
  const ws = (wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD }))
  const onUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    const url = new URL(req.url ?? '/', 'http://x')
    // core serves no other WebSocket endpoint, so any other upgrade path is refused outright.
    if (url.pathname !== '/realtime/v1') return socket.destroy()
    let claims: JwtClaims
    try {
      claims = await verify(url.searchParams.get('token') ?? '')
    } catch {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    if (socket.destroyed) return
    ws.handleUpgrade(req, socket, head, (sock) => {
      const c: Conn = { ws: sock, claims, subs: new Map(), queue: Promise.resolve(), pending: 0, dropped: false }
      conns.add(c)
      // Bad frames (unmasked, bad UTF-8, over maxPayload) surface here; with no listener they crash core.
      sock.on('error', () => sock.terminate())
      sock.on('message', (d) => enqueue(c, () => onMessage(c, String(d))))
      sock.on('close', () => conns.delete(c))
    })
  }
  server.on('upgrade', onUpgrade)
  detach = () => server.off('upgrade', onUpgrade)
  listener = listen('selfbase_changes', onChange)
  return listener.ready
}

/** Closes every socket and the LISTEN connection, and detaches from the server (tests, shutdown). */
export async function stopHub(): Promise<void> {
  detach?.()
  for (const c of conns) c.ws.terminate()
  conns.clear()
  wss?.close()
  await listener?.stop()
}
