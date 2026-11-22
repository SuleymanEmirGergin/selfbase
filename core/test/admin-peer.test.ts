// Security review (Task 8): core sits on the shared proxy network too, so its admin port must refuse any peer
// outside the project's own /27 (PROJECT_SUBNET), before the token is even looked at.
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { peerAllowed, requireAdminToken } from '../src/admin/auth.ts'

const token = process.env.ADMIN_TOKEN!
const SUBNET = '10.207.0.32/27'

describe('peerAllowed', () => {
  it('admits only addresses inside the subnet, IPv4-mapped IPv6 included', () => {
    for (const a of ['10.207.0.32', '10.207.0.40', '10.207.0.63', '::ffff:10.207.0.33']) expect(peerAllowed(SUBNET, a), a).toBe(true)
    for (const a of ['10.207.0.31', '10.207.0.64', '10.0.1.5', '::ffff:10.0.1.5', '127.0.0.1', '::1', 'fe80::1', '', undefined]) {
      expect(peerAllowed(SUBNET, a), String(a)).toBe(false)
    }
  })

  it('with no subnet (local dev) any peer is allowed', () => {
    expect(peerAllowed('', '203.0.113.9')).toBe(true)
    expect(peerAllowed(undefined, undefined)).toBe(true)
  })

  it('a subnet that is not an IPv4 CIDR is refused at once', () => {
    for (const bad of ['10.207.0.32', '10.207.0.32/33', 'x/27', '::1/128']) expect(() => peerAllowed(bad, '10.207.0.33'), bad).toThrow()
  })
})

describe('admin middleware with PROJECT_SUBNET set', () => {
  const app = new Hono().use('*', requireAdminToken).get('/x', (c) => c.text('ok'))
  const call = (remoteAddress: string, auth = `Bearer ${token}`) =>
    app.request('/x', { headers: { authorization: auth } }, { incoming: { socket: { remoteAddress } } })

  it('403 admin_forbidden for a peer on the shared network, even with the right token', async () => {
    process.env.PROJECT_SUBNET = SUBNET
    try {
      const res = await call('10.0.1.5')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'admin_forbidden' })
      // before the token check: a wrong token from outside is 403 too, not 401
      expect((await call('10.0.1.5', 'Bearer wrong')).status).toBe(403)
      expect((await call('10.207.0.33')).status).toBe(200)
      expect((await call('::ffff:10.207.0.33')).status).toBe(200)
      expect((await call('10.207.0.33', 'Bearer wrong')).status).toBe(401)
    } finally {
      delete process.env.PROJECT_SUBNET
    }
  })
})
