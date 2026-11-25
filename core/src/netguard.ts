// The one guard for core's outbound connections (net.http_* queue, Google OAuth, SMTP). Core sits on the shared proxy
// network: a configured or queued destination must not reach other teams' containers, other projects, control, the
// host or cloud metadata. Every address a host resolves to is checked, and the socket connects to a checked address
// (the lookup the socket really uses, or the address itself), so a second DNS answer cannot differ. A host in the
// caller's allow-list (an operator setting) skips the check.
import { lookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { networkInterfaces } from 'node:os'

export class Blocked extends Error {}

// loopback, RFC 1918, CGNAT, link-local (cloud metadata), benchmarking, multicast and reserved
const BLOCKED = new BlockList()
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) BLOCKED.addSubnet(a, p, 'ipv4')
// ::/96 holds :: and ::1; NAT64 and 6to4 can carry any IPv4 address; ULA, link-local, multicast. No ::ffff:0:0/96:
// BlockList checks an IPv4-mapped address against the IPv4 rules itself, and that rule would match every IPv4 address
for (const [a, p] of [['::', 96], ['64:ff9b::', 96], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  BLOCKED.addSubnet(a, p, 'ipv6')
}
// the container's own networks (the project's /27 and the proxy network, so their gateways too), whatever range
// Docker gave them
for (const i of Object.values(networkInterfaces()).flat()) {
  if (i && !i.internal && i.cidr) BLOCKED.addSubnet(i.address, Number(i.cidr.split('/')[1]), i.family === 'IPv6' ? 'ipv6' : 'ipv4')
}

export const isBlocked = (addr: string) => BLOCKED.check(addr, isIP(addr) === 6 ? 'ipv6' : 'ipv4')
const normal = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')

export type Resolver = (host: string) => Promise<LookupAddress[]>
const system: Resolver = (host) => new Promise((ok, fail) => lookup(host, { all: true }, (e, a) => (e ? fail(e) : ok(a))))

/** Every address of host, refused (Blocked) when any is private, unless host is allowed. A literal is not looked up. */
export async function resolveChecked(host: string, allow: Set<string>, resolve: Resolver = system): Promise<LookupAddress[]> {
  const h = normal(host)
  const addrs = isIP(h) ? [{ address: h, family: isIP(h) }] : await resolve(h)
  if (!allow.has(h) && addrs.some((a) => isBlocked(a.address))) throw new Blocked(`blocked: ${h} is or resolves to a private address`)
  return addrs
}

/** http(s).request's lookup option: the socket connects only to what resolveChecked passed. */
export const guardedLookup = (allow: Set<string>, resolve?: Resolver): LookupFunction => (hostname, options, callback) => {
  resolveChecked(hostname, allow, resolve).then((addrs) => {
    if (options.all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addrs)
    else callback(null, addrs[0].address, addrs[0].family)
  }, (err) => callback(err, '', 0))
}

export type Reply = { status: number; body: string }
/**
 * One guarded HTTP request, no redirects followed (a 3xx is the answer). The body is read up to 1 MiB.
 * Refused (Blocked) for a private destination, a non-http(s) scheme or credentials in the URL.
 */
export function guardedRequest(target: string, init: { method?: string; headers?: OutgoingHttpHeaders; body?: string; timeoutMs?: number },
  allow: Set<string>, resolve?: Resolver): Promise<Reply> {
  const u = new URL(target)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return Promise.reject(new Blocked(`blocked: scheme ${u.protocol} is not sent`))
  // fetch refused these too; http.request would send them as Basic credentials
  if (u.username || u.password) return Promise.reject(new Blocked('blocked: credentials in the URL are not sent'))
  const host = normal(u.hostname)
  // a literal address is never looked up: check it here
  if (isIP(host) && !allow.has(host) && isBlocked(host)) return Promise.reject(new Blocked(`blocked: ${host} is a private address`))
  return new Promise((resolve_, reject) => {
    // agent: false: a pooled keep-alive socket is keyed by host:port and would skip the lookup, so the guard
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: init.method ?? 'GET', headers: init.headers,
      signal: AbortSignal.timeout(init.timeoutMs ?? 5000), lookup: guardedLookup(allow, resolve), agent: false }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > 1024 * 1024) return void res.destroy(new Error('response larger than 1 MiB'))
        chunks.push(c)
      })
      res.on('end', () => resolve_({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(init.body)
  })
}
