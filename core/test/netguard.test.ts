// R2 (wave 1 runtime I1): core's outbound calls (Google OAuth, SMTP, net.http_*) go through one guard. A stub resolver
// stands in for DNS, so nothing here depends on the network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { Blocked, guardedRequest, isBlocked, resolveChecked, type Resolver } from '../src/netguard.ts'

const stub = (map: Record<string, string[]>): Resolver => async (host) => {
  if (!map[host]) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
  return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}
const dns = stub({
  'oauth2.googleapis.com': ['203.0.113.10'], 'openidconnect.googleapis.com': ['203.0.113.11', '2001:db8::200a'],
  'smtp.mail.example': ['198.51.100.25'],
  'rebind.example': ['203.0.113.34', '10.0.0.5'], 'metadata.example': ['169.254.169.254'], 'neighbour.example': ['172.18.0.7'],
  'cgnat.example': ['100.64.1.1'], 'ula.example': ['fd00::1'], 'mapped.example': ['::ffff:127.0.0.1'], 'relay.internal': ['10.1.2.3'],
  localhost: ['127.0.0.1'],
})

describe('outbound guard', () => {
  it('refuses loopback, RFC 1918, CGNAT, link-local, ULA and mapped addresses, by name and as literals', async () => {
    for (const host of ['rebind.example', 'metadata.example', 'neighbour.example', 'cgnat.example', 'ula.example', 'mapped.example',
      '127.0.0.1', '10.207.0.33', '[::1]', '169.254.169.254', 'localhost.']) {
      await expect(resolveChecked(host, new Set(), dns), host).rejects.toBeInstanceOf(Blocked)
    }
  })

  it('refuses the container\'s own networks whatever their range (project /27, proxy network, their gateways)', () => {
    const own = Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4')
    for (const i of own) expect(isBlocked(i!.address), i!.address).toBe(true)
  })

  it('refuses site-local, local-use NAT64 and Teredo IPv6, and a refusal carries the code EBLOCKED', async () => {
    for (const host of ['[fec0::1]', '[64:ff9b:1::a00:5]', '[2001::1]', '[2001:0:4136:e378:8000:63bf:3fff:fdd2]']) {
      await expect(resolveChecked(host, new Set(), dns), host).rejects.toMatchObject({ code: 'EBLOCKED' })
    }
    // public IPv6 outside those ranges still passes
    for (const a of ['2001:4860:4860::8888', '2001:db8::1', '2a00:1450::1']) expect(isBlocked(a), a).toBe(false)
  })

  it('passes the default Google endpoints and a public SMTP host', async () => {
    expect((await resolveChecked('oauth2.googleapis.com', new Set(), dns)).map((a) => a.address)).toEqual(['203.0.113.10'])
    expect((await resolveChecked('openidconnect.googleapis.com', new Set(), dns)).length).toBe(2)
    expect((await resolveChecked('smtp.mail.example', new Set(), dns))[0].address).toBe('198.51.100.25')
  })

  it('an operator allow-list entry (OUTBOUND_ALLOW_HOSTS) passes a private host, and only that host', async () => {
    const allow = new Set(['relay.internal'])
    expect((await resolveChecked('Relay.Internal.', allow, dns))[0].address).toBe('10.1.2.3')
    await expect(resolveChecked('neighbour.example', allow, dns)).rejects.toBeInstanceOf(Blocked)
  })

  it('a private URL is refused before any connection is made', async () => {
    let asked = 0
    const counting: Resolver = async (h) => { asked++; return dns(h) }
    await expect(guardedRequest('http://10.0.0.1:1/userinfo', {}, new Set(), counting)).rejects.toBeInstanceOf(Blocked)
    expect(asked).toBe(0) // a literal is checked as is
    await expect(guardedRequest('http://metadata.example/latest', {}, new Set(), counting)).rejects.toBeInstanceOf(Blocked)
    await expect(guardedRequest('ftp://oauth2.googleapis.com/x', {}, new Set(), dns)).rejects.toBeInstanceOf(Blocked)
    await expect(guardedRequest('https://u:p@oauth2.googleapis.com/x', {}, new Set(), dns)).rejects.toBeInstanceOf(Blocked)
  })
})

describe('guarded sockets', () => {
  let srv: Server
  let port = 0
  let hits = 0
  beforeAll(async () => {
    srv = createServer((_req, res) => {
      hits++
      res.end('ok')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    port = (srv.address() as { port: number }).port
  })
  afterAll(() => new Promise<void>((r) => srv.close(() => r())))

  it('a name connects through guardedLookup to the address it checked (no system DNS knows svc.test)', async () => {
    const reply = await guardedRequest(`http://svc.test:${port}/`, {}, new Set(['svc.test']), stub({ 'svc.test': ['127.0.0.1'] }))
    expect(reply).toEqual({ status: 200, body: 'ok' })
  })

  it('a kept-alive socket is not reused past the guard: allowed once, then refused with an empty allow-list', async () => {
    const r = stub({ 'again.test': ['127.0.0.1'] })
    expect((await guardedRequest(`http://again.test:${port}/`, {}, new Set(['again.test']), r)).status).toBe(200)
    const before = hits
    await expect(guardedRequest(`http://again.test:${port}/`, {}, new Set(), r)).rejects.toBeInstanceOf(Blocked)
    expect(hits).toBe(before)
  })
})
