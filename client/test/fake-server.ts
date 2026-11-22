// In-process stand-in for selfbase core, implementing the auth (Task 2/3), storage (Task 4), realtime (Task 5)
// and functions (Task 9) contracts as their briefs state them. /rest/v1 is proxied to the real test PostgREST.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { REST_URL, signJwt } from './helpers.ts'

interface FakeUser {
  id: string
  email: string
  password: string
  confirmed: boolean
  user_metadata: Record<string, unknown>
  phone: string
}

interface RtConn {
  ws: WebSocket
  token: string
  subs: Map<string, { table: string; event: string; filter?: string }>
  received: any[]
}

export interface FakeServer {
  url: string
  requests: { method: string; path: string; headers: IncomingMessage['headers']; body: string }[]
  settings: { confirmEmail: boolean; expiresIn: number; failRefresh: boolean; refreshErrors: number[]; phoneEnabled: boolean; pong: boolean; ack: boolean }
  users: Map<string, FakeUser>
  objects: Map<string, { body: Buffer; contentType: string }>
  rt: {
    conns: RtConn[]
    emit(table: string, eventType: string, row: Record<string, unknown>): void
    dropAll(code?: number): void
    flushAcks(): void
  }
  close(): Promise<void>
}

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
const authErr = (res: ServerResponse, status: number, error_code: string, msg: string) => json(res, status, { code: status, error_code, msg })
const storageErr = (res: ServerResponse, status: number, error: string, message: string) =>
  json(res, status, { statusCode: String(status), error, message })

const claimsOf = (header?: string) => {
  const token = header?.replace(/^Bearer /, '')
  if (!token) return null
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  } catch {
    return null
  }
}

