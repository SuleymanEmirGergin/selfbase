// The rate-limit and audit key (core's clientIp, which control uses): X-Forwarded-For counts only from a trusted proxy.
// Control is reachable on :8080 by every container on the proxy and project networks, not only through Traefik.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { clientIp, refreshTrustedProxies } from '../src/core.ts'

const ctx = (peer: string, xff?: string) =>
  ({ req: { header: (k: string) => (k === 'x-forwarded-for' ? xff : undefined) }, env: { incoming: { socket: { remoteAddress: peer } } } }) as any
const saved = process.env.TRUST_PROXY

beforeAll(async () => {
  process.env.TRUST_PROXY = 'true'
  await refreshTrustedProxies('localhost, 192.0.2.10')
})
afterAll(async () => {
  process.env.TRUST_PROXY = saved
  await refreshTrustedProxies(process.env.TRUSTED_PROXY_HOSTS)
})

it('a spoofed X-Forwarded-For from an untrusted peer does not change the key', () => {
  expect(clientIp(ctx('10.207.0.5', '6.6.6.6'))).toBe('10.207.0.5')
  expect(clientIp(ctx('10.207.0.5', '1.1.1.1, 7.7.7.7'))).toBe('10.207.0.5')
})

it('a trusted proxy (by name or address, also IPv4-mapped) gives the rightmost X-Forwarded-For entry', () => {
  expect(clientIp(ctx('127.0.0.1', '6.6.6.6, 203.0.113.7'))).toBe('203.0.113.7')
  expect(clientIp(ctx('::ffff:192.0.2.10', '203.0.113.8'))).toBe('203.0.113.8')
  expect(clientIp(ctx('192.0.2.10'))).toBe('192.0.2.10')
})

it('without TRUSTED_PROXY_HOSTS every peer is a proxy (core behind its own Traefik route)', async () => {
  await refreshTrustedProxies('')
  expect(clientIp(ctx('10.207.0.5', '6.6.6.6'))).toBe('6.6.6.6')
  await refreshTrustedProxies('localhost, 192.0.2.10')
})
