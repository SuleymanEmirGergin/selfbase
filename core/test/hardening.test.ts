// Cross-cutting server guards: pool resilience, the gateway's IP headers and response headers, REST exposure and
// query guards, auth rate limits, body limit, health, config parsing, queue upkeep and the upgrade SQL.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import pg from 'pg'
import { app } from '../src/app.ts'
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

  it('/panel redirects to /panel/ and panel responses carry CSP, frame and referrer headers', async () => {
    const r = await app.request('/panel')
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('/panel/')
    const res = await app.request('/panel/missing.js')
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
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
  it('core JSON routes refuse bodies over 1 MiB; panel file uploads are not capped by it', async () => {
    const big = JSON.stringify({ email: 'a@example.test', password: 'x'.repeat(1024 * 1024 + 10) })
    const res = await app.request('/auth/v1/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })
    expect(res.status).toBe(413)
    expect((await app.request('/admin/sql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })).status).toBe(413)
    const upload = await app.request('/admin/files/b/x.bin', { method: 'POST', body: big })
    expect(upload.status).toBe(401) // reaches the panel login check, not the 1 MiB limit
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

  it('db/upgrade/2026-11-22.sql is idempotent and matches the bootstrap', async () => {
    const sql = readFileSync(new URL('../../db/upgrade/2026-11-22.sql', import.meta.url), 'utf8')
    await pool.query(sql)
    await pool.query(sql)
    const idx = await pool.query(`select indexdef from pg_indexes where schemaname = 'selfbase' and indexname = 'http_queue_pending_idx'`)
    expect(idx.rows[0].indexdef).toMatch(/WHERE \(status = 'pending'::text\)/)
    const roles = await pool.query(`select r.rolname, s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
      where r.rolname in ('anon', 'authenticated') order by 1`)
    expect(roles.rows).toEqual([
      { rolname: 'anon', setconfig: ['statement_timeout=3s'] },
      { rolname: 'authenticated', setconfig: ['statement_timeout=8s'] },
    ])
  })
})
