// R2 (wave 1 runtime I1): core's outbound calls (Google OAuth, SMTP, net.http_*) go through one guard. A stub resolver
// stands in for DNS, so nothing here depends on the network.
import { describe, expect, it } from 'vitest'
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