export async function startFakeServer(): Promise<FakeServer> {
  const settings = { confirmEmail: false, expiresIn: 3600, failRefresh: false, refreshErrors: [] as number[], phoneEnabled: false, pong: true, ack: true }
  const users = new Map<string, FakeUser>()
  const refreshTokens = new Map<string, { userId: string; used: boolean }>()
  const objects = new Map<string, { body: Buffer; contentType: string }>()
  const publicBuckets = new Set(['public-bucket'])
  const requests: FakeServer['requests'] = []

  const userJson = (u: FakeUser) => ({
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    phone: u.phone,
    email_confirmed_at: u.confirmed ? '2026-11-22T00:00:00Z' : null,
    phone_confirmed_at: null,
    confirmed_at: u.confirmed ? '2026-11-22T00:00:00Z' : null,
    last_sign_in_at: null,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: u.user_metadata,
    identities: [{ id: u.id, user_id: u.id, identity_id: u.id, provider: 'email', identity_data: { email: u.email } }],
    created_at: '2026-11-22T00:00:00Z',
    updated_at: '2026-11-22T00:00:00Z',
  })

  const issueSession = (u: FakeUser) => {
    const refresh_token = randomBytes(16).toString('hex')
    refreshTokens.set(refresh_token, { userId: u.id, used: false })
    const access_token = signJwt(
      { sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email, session_id: randomUUID(), app_metadata: {}, user_metadata: u.user_metadata },
      settings.expiresIn,
    )
    return {
      access_token,
      token_type: 'bearer',
      expires_in: settings.expiresIn,
      expires_at: Math.floor(Date.now() / 1000) + settings.expiresIn,
      refresh_token,
      user: userJson(u),
    }
  }

  const userFromAuth = (req: IncomingMessage) => {
    const c = claimsOf(req.headers.authorization)
    return c?.sub ? users.get(c.sub) ?? null : null
  }

  async function auth(req: IncomingMessage, res: ServerResponse, path: string, url: URL, body: any) {
    const m = req.method
    if (m === 'POST' && path === '/signup') {
      const existing = [...users.values()].find((u) => u.email === body.email)
      if (existing) return json(res, 200, { ...userJson(existing), id: randomUUID(), identities: [] })
      if (String(body.password ?? '').length < 6) return authErr(res, 422, 'weak_password', 'Password should be at least 6 characters.')
      const u: FakeUser = { id: randomUUID(), email: body.email, password: body.password, confirmed: !settings.confirmEmail, user_metadata: body.data ?? {}, phone: '' }
      users.set(u.id, u)
      return json(res, 200, settings.confirmEmail ? userJson(u) : issueSession(u))
    }
    if (m === 'POST' && path === '/token') {
      const grant = url.searchParams.get('grant_type')
      if (grant === 'password') {
        const u = [...users.values()].find((x) => x.email === body.email)
        if (!u || u.password !== body.password) return authErr(res, 400, 'invalid_credentials', 'Invalid login credentials')
        if (!u.confirmed) return authErr(res, 400, 'email_not_confirmed', 'Email not confirmed')
        return json(res, 200, issueSession(u))
      }
      if (grant === 'refresh_token') {
        const status = settings.refreshErrors.shift()
        if (status) return authErr(res, status, 'unexpected_failure', 'transient failure')
        const rt = refreshTokens.get(body.refresh_token)
        if (settings.failRefresh || !rt || rt.used) return authErr(res, 400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used')
        rt.used = true
        return json(res, 200, issueSession(users.get(rt.userId)!))
      }
    }
    if (path === '/user') {
      const u = userFromAuth(req)
      if (!u) return authErr(res, 403, 'bad_jwt', 'invalid JWT')
      if (m === 'GET') return json(res, 200, userJson(u))
      if (m === 'PUT') {
        if (body.phone !== undefined && !settings.phoneEnabled) return authErr(res, 422, 'phone_provider_disabled', 'Phone provider is disabled')
        if (body.data) u.user_metadata = { ...u.user_metadata, ...body.data }
        if (body.password) u.password = body.password
        return json(res, 200, userJson(u))
      }
    }
    if (m === 'POST' && path === '/logout') {
      if (!userFromAuth(req)) return authErr(res, 401, 'no_authorization', 'no session')
      res.writeHead(204).end()
      return
    }
    if (m === 'POST' && ['/otp', '/recover', '/resend'].includes(path)) return json(res, 200, {})
    if (m === 'POST' && path === '/verify') {
      // core: email links use GET /verify; phone_change needs the signed-in owner
      if (body.type !== 'phone_change') return authErr(res, 400, 'validation_failed', 'Only type phone_change is supported')
      if (!settings.phoneEnabled) return authErr(res, 422, 'phone_provider_disabled', 'Phone provider is disabled')
      if (!userFromAuth(req)) return authErr(res, 401, 'no_authorization', 'This endpoint requires a signed-in user')
      return authErr(res, 403, 'otp_expired', 'Token has expired or is invalid')
    }
    if (m === 'GET' && path === '/authorize') {
      res.writeHead(302, { location: 'https://accounts.example.test/o/oauth2' }).end()
      return
    }
    if (path.startsWith('/admin/users')) {
      if (claimsOf(req.headers.authorization)?.role !== 'service_role') return authErr(res, 403, 'not_admin', 'User not allowed')
      if (m === 'GET') {
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
        const perPage = Math.max(1, Number(url.searchParams.get('per_page')) || 50)
        const all = [...users.values()]
        return json(res, 200, { users: all.slice((page - 1) * perPage, page * perPage).map(userJson), aud: 'authenticated' }, { 'x-total-count': String(all.length) })
      }
      const id = path.split('/')[3]
      const u = users.get(id)
      if (m === 'DELETE') {
        if (!u) return authErr(res, 404, 'user_not_found', 'User not found')
        users.delete(id)
        return json(res, 200, {})
      }
    }
    return authErr(res, 404, 'not_found', `no route ${m} ${path}`)
  }

  async function storage(req: IncomingMessage, res: ServerResponse, path: string, url: URL, raw: Buffer) {
    const m = req.method
    const body = () => JSON.parse(raw.toString() || '{}')
    let match: RegExpMatchArray | null
    if (m === 'POST' && (match = path.match(/^\/object\/sign\/([^/]+)\/(.+)$/))) {
      const key = `${match[1]}/${match[2]}`
      if (!objects.has(key)) return storageErr(res, 400, 'not_found', 'Object not found')
      const encoded = [match[1], ...match[2].split('/')].map(encodeURIComponent).join('/')
      return json(res, 200, { signedURL: `/object/sign/${encoded}?token=${signJwt({ url: key }, body().expiresIn)}` })
    }
    if (m === 'GET' && (match = path.match(/^\/object\/sign\/([^/]+)\/(.+)$/))) {
      const obj = objects.get(`${match[1]}/${match[2]}`)
      if (!obj || !url.searchParams.get('token')) return storageErr(res, 400, 'InvalidSignature', 'bad token')
      res.writeHead(200, { 'content-type': obj.contentType }).end(obj.body)
      return
    }
    if (m === 'POST' && (match = path.match(/^\/object\/list\/([^/]+)$/))) {
      const { prefix = '' } = body()
      const names = [...objects.keys()].filter((k) => k.startsWith(`${match![1]}/${prefix}`)).map((k) => ({ name: k.slice(match![1].length + 1 + prefix.length).replace(/^\//, ''), id: k }))
      return json(res, 200, names)
    }
    if (m === 'GET' && (match = path.match(/^\/object\/(public|authenticated)\/([^/]+)\/(.+)$/))) {
      if (match[1] === 'public' && !publicBuckets.has(match[2])) return storageErr(res, 400, 'not_found', 'Bucket not public')
      if (match[1] === 'authenticated' && !claimsOf(req.headers.authorization)?.sub) return storageErr(res, 400, 'not_found', 'Object not found')
      const obj = objects.get(`${match[2]}/${match[3]}`)
      if (!obj) return storageErr(res, 400, 'not_found', 'Object not found')
      res.writeHead(200, { 'content-type': obj.contentType }).end(obj.body)
      return
    }
    if (m === 'POST' && (match = path.match(/^\/object\/([^/]+)\/(.+)$/))) {
      const key = `${match[1]}/${match[2]}`
      if (objects.has(key) && req.headers['x-upsert'] !== 'true') return storageErr(res, 409, 'Duplicate', 'The resource already exists')
      objects.set(key, { body: raw, contentType: String(req.headers['content-type'] ?? 'application/octet-stream') })
      return json(res, 200, { Key: key, Id: randomUUID() })
    }
    if (m === 'DELETE' && (match = path.match(/^\/object\/([^/]+)$/))) {
      const removed = (body().prefixes as string[]).filter((p) => objects.delete(`${match![1]}/${p}`)).map((name) => ({ name, bucket_id: match![1] }))
      return json(res, 200, removed)
    }
    return storageErr(res, 404, 'not_found', `no route ${m} ${path}`)
  }

  function functions(req: IncomingMessage, res: ServerResponse, path: string, raw: Buffer) {
    const name = path.split('/')[1]
    if (name === 'fail') return json(res, 500, { error: 'boom' })
    if (name === 'text') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello')
      return
    }
    return json(res, 200, { method: req.method, authorization: req.headers.authorization, apikey: req.headers.apikey, contentType: req.headers['content-type'] ?? null, body: raw.toString() })
  }

  async function proxyRest(req: IncomingMessage, res: ServerResponse, rest: string, raw: Buffer) {
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'content-length') headers.set(k, v)
    const r = await fetch(REST_URL + rest, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : new Uint8Array(raw) })
    const out: Record<string, string> = {}
    r.headers.forEach((v, k) => (out[k] = v))
    delete out['content-encoding']
    delete out['content-length']
    res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()))
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fake')
    const raw = await readBody(req)
    requests.push({ method: req.method!, path: url.pathname + url.search, headers: req.headers, body: raw.toString() })
    const p = url.pathname
    try {
      if (p.startsWith('/auth/v1')) {
        let body: any = {}
        try {
          body = JSON.parse(raw.toString() || '{}')
        } catch {
          // ignore
        }
        return await auth(req, res, p.slice(8), url, body)
      }
      if (p.startsWith('/storage/v1')) return await storage(req, res, p.slice(11).split('/').map(decodeURIComponent).join('/'), url, raw)
      if (p.startsWith('/functions/v1')) return functions(req, res, p.slice(13), raw)
      if (p.startsWith('/rest/v1')) return await proxyRest(req, res, p.slice(8) + url.search, raw)
      json(res, 404, { error: 'not found' })
    } catch (e) {
      json(res, 500, { error: String(e) })
    }
  })

  const conns: RtConn[] = []
  const pendingAcks: (() => void)[] = []
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, 'http://fake')
    if (url.pathname !== '/realtime/v1') return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: RtConn = { ws, token: url.searchParams.get('token') ?? '', subs: new Map(), received: [] }
      conns.push(conn)
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data))
        conn.received.push(msg)
        if (msg.type === 'subscribe') {
          conn.subs.set(msg.ref, { table: msg.table, event: msg.event, filter: msg.filter })
          if (settings.ack) ws.send(JSON.stringify({ type: 'subscribed', ref: msg.ref }))
          else pendingAcks.push(() => ws.send(JSON.stringify({ type: 'subscribed', ref: msg.ref })))
        } else if (msg.type === 'unsubscribe') conn.subs.delete(msg.ref)
        else if (msg.type === 'auth') conn.token = msg.token
        else if (msg.type === 'ping' && settings.pong) ws.send(JSON.stringify({ type: 'pong' }))
      })
      ws.on('close', () => conns.splice(conns.indexOf(conn), 1))
    })
  })

  const rt = {
    conns,
    emit(table: string, eventType: string, row: Record<string, unknown>) {
      for (const c of conns)
        for (const [ref, s] of c.subs) {
          if (s.table !== table || (s.event !== '*' && s.event !== eventType)) continue
          if (s.filter) {
            const [col, val] = s.filter.split('=eq.')
            if (String(row[col]) !== val) continue
          }
          c.ws.send(JSON.stringify({ type: 'change', ref, eventType, schema: 'public', table, new: row, old: {}, commit_timestamp: new Date().toISOString() }))
        }
    },
    /** Without a code the socket is killed (network drop); with one it is closed cleanly with that code. */
    dropAll(code?: number) {
      for (const c of [...conns]) code ? c.ws.close(code, 'test') : c.ws.terminate()
    },
    flushAcks() {
      for (const send of pendingAcks.splice(0)) send()
    },
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    settings,
    users,
    objects,
    rt,
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate()
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
