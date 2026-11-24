import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isIPv4 } from 'node:net'
import { createMiddleware } from 'hono/factory'
import { config } from '../config.ts'
import { adminError } from './ident.ts'

// Only control holds ADMIN_TOKEN; it names the dashboard user it acts for in x-selfbase-actor (an email, <= 320).
export type AdminEnv = { Variables: { actor: string } }

const digest = (s: string) => createHash('sha256').update(s).digest()

const ipv4 = (a: string) => a.split('.').reduce((n, o) => n * 256 + Number(o), 0)

function parseSubnet(subnet: string): { base: number; mask: number } {
  const m = /^([0-9.]+)\/(\d|[12]\d|3[0-2])$/.exec(subnet)
  if (!m || !isIPv4(m[1])) throw new Error(`PROJECT_SUBNET must be an IPv4 CIDR, got "${subnet}"`)
  const mask = Number(m[2]) === 0 ? 0 : (0xffffffff << (32 - Number(m[2]))) >>> 0
  return { base: (ipv4(m[1]) & mask) >>> 0, mask }
}

/** True when PROJECT_SUBNET is set; throws when it is set but not an IPv4 CIDR (server.ts calls it at start). */
export const checkProjectSubnet = (subnet: string | undefined) => !!subnet && !!parseSubnet(subnet)

/**
 * Whether the admin port may answer `addr`. PROJECT_SUBNET is the project's control /29 (sb-<ref>-ctl, where only
 * core and control are), set by the provisioner: core also sits on the shared proxy network, where other teams'
 * containers are, and on the tenant network with fn, which runs project code. The network, gateway (base+1, the
 * Docker default, held by the host's bridge interface, so every host-network process) and broadcast addresses
 * are refused. Unset (local dev): any peer.
 */
export function peerAllowed(subnet: string | undefined, addr: string | undefined): boolean {
  if (!subnet) return true
  const { base, mask } = parseSubnet(subnet)
  const v4 = (addr ?? '').replace(/^::ffff:/i, '')
  if (!isIPv4(v4)) return false
  const a = ipv4(v4)
  return ((a & mask) >>> 0) === base && a !== base && a !== base + 1 && a !== (base | ~mask) >>> 0
}

/**
 * 403 admin_forbidden for a peer outside PROJECT_SUBNET (before the token is looked at), then 401 unless
 * Authorization is `Bearer <ADMIN_TOKEN>`; JWTs (service_role included) grant nothing here.
 */
export const requireAdminToken = createMiddleware<AdminEnv>(async (c, next) => {
  const peer = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket?.remoteAddress
  if (!peerAllowed(process.env.PROJECT_SUBNET, peer)) throw adminError(403, 'admin_forbidden')
  const m = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')
  // digests have equal length, so timingSafeEqual neither throws nor leaks the token's length
  if (config.adminToken.length < 32 || !m || !timingSafeEqual(digest(m[1]), digest(config.adminToken)))
    throw adminError(401, 'admin token required')
  const actor = c.req.header('x-selfbase-actor') || 'control'
  if (actor.length > 320) throw adminError(400, 'x-selfbase-actor is longer than 320 characters')
  c.set('actor', actor)
  return next()
})
