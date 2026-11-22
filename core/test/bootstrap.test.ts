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

  it('anon cannot read vault.decrypted_secrets', async () => {
    await expect(asUser(null, (c) => c.query('select * from vault.decrypted_secrets'))).rejects.toThrow(/permission denied/)
  })

  it('GET /health returns ok', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('GET /panel/* is 404 while panel/dist is not built', async () => {
    const res = await app.request('/panel/index.html')
    expect(res.status).toBe(404)
  })

  it('GET /rest/v1/ is proxied to PostgREST', async () => {
    const key = process.env.ANON_KEY!
    const res = await app.request('/rest/v1/', { headers: { apikey: key, authorization: `Bearer ${key}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/openapi|json/)
  })
})
