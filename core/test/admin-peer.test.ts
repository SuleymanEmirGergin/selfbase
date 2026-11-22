// Security review (Task 8): core sits on the shared proxy network too, so its admin port must refuse any peer
// outside the project's own /27 (PROJECT_SUBNET), before the token is even looked at.
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { checkProjectSubnet, peerAllowed, requireAdminToken } from '../src/admin/auth.ts'

const token = process.env.ADMIN_TOKEN!
const SUBNET = '10.207.0.32/27'

describe('peerAllowed', () => {
  it('admits only addresses inside the subnet, IPv4-mapped IPv6 included', () => {
    for (const a of ['10.207.0.34', '10.207.0.40', '10.207.0.62', '::ffff:10.207.0.34']) expect(peerAllowed(SUBNET, a), a).toBe(true)
    for (const a of ['10.207.0.31', '10.207.0.64', '10.0.1.5', '::ffff:10.0.1.5', '127.0.0.1', '::1', 'fe80::1', '', undefined]) {
      expect(peerAllowed(SUBNET, a), String(a)).toBe(false)
    }
  })

  // Docker gives the gateway (base+1) to the host's bridge interface: every host-network process connects from it
  it('refuses the network, gateway and broadcast addresses of the subnet', () => {
    for (const a of ['10.207.0.32', '10.207.0.33', '::ffff:10.207.0.33', '10.207.0.63']) expect(peerAllowed(SUBNET, a), a).toBe(false)
  })

  it('with no subnet (local dev) any peer is allowed', () => {
    expect(peerAllowed('', '203.0.113.9')).toBe(true)
    expect(peerAllowed(undefined, undefined)).toBe(true)
  })

  it('a subnet that is not an IPv4 CIDR is refused, by peerAllowed and by the start check', () => {
    for (const bad of ['10.207.0.32', '10.207.0.32/33', 'x/27', '::1/128', '999.0.0.0/27']) {
      expect(() => peerAllowed(bad, '10.207.0.34'), bad).toThrow(/PROJECT_SUBNET must be an IPv4 CIDR/)
      expect(() => checkProjectSubnet(bad), bad).toThrow(/PROJECT_SUBNET must be an IPv4 CIDR/)
    }
    expect(checkProjectSubnet(SUBNET)).toBe(true)
    expect(checkProjectSubnet(undefined)).toBe(false)
  })
})

describe('admin middleware with PROJECT_SUBNET set', () => {
  const app = new Hono().use('*', requireAdminToken).get('/x', (c) => c.text('ok'))
  const call = (remoteAddress: string, auth = `Bearer ${token}`, extra: Record<string, string> = {}) =>
    app.request('/x', { headers: { authorization: auth, ...extra } }, { incoming: { socket: { remoteAddress } } })

  it('403 admin_forbidden for a peer on the shared network, even with the right token', async () => {
    process.env.PROJECT_SUBNET = SUBNET
    try {
      const res = await call('10.0.1.5')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'admin_forbidden' })
      // before the token check: a wrong token from outside is 403 too, not 401
      expect((await call('10.0.1.5', 'Bearer wrong')).status).toBe(403)
      // the gateway is the host itself (host-network containers of other teams)
      expect((await call('10.207.0.33')).status).toBe(403)
      // only the socket's address counts, never a forwarding header
      for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded']) {
        const v = h === 'forwarded' ? 'for=10.207.0.34' : '10.207.0.34'
        expect((await call('10.0.1.5', `Bearer ${token}`, { [h]: v })).status, h).toBe(403)
      }
      expect((await call('10.207.0.34')).status).toBe(200)
      expect((await call('::ffff:10.207.0.34')).status).toBe(200)
      expect((await call('10.207.0.34', 'Bearer wrong')).status).toBe(401)
    } finally {
      delete process.env.PROJECT_SUBNET
    }
  })
})
