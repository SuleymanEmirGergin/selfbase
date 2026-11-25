// Cross-cutting server guards: pool resilience, the gateway's IP headers and response headers, REST exposure and
// query guards, auth rate limits, body limit, health, config parsing, queue upkeep and the upgrade SQL.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import pg from 'pg'
import { adminApp, app } from '../src/app.ts'
import { asUser, pool } from '../src/db.ts'
import { config } from '../src/config.ts'
import { sign } from '../src/jwt.ts'
import { resetRateLimits, take } from '../src/auth/ratelimit.ts'
import { smtpOptions } from '../src/auth/mail.ts'
import { pruneQueue } from '../src/netqueue/worker.ts'

const anonKey = process.env.ANON_KEY!
const serviceKey = process.env.SERVICE_ROLE_KEY!
const restUrl = `http://localhost:${process.env.TEST_REST_PORT ?? '54330'}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const savedEnv = { trust: process.env.TRUST_PROXY }
afterEach(() => {
  process.env.TRUST_PROXY = savedEnv.trust
})

describe('database pools', () => {
  it('a terminated backend does not crash core and the next query works', async () => {
    const pids = new Set<number>()
    const grab = () => pool.query('select pg_backend_pid() as pid, pg_sleep(0.05)').then((r) => pids.add(r.rows[0].pid))
    await Promise.all([grab(), grab(), grab()])
    await Promise.all([1, 2].map(() =>
      asUser(null, (db) => db.query('select pg_backend_pid() as pid, pg_sleep(0.05)')).then((r) => pids.add(r.rows[0].pid))))
    const killer = new pg.Client({ ...config.db })
    await killer.connect()
    await killer.query('select pg_terminate_backend(p) from unnest($1::int[]) p', [[...pids]])
    await killer.end()
    await sleep(300) // idle clients see the termination and emit 'error' on their pool
    expect((await pool.query('select 1 as ok')).rows[0].ok).toBe(1)
    expect((await asUser(null, (db) => db.query('select 1 as ok'))).rows[0].ok).toBe(1)
  })
})

describe('gateway', () => {
  let upstream: Server
  let seen: Record<string, string | string[] | undefined> = {}
  let reply: { type: string; csp?: string } = { type: 'text/html' }
  const saved = { rest: config.pgrstUrl, fn: config.fnUrl }
  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen = req.headers
      res.writeHead(200, { 'content-type': reply.type, ...(reply.csp ? { 'content-security-policy': reply.csp } : {}) })
      res.end('<script>fetch("/admin/sql")</script>')
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
    config.pgrstUrl = url
    config.fnUrl = url
  })
  afterAll(async () => {
    Object.assign(config, { pgrstUrl: saved.rest, fnUrl: saved.fn })
    await new Promise((r) => upstream.close(r))
  })
  const spoofed = {
    'x-forwarded-for': '6.6.6.6, 203.0.113.7',
    'x-real-ip': '6.6.6.6',
    'cf-connecting-ip': '6.6.6.6',
    'true-client-ip': '6.6.6.6',
    forwarded: 'for=6.6.6.6',
  }

  for (const path of ['/rest/v1/items', '/functions/v1/hello']) {
    it(`${path}: client IP headers are replaced by the trusted IP (rightmost X-Forwarded-For behind a proxy)`, async () => {
      process.env.TRUST_PROXY = 'true'
      await app.request(path, { headers: spoofed })
      expect(seen['x-forwarded-for']).toBe('203.0.113.7')
      expect(seen['x-real-ip']).toBe('203.0.113.7')
      expect(seen['cf-connecting-ip']).toBe('203.0.113.7')
      expect(seen['true-client-ip']).toBeUndefined()
      expect(seen.forwarded).toBeUndefined()
    })

    it(`${path}: without TRUST_PROXY the socket address is used and X-Forwarded-For is ignored`, async () => {
      process.env.TRUST_PROXY = 'false'
      await app.request(path, { headers: spoofed }, { incoming: { socket: { remoteAddress: '198.51.100.9' } } })
      expect(seen['x-forwarded-for']).toBe('198.51.100.9')
      expect(seen['cf-connecting-ip']).toBe('198.51.100.9')
      expect(seen['x-real-ip']).toBe('198.51.100.9')
    })
  }

  it('function responses are nosniff and sandboxed unless the function sets its own CSP', async () => {
    reply = { type: 'text/html' }
    const res = await app.request('/functions/v1/hello')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
    reply = { type: 'text/html', csp: "default-src 'self'" }
    const own = await app.request('/functions/v1/hello')
    expect(own.headers.get('content-security-policy')).toBe("default-src 'self'")
    expect(own.headers.get('x-content-type-options')).toBe('nosniff')
    // PostgREST responses are left alone
    reply = { type: 'text/html' }
    expect((await app.request('/rest/v1/items')).headers.get('content-security-policy')).toBeNull()
  })

  for (const path of ['/rest/v1/redirect', '/functions/v1/redirect']) {
    it(`${path}: an upstream redirect reaches the client as it is and core never follows it`, async () => {
      let hits = 0
      const target = createServer((_req, res) => {
        hits++
        res.end('inside')
      })
      await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
      const location = `http://127.0.0.1:${(target.address() as { port: number }).port}/private`
      const relay = upstream.listeners('request')[0] as (...a: unknown[]) => void
      upstream.removeAllListeners('request')
      upstream.on('request', (_req, res) => {
        res.writeHead(302, { location })
        res.end()
      })
      try {
        const res = await app.request(path)
        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe(location)
        expect(hits).toBe(0)
      } finally {
        upstream.removeAllListeners('request')
        upstream.on('request', relay)
        await new Promise((r) => target.close(r))
      }
    })
  }

  it('there is no /panel any more', async () => {
    expect((await app.request('/panel')).status).toBe(404)
  })
})

