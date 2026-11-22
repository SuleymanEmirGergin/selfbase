import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { sign, verify, auth } from '../src/jwt.ts'
import type { AppEnv } from '../src/jwt.ts'

const key = new TextEncoder().encode(process.env.JWT_SECRET!)
const raw = (payload: object) => new SignJWT({ ...payload }).setProtectedHeader({ alg: 'HS256' }).sign(key)
const now = () => Math.floor(Date.now() / 1000)

const app = new Hono<AppEnv>().get('/', auth(), (c) => c.json({ claims: c.get('claims') }))
const call = (headers: Record<string, string>) => app.request('/', { headers })

describe('jwt', () => {
  it('sign/verify round trip sets exp from expiresInSec', async () => {
    const token = await sign({ sub: 'u1', role: 'authenticated', email: 'a@example.test' }, 60)
    const claims = await verify(token)
    expect(claims).toMatchObject({ sub: 'u1', role: 'authenticated', email: 'a@example.test' })
    expect(claims.exp - now()).toBeGreaterThan(50)
  })

  it('rejects an unknown role', async () => {
    await expect(verify(await raw({ role: 'postgres', exp: now() + 60 }))).rejects.toThrow()
  })

  it('rejects a token without exp', async () => {
    await expect(verify(await raw({ role: 'anon' }))).rejects.toThrow()
  })

  it('auth(): no token gives null claims', async () => {
    expect(await (await call({})).json()).toEqual({ claims: null })
  })

  it('auth(): expired token is 401', async () => {
    const res = await call({ authorization: `Bearer ${await raw({ role: 'anon', exp: now() - 10 })}` })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error_code: 'bad_jwt' })
  })

  it('auth(): Bearer wins over apikey', async () => {
    const user = await sign({ sub: 'u2', role: 'authenticated' }, 60)
    const body = await (await call({ authorization: `Bearer ${user}`, apikey: process.env.ANON_KEY! })).json()
    expect(body.claims).toMatchObject({ sub: 'u2', role: 'authenticated' })
  })

  it('auth(): apikey alone is used', async () => {
    const body = await (await call({ apikey: process.env.ANON_KEY! })).json()
    expect(body.claims).toMatchObject({ role: 'anon' })
  })
})
