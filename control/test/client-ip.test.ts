// The rate-limit and audit key (core's clientIp, which control uses): X-Forwarded-For counts only from the proxy's
// address as the provisioner read it from Docker (exact container name), never from a DNS answer, which any container
// on the proxy network can join with an alias. Control is reachable on :8080 by every container on the proxy and
// project networks, not only through Traefik.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { clientIp, trustProxies } from '../src/core.ts'

const ctx = (peer: string, xff?: string) =>
  ({ req: { header: (k: string) => (k === 'x-forwarded-for' ? xff : undefined) }, env: { incoming: { socket: { remoteAddress: peer } } } }) as any
const saved = process.env.TRUST_PROXY
const PROXY = '192.0.2.10'
let answer: () => Promise<string[]> = async () => [PROXY]
const source = vi.fn(() => answer())

beforeAll(() => { process.env.TRUST_PROXY = 'true' })
afterEach(() => { trustProxies(null); vi.useRealTimers(); source.mockClear(); answer = async () => [PROXY] })
afterAll(() => { process.env.TRUST_PROXY = saved })

it("an untrusted peer's spoofed X-Forwarded-For does not change the key; the proxy's (also IPv4-mapped) does", async () => {
  await trustProxies(source).refresh()
  // an impostor aliased as the proxy on its network: its own address, not the proxy's, is what reaches control
  expect(clientIp(ctx('10.207.0.5', '6.6.6.6'))).toBe('10.207.0.5')
  expect(clientIp(ctx(PROXY, '6.6.6.6, 203.0.113.7'))).toBe('203.0.113.7')
  expect(clientIp(ctx(`::ffff:${PROXY}`, '203.0.113.8'))).toBe('203.0.113.8')
  expect(clientIp(ctx(PROXY))).toBe(PROXY)
})

it('a failed refresh keeps the trusted set; IP literals are trusted from the start', async () => {
  const t = trustProxies(source, ['198.51.100.1'])
  expect(clientIp(ctx('198.51.100.1', '203.0.113.9'))).toBe('203.0.113.9')
  await t.refresh()
  answer = async () => { throw new Error('provisioner down') }
  await t.refresh()
  expect(clientIp(ctx(PROXY, '203.0.113.7'))).toBe('203.0.113.7')
  expect(clientIp(ctx('198.51.100.1', '203.0.113.9'))).toBe('203.0.113.9')
})

it('an unknown peer sending X-Forwarded-For re-asks at most every 5 s (a restarted proxy has a new address)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await trustProxies(source).refresh()
  source.mockClear()
  vi.setSystemTime(Date.now() + 6000)
  answer = async () => ['192.0.2.11']
  expect(clientIp(ctx('192.0.2.11', '203.0.113.7'))).toBe('192.0.2.11')
  expect(clientIp(ctx('192.0.2.11', '203.0.113.7'))).toBe('192.0.2.11')
  expect(source).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(clientIp(ctx('192.0.2.11', '203.0.113.7'))).toBe('203.0.113.7'))
})

it('without a source every peer is a proxy (core behind its own Traefik route)', () => {
  trustProxies(null)
  expect(clientIp(ctx('10.207.0.5', '6.6.6.6'))).toBe('6.6.6.6')
})
