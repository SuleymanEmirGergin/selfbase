// Logout's own rate-limit bucket and its failure answers (Task 30 A4).
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'

// revokeSession is a binding of core.ts, so it is replaced at the module: real unless a test makes it throw
const failRevoke = vi.hoisted(() => ({ on: false }))
vi.mock('../src/core.ts', async (orig) => {
  const real = await orig<typeof import('../src/core.ts')>()
  return {
    ...real,
    revokeSession: async (sid: string) => {
      if (failRevoke.on) throw new Error('control-db went away')
      return real.revokeSession(sid)
    },
  }
})

const { app } = await import('../src/app.ts')
const { resetRateLimits } = await import('../src/core.ts')
const { ORIGIN, PASSWORD, as, login, resetDashboard, user } = await import('./helpers.ts')

const anonLogout = (ip: string) =>
  app.request('/platform/logout', { method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': ip } })

beforeAll(async () => {
  await resetDashboard()
  await user('logout@example.test')
})
beforeEach(() => resetRateLimits())

test('logout has its own bucket: it does not use up the public one, and an anonymous flood is still refused (429)', async () => {
  // more logouts than the public bucket's 5: invitations/accept from the same address is still served
  for (let i = 0; i < 6; i++) expect((await anonLogout('203.0.113.20')).status).toBe(200)
  const accept = await app.request('/platform/invitations/accept', {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.20' },
    body: JSON.stringify({ token: 'x', password: 'y' }),
  })
  expect(accept.status).not.toBe(429)
  // bounded: the refresh budget (150 per 5 minutes) per address
  let status = 200
  for (let i = 0; i < 200 && status !== 429; i++) status = (await anonLogout('203.0.113.21')).status
  expect(status).toBe(429)
})

test('a revoke that throws on the refresh-cookie path answers 502 logout_failed and keeps the cookies', async () => {
  const cookie = await login('logout@example.test', PASSWORD)
  const refreshOnly = cookie.split('; ').find((c) => c.startsWith('__Host-sb_studio_refresh='))!
  failRevoke.on = true
  try {
    const out = await app.request('/platform/logout', { method: 'POST', headers: { cookie: refreshOnly, origin: ORIGIN } })
    expect(out.status).toBe(502)
    expect(await out.json()).toEqual({ error: 'logout_failed', message: expect.any(String) })
    expect(out.headers.getSetCookie()).toEqual([])
  } finally {
    failRevoke.on = false
  }
  expect((await as(cookie, 'GET', '/platform/me')).status).toBe(200)
})
