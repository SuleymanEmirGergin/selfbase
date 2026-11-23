// Core is on the shared proxy network, where any container reaches :8080 directly: X-Forwarded-For counts only from
// TRUSTED_PROXY_IPS (the proxy container's address, set by the provisioner), so a neighbour cannot pick its own
// client IP and slip past the per-IP auth limits.
import { afterEach, expect, it, vi } from 'vitest'

const ctx = (peer: string, xff?: string) =>
  ({ req: { header: (k: string) => (k === 'x-forwarded-for' ? xff : undefined) }, env: { incoming: { socket: { remoteAddress: peer } } } }) as any
const saved = { trust: process.env.TRUST_PROXY, ips: process.env.TRUSTED_PROXY_IPS }
const load = async (ips: string) => {
  process.env.TRUST_PROXY = 'true'
  process.env.TRUSTED_PROXY_IPS = ips
  vi.resetModules()
  return (await import('../src/ip.ts')).clientIp
}

afterEach(() => {
  process.env.TRUST_PROXY = saved.trust
  if (saved.ips === undefined) delete process.env.TRUSTED_PROXY_IPS
  else process.env.TRUSTED_PROXY_IPS = saved.ips
  vi.resetModules()
})

it("a non-proxy peer's X-Forwarded-For is ignored; the proxy's rightmost entry counts", async () => {
  const clientIp = await load('10.0.1.2')
  expect(clientIp(ctx('10.0.1.9', '6.6.6.6'))).toBe('10.0.1.9')
  expect(clientIp(ctx('10.0.1.2', '6.6.6.6, 203.0.113.7'))).toBe('203.0.113.7')
  expect(clientIp(ctx('::ffff:10.0.1.2', '203.0.113.8'))).toBe('203.0.113.8')
})

it('an empty TRUSTED_PROXY_IPS (proxy down at ensure) trusts no peer', async () => {
  const clientIp = await load('')
  expect(clientIp(ctx('10.0.1.2', '6.6.6.6'))).toBe('10.0.1.2')
})
