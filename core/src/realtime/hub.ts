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
type Conn = { ws: WebSocket; claims: JwtClaims; subs: Map<string, Sub> }
type Change = { schema: string; table: string; type: 'INSERT' | 'UPDATE' | 'DELETE'; id: unknown }

const conns = new Set<Conn>()
const EVENTS = ['INSERT', 'UPDATE', 'DELETE', '*']
const FILTER = /^([A-Za-z_][A-Za-z0-9_]*)=eq\.(.*)$/s
const send = (c: Conn, msg: object) => c.ws.send(JSON.stringify(msg))
const live = (c: Conn) => c.claims.exp * 1000 > Date.now()

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
      send(c, { type: 'error', ref, message: 'invalid token' })
    }
    return
  }
  if (m?.type !== 'subscribe') return send(c, { type: 'error', ref, message: 'unknown message type' })
  const schema = m.schema ?? 'public'
  const f = m.filter === undefined ? undefined : FILTER.exec(String(m.filter))
  if (typeof ref !== 'string' || typeof schema !== 'string' || typeof m.table !== 'string' || !EVENTS.includes(m.event) || f === null)
    return send(c, { type: 'error', ref, message: 'invalid subscription (only eq filters are supported)' })
  try {
    // Fails early on a missing table or no SELECT grant, as the subscriber's own role.
    await asUser(c.claims, (db) => db.query(`select from ${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(m.table)} limit 0`))
  } catch (err) {
    return send(c, { type: 'error', ref, message: (err as Error).message })
  }
  c.subs.set(ref, { schema, table: m.table, event: m.event, filter: f ? { col: f[1], value: f[2] } : undefined })
  send(c, { type: 'subscribed', ref })
}

// shortcut: one query per subscriber per change; batch by identical claims when a table exceeds ~100 subscribers
async function deliver(c: Conn, ref: string, sub: Sub, ch: Change) {
  if (!live(c)) return
  const base = { type: 'change', ref, eventType: ch.type, schema: ch.schema, table: ch.table, commit_timestamp: new Date().toISOString() }
  if (ch.type === 'DELETE') {
    // The row is gone so RLS cannot be asked; only service_role may learn the id.
    if (c.claims.role !== 'service_role') return
    if (sub.filter && (sub.filter.col !== 'id' || String(ch.id) !== sub.filter.value)) return
    return send(c, { ...base, new: {}, old: { id: ch.id } })
  }
  const claims = c.claims
  const row = await asUser(claims, async (db) =>
    (await db.query(`select to_jsonb(t) as r from ${pg.escapeIdentifier(ch.schema)}.${pg.escapeIdentifier(ch.table)} t where id = $1`, [ch.id]))
      .rows[0]?.r,
  ).catch(() => undefined)
  if (!row || !live(c) || c.claims !== claims || c.ws.readyState !== c.ws.OPEN) return
  if (sub.filter && String(row[sub.filter.col]) !== sub.filter.value) return
  send(c, { ...base, new: row, old: {} })
}

function onChange(payload: string) {
  let ch: Change
  try {
    ch = JSON.parse(payload)
  } catch {
    return
  }
  for (const c of conns)
    for (const [ref, sub] of c.subs)
      if (sub.schema === ch.schema && sub.table === ch.table && (sub.event === '*' || sub.event === ch.type))
        void deliver(c, ref, sub, ch).catch(() => {})
}

let wss: WebSocketServer | undefined
let listener: ReturnType<typeof listen> | undefined

/** Serves GET /realtime/v1 (WebSocket upgrade, token in ?token=) on server; resolves once LISTEN is up. */
export function startHub(server: Server): Promise<void> {
  const ws = (wss = new WebSocketServer({ noServer: true }))
  server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname !== '/realtime/v1') return socket.destroy()
    let claims: JwtClaims
    try {
      claims = await verify(url.searchParams.get('token') ?? '')
    } catch {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    ws.handleUpgrade(req, socket, head, (sock) => {
      const c: Conn = { ws: sock, claims, subs: new Map() }
      conns.add(c)
      sock.on('message', (d) => void onMessage(c, String(d)).catch(() => {}))
      sock.on('close', () => conns.delete(c))
    })
  })
  listener = listen('selfbase_changes', onChange)
  return listener.ready
}

/** Closes every socket and the LISTEN connection (tests, shutdown). */
export async function stopHub(): Promise<void> {
  for (const c of conns) c.ws.terminate()
  conns.clear()
  wss?.close()
  await listener?.stop()
}
