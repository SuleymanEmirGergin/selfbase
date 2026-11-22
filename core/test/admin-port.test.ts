// Review Focus 2: the admin API exists only on the private admin app, never on the public one.
import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { app, adminApp } from '../src/app.ts'
import { pool } from '../src/db.ts'

const token = process.env.ADMIN_TOKEN!
const serviceKey = process.env.SERVICE_ROLE_KEY!
const T = `t4_${randomUUID().slice(0, 8)}`

afterAll(async () => {
  await pool.query(`drop table if exists public.${T}`)
})

describe('public app', () => {
  const paths = ['/admin/tables', '/admin/sql', '/admin/login', '/admin/files/b/x', '/panel/', '/panel/index.html']
  const auths: [string, Record<string, string>][] = [
    ['no header', {}],
    ['admin token', { authorization: `Bearer ${token}` }],
    ['service_role JWT', { authorization: `Bearer ${serviceKey}`, apikey: serviceKey }],
  ]
  for (const [name, headers] of auths) {
    it(`answers 404 on every admin and panel path with ${name}`, async () => {
      for (const p of paths) {
        for (const method of ['GET', 'POST']) {
          const res = await app.request(p, { method, headers })
          expect(res.status, `${method} ${p}`).toBe(404)
        }
      }
    })
  }
})

describe('admin app', () => {
  const tables = (authorization?: string) =>
    adminApp.request('/admin/tables?schema=public', { headers: authorization ? { authorization } : {} })

  it('401 without a token and with a wrong token of equal length', async () => {
    expect((await tables()).status).toBe(401)
    const wrong = token.slice(0, -1) + (token.endsWith('x') ? 'y' : 'x')
    expect(wrong.length).toBe(token.length)
    expect((await tables(`Bearer ${wrong}`)).status).toBe(401)
    expect((await tables(token)).status).toBe(401) // no Bearer scheme
  })

  it('200 with the token', async () => {
    expect((await tables(`Bearer ${token}`)).status).toBe(200)
  })

  it('a service_role JWT as bearer is 401', async () => {
    expect((await tables(`Bearer ${serviceKey}`)).status).toBe(401)
  })

  it('a write with x-selfbase-actor stores that actor', async () => {
    await pool.query(`create table public.${T} (id int primary key)`)
    const res = await adminApp.request(`/admin/rows/public/${T}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-selfbase-actor': 'a@b.test' },
      body: JSON.stringify({ values: { id: 1 } }),
    })
    expect(res.status).toBe(200)
    const { rows } = await pool.query(`select actor from selfbase.admin_audit where action = 'rows.insert' and target = $1`, [`public.${T}`])
    expect(rows).toEqual([{ actor: 'a@b.test' }])
  })
})