describe('PostgREST exposure and query guards', () => {
  const rest = (path: string, key: string, headers: Record<string, string> = {}) =>
    fetch(`${restUrl}${path}`, { headers: { apikey: key, authorization: `Bearer ${key}`, ...headers } })
  beforeAll(async () => {
    await pool.query(`
      drop table if exists public.t_many; create table public.t_many (id int primary key);
      insert into public.t_many select generate_series(1, 1005);
      create or replace function public.t_timeout() returns text language sql as $$ select current_setting('statement_timeout') $$;
      notify pgrst, 'reload schema';`)
    for (let i = 0; i < 50 && (await rest('/t_many?limit=1', serviceKey)).status !== 200; i++) await sleep(100)
  })
  afterAll(async () => {
    await pool.query('drop table if exists public.t_many; drop function if exists public.t_timeout(); notify pgrst, \'reload schema\';')
  })

  it('the storage schema is not reachable over REST, directly or through the gateway', async () => {
    const direct = await rest('/buckets', serviceKey, { 'accept-profile': 'storage' })
    expect(direct.status).toBe(406)
    expect((await direct.json()).code).toBe('PGRST106')
    const viaCore = await app.request('/rest/v1/objects', {
      method: 'PATCH',
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-profile': 'storage', 'content-type': 'application/json' },
      body: '{"name":"x"}',
    })
    expect(viaCore.status).toBe(406)
  })

  it('returns at most 1000 rows per request', async () => {
    const rows = await (await rest('/t_many?select=id', serviceKey)).json()
    expect(rows.length).toBe(1000)
  })

  it('PostgREST runs anon with a 3 s and authenticated with an 8 s statement timeout; core asUser is not affected', async () => {
    expect(await (await rest('/rpc/t_timeout', anonKey)).json()).toBe('3s')
    const user = await sign({ sub: randomUUID(), role: 'authenticated' }, 60)
    expect(await (await rest('/rpc/t_timeout', user)).json()).toBe('8s')
    // storage and realtime work through asUser(): role switched with set_config, so the role setting does not apply
    const t = await asUser(null, (db) => db.query(`select current_setting('statement_timeout') as t`))
    expect(t.rows[0].t).toBe('0')
  })
})

