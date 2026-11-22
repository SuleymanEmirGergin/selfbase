import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { pool, asUser } from '../src/db.ts'
import { app } from '../src/app.ts'

describe('bootstrap', () => {
  it('asUser exposes claims to auth.uid() and auth.role()', async () => {
    const U = randomUUID()
    const row = await asUser({ sub: U, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 60 }, async (c) =>
      (await c.query('select auth.uid() as uid, auth.role() as role, current_user as usr')).rows[0])
    expect(row).toEqual({ uid: U, role: 'authenticated', usr: 'authenticated' })
  })

  it('asUser(null) runs as anon with no uid', async () => {
    const row = await asUser(null, async (c) =>
      (await c.query('select auth.uid() as uid, current_user as usr')).rows[0])
    expect(row).toEqual({ uid: null, usr: 'anon' })
  })

  it('net.http_post queues a request and returns its id', async () => {
    const { rows } = await pool.query(`select net.http_post('https://x.supabase.co/a', '{}') as id`)
    const id = rows[0].id
    expect(id).toBeTruthy()
    const q = await pool.query('select method, url, status from selfbase.http_queue where id = $1', [id])
    expect(q.rows[0]).toEqual({ method: 'POST', url: 'https://x.supabase.co/a', status: 'pending' })
  })

  it('asUser runs on a non-superuser session that cannot escalate', async () => {
    const claims = { sub: randomUUID(), role: 'authenticated' as const, exp: Math.floor(Date.now() / 1000) + 60 }
    await expect(asUser(claims, (c) => c.query('set role postgres'))).rejects.toThrow(/permission denied/)
    const row = await asUser(claims, async (c) => {
      await c.query('reset role')
      return (await c.query(`select current_user as usr, current_setting('is_superuser') as su`)).rows[0]
    })
    expect(row).toEqual({ usr: 'authenticator', su: 'off' })
  })

  it('net.http_post is callable as authenticated', async () => {
    const claims = { sub: randomUUID(), role: 'authenticated' as const, exp: Math.floor(Date.now() / 1000) + 60 }
    const id = await asUser(claims, async (c) => (await c.query(`select net.http_post('https://x.supabase.co/b') as id`)).rows[0].id)
    expect(id).toBeTruthy()
    const q = await pool.query('select url from selfbase.http_queue where id = $1', [id])
    expect(q.rows[0].url).toBe('https://x.supabase.co/b')
  })

  it('anon cannot read vault.decrypted_secrets', async () => {
    await expect(asUser(null, (c) => c.query('select * from vault.decrypted_secrets'))).rejects.toThrow(/permission denied/)
  })

  it('GET /health returns ok', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('CORS preflight allows any requested header', async () => {
    const res = await app.request('/rest/v1/t', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-supabase-api-version, accept-profile',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-headers')).toMatch(/x-supabase-api-version.*accept-profile/)
  })

  it('unreachable upstream returns 502 upstream_unavailable', async () => {
    // FN_URL in setup.ts points at a port nothing listens on
    const res = await app.request('/functions/v1/x')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'upstream_unavailable' })
  })

  it('GET /rest/v1/ is proxied to PostgREST', async () => {
    const key = process.env.ANON_KEY!
    const res = await app.request('/rest/v1/', { headers: { apikey: key, authorization: `Bearer ${key}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/openapi|json/)
  })
})