describe('auth rate limits', () => {
  const saved = structuredClone(config.authRateLimits)
  afterEach(() => {
    Object.assign(config.authRateLimits, saved)
    resetRateLimits()
  })
  const from = (ip: string) => ({ 'x-forwarded-for': ip, 'content-type': 'application/json', apikey: anonKey })
  const post = (path: string, ip: string, body: unknown) =>
    app.request(`/auth/v1${path}`, { method: 'POST', headers: from(ip), body: JSON.stringify(body) })

  it('sign-in and sign-up share one per-IP bucket; over it is 429 over_request_rate_limit', async () => {
    process.env.TRUST_PROXY = 'true'
    config.authRateLimits.signIn = 3
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`
    expect((await post('/signup', ip, { email: `r-${randomUUID()}@example.test`, password: 'secret123' })).status).toBe(200)
    expect((await post('/token?grant_type=password', ip, { email: 'nobody@example.test', password: 'x' })).status).toBe(400)
    expect((await post('/token?grant_type=password', ip, { email: 'nobody@example.test', password: 'x' })).status).toBe(400)
    const over = await post('/token?grant_type=password', ip, { email: 'nobody@example.test', password: 'x' })
    expect(over.status).toBe(429)
    expect(await over.json()).toEqual({ code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' })
    // another IP and another bucket (refresh) are unaffected
    expect((await post('/token?grant_type=password', '198.51.100.1', { email: 'nobody@example.test', password: 'x' })).status).toBe(400)
    expect((await post('/token?grant_type=refresh_token', ip, { refresh_token: 'nope' })).status).toBe(400)
  })

  it('verify (both verbs), refresh and the mail endpoints have their own limits', async () => {
    process.env.TRUST_PROXY = 'true'
    Object.assign(config.authRateLimits, { verify: 2, refresh: 1, email: 2 })
    const ip = '192.0.2.44'
    expect((await app.request('/auth/v1/verify?type=signup&token=x', { headers: from(ip) })).status).toBe(302)
    expect((await post('/verify', ip, {})).status).not.toBe(429)
    expect((await app.request('/auth/v1/verify?type=signup&token=x', { headers: from(ip) })).status).toBe(429)
    expect((await post('/token?grant_type=refresh_token', ip, { refresh_token: 'nope' })).status).toBe(400)
    expect((await post('/token?grant_type=refresh_token', ip, { refresh_token: 'nope' })).status).toBe(429)
    expect((await post('/recover', ip, { email: 'nobody@example.test' })).status).toBe(200)
    expect((await post('/otp', ip, { email: 'nobody@example.test', create_user: false })).status).toBe(200)
    expect((await post('/resend', ip, { type: 'signup', email: 'nobody@example.test' })).status).toBe(429)
  })

  it('0 disables a limit; a window ends after 5 minutes and old entries are pruned', () => {
    config.authRateLimits.verify = 0
    for (let i = 0; i < 100; i++) expect(take('verify', 'x')).toBe(true)
    config.authRateLimits.verify = 1
    const t0 = Date.now()
    expect(take('verify', 'y', t0)).toBe(true)
    expect(take('verify', 'y', t0 + 1000)).toBe(false)
    expect(take('verify', 'y', t0 + 5 * 60_000)).toBe(true)
  })
})

describe('limits and health', () => {
  it('core JSON routes refuse bodies over 1 MiB; admin file uploads are not capped by it', async () => {
    const big = JSON.stringify({ email: 'a@example.test', password: 'x'.repeat(1024 * 1024 + 10) })
    const res = await app.request('/auth/v1/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })
    expect(res.status).toBe(413)
    const authorization = `Bearer ${process.env.ADMIN_TOKEN}`
    expect((await adminApp.request('/admin/sql', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: big })).status).toBe(413)
    const upload = await adminApp.request(`/admin/files/no-such-bucket-${randomUUID()}/x.bin`, { method: 'POST', headers: { authorization }, body: big })
    expect(upload.status).not.toBe(413) // reaches the bucket lookup, not the 1 MiB limit
    expect(upload.status).toBeLessThan(500)
  })

  it('the storage JSON routes refuse bodies over 1 MiB with the storage 413', async () => {
    const big = JSON.stringify({ expiresIn: 60, prefixes: ['x'], prefix: 'x'.repeat(1024 * 1024) })
    const headers = { apikey: anonKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }
    for (const [method, path] of [['POST', '/storage/v1/object/sign/no-bucket/x.txt'], ['POST', '/storage/v1/object/list/no-bucket'],
      ['DELETE', '/storage/v1/object/no-bucket']]) {
      const res = await app.request(path, { method, headers, body: big })
      expect(res.status, `${method} ${path}`).toBe(413)
      expect(await res.json()).toEqual({ statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' })
    }
  })

  it('the /rest/v1 and /functions/v1 forwards refuse bodies over 20 MiB, declared or chunked', async () => {
    const cap = 20 * 1024 * 1024
    // an upstream that reads the whole body before it answers, as PostgREST and the functions do
    const up = createServer((req, res) => {
      req.on('error', () => {}) // core aborts an over-cap chunked body mid-stream
      req.resume().on('end', () => res.end('ok'))
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const saved = { rest: config.pgrstUrl, fn: config.fnUrl }
    config.pgrstUrl = config.fnUrl = `http://127.0.0.1:${(up.address() as { port: number }).port}`
    const chunked = (n: number) => new ReadableStream<Uint8Array>({
      pull(ctl) {
        const k = Math.min(n, 1024 * 1024)
        if (!k) return ctl.close()
        n -= k
        ctl.enqueue(new Uint8Array(k))
      },
    })
    const send = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
      app.request(path, { method: 'POST', headers, body, duplex: 'half' } as RequestInit)
    try {
      for (const path of ['/rest/v1/items', '/functions/v1/hello']) {
        const declared = await send(path, new Uint8Array(cap + 1), { 'content-length': String(cap + 1) })
        expect(declared.status, `${path} declared`).toBe(413)
        expect(await declared.json()).toEqual({ error: 'request body too large' })
        const streamed = await send(path, chunked(cap + 1))
        expect(streamed.status, `${path} chunked`).toBe(413)
        expect(await streamed.json()).toEqual({ error: 'request body too large' })
        expect((await send(path, chunked(cap))).status, `${path} at the cap`).toBe(200)
      }
    } finally {
      Object.assign(config, { pgrstUrl: saved.rest, fnUrl: saved.fn })
      await new Promise((r) => up.close(r))
    }
  })

  it('AUTH_DISABLE_SIGNUP answers 422 signup_disabled and creates no user', async () => {
    const saved = config.authDisableSignup
    config.authDisableSignup = true
    const email = `nosignup-${randomUUID()}@example.test`
    try {
      const res = await app.request('/auth/v1/signup', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password-1' }),
      })
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ code: 422, error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' })
    } finally {
      config.authDisableSignup = saved
    }
    expect((await pool.query('select 1 from auth.users where email = $1', [email])).rowCount).toBe(0)
  })

  it('AUTH_DISABLE_SIGNUP also refuses /otp creating a new user; a known address still gets its link', async () => {
    const saved = config.authDisableSignup
    config.authDisableSignup = true
    const otp = (body: object) => app.request('/auth/v1/otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const email = `nootp-${randomUUID()}@example.test`
    const known = `known-${randomUUID()}@example.test`
    await pool.query(`insert into auth.users (id, email, email_confirmed_at) values (gen_random_uuid(), $1, now())`, [known])
    try {
      const res = await otp({ email })
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ code: 422, error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' })
      expect((await otp({ email, create_user: false })).status).toBe(200)
      expect((await otp({ email: known })).status).toBe(200)
    } finally {
      config.authDisableSignup = saved
    }
    expect((await pool.query('select 1 from auth.users where email = $1', [email])).rowCount).toBe(0)
  })

  it('AUTH_DISABLE_SIGNUP refuses /otp for an unconfirmed user whatever create_user says, and sends no mail (GoTrue)', async () => {
    const saved = config.authDisableSignup
    config.authDisableSignup = true
    const otp = (body: object) => app.request('/auth/v1/otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const mailsTo = async (to: string) => (await pool.query('select count(*)::int as n from selfbase.mail_log where to_email = $1', [to])).rows[0].n
    const unconfirmed = `unconf-${randomUUID()}@example.test`
    const confirmed = `conf-${randomUUID()}@example.test`
    await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1)`, [unconfirmed])
    await pool.query(`insert into auth.users (id, email, email_confirmed_at) values (gen_random_uuid(), $1, now())`, [confirmed])
    try {
      for (const body of [{ email: unconfirmed }, { email: unconfirmed, create_user: true }, { email: unconfirmed, create_user: false }]) {
        const res = await otp(body)
        expect(res.status, JSON.stringify(body)).toBe(422)
        expect(await res.json()).toEqual({ code: 422, error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' })
      }
      expect((await otp({ email: confirmed, create_user: false })).status).toBe(200)
      for (let i = 0; i < 100 && !(await mailsTo(confirmed)); i++) await sleep(20) // sent in the background
      expect(await mailsTo(confirmed)).toBe(1)
      expect(await mailsTo(unconfirmed)).toBe(0)
      expect((await pool.query('select email_confirmed_at from auth.users where email = $1', [unconfirmed])).rows[0].email_confirmed_at).toBeNull()
    } finally {
      config.authDisableSignup = saved
    }
  })

  it('/health is 503 when the database does not answer', async () => {
    expect((await app.request('/health')).status).toBe(200)
    const spy = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('down') as never)
    try {
      const res = await app.request('/health')
      expect(res.status).toBe(503)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('config and mail', () => {
  it('a boolean setting other than true/false stops startup', async () => {
    const saved = process.env.AUTH_CONFIRM_EMAIL
    process.env.AUTH_CONFIRM_EMAIL = 'TRUE'
    vi.resetModules()
    try {
      await expect(import('../src/config.ts')).rejects.toThrow(/true or false/)
    } finally {
      process.env.AUTH_CONFIRM_EMAIL = saved
      vi.resetModules()
    }
  })

  it('a numeric setting that is not a number stops startup', async () => {
    for (const [name, value] of [['AUTH_MIN_PASSWORD', 'six'], ['AUTH_RATE_LIMIT_SIGN_IN', '30/min'], ['AUTH_OTP_EXPIRY', '-1'], ['SMTP_PORT', 'smtp']]) {
      const saved = process.env[name]
      process.env[name] = value
      vi.resetModules()
      try {
        await expect(import('../src/config.ts'), name).rejects.toThrow(`${name} must be a number`)
      } finally {
        if (saved === undefined) delete process.env[name]
        else process.env[name] = saved
        vi.resetModules()
      }
    }
  })

  it('SMTP requires STARTTLS except on the implicit-TLS port 465', () => {
    const base = { host: 'smtp.example.test', user: 'u', pass: 'p', from: 'f@example.test' }
    expect(smtpOptions({ ...base, port: 587 })).toMatchObject({ secure: false, requireTLS: true })
    expect(smtpOptions({ ...base, port: 465 })).toMatchObject({ secure: true, requireTLS: false })
  })
})

describe('http_queue upkeep and the upgrade SQL', () => {
  it('prunes finished rows older than 7 days and keeps pending and recent ones', async () => {
    const tag = `https://prune-${randomUUID()}.example.test/`
    await pool.query(`insert into selfbase.http_queue (method, url, status, created_at) values
      ('GET', $1 || 'old-done', 'done', now() - interval '8 days'), ('GET', $1 || 'old-failed', 'failed', now() - interval '8 days'),
      ('GET', $1 || 'old-pending', 'pending', now() - interval '8 days'), ('GET', $1 || 'new-done', 'done', now())`, [tag])
    await pruneQueue()
    const left = (await pool.query(`select url from selfbase.http_queue where url like $1 || '%' order by url`, [tag])).rows.map((r) => r.url)
    expect(left).toEqual([`${tag}new-done`, `${tag}old-pending`])
    await pool.query(`delete from selfbase.http_queue where url like $1 || '%'`, [tag])
  })
})
