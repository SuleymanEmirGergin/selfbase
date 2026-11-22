import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { BlockList, isIPv4 } from 'node:net'
import { createMiddleware } from 'hono/factory'
import { config } from '../config.ts'
import { adminError } from './ident.ts'

// Only control holds ADMIN_TOKEN; it names the dashboard user it acts for in x-selfbase-actor (an email, <= 320).
export type AdminEnv = { Variables: { actor: string } }

const digest = (s: string) => createHash('sha256').update(s).digest()

let subnetList: [string, BlockList] | undefined
/**
 * Whether the admin port may answer `addr`. PROJECT_SUBNET is the project's /27, set by the provisioner: core
 * also sits on the shared proxy network, where other teams' containers are. Unset (local dev): any peer.
 */
export function peerAllowed(subnet: string | undefined, addr: string | undefined): boolean {
  if (!subnet) return true
  if (subnetList?.[0] !== subnet) {
    const m = /^([0-9.]+)\/(\d|[12]\d|3[0-2])$/.exec(subnet)
    if (!m || !isIPv4(m[1])) throw new Error(`PROJECT_SUBNET must be an IPv4 CIDR, got "${subnet}"`)
    const list = new BlockList()
    list.addSubnet(m[1], Number(m[2]), 'ipv4')
    subnetList = [subnet, list]
  }
  const v4 = (addr ?? '').replace(/^::ffff:/i, '')
  return isIPv4(v4) && subnetList[1].check(v4, 'ipv4')
}

/**
 * 403 admin_forbidden for a peer outside PROJECT_SUBNET (before the token is looked at), then 401 unless
 * Authorization is `Bearer <ADMIN_TOKEN>`; JWTs (service_role included) grant nothing here.
 */
export const requireAdminToken = createMiddleware<AdminEnv>(async (c, next) => {
  const peer = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket?.remoteAddress
  if (!peerAllowed(process.env.PROJECT_SUBNET, peer)) throw adminError(403, 'admin_forbidden')
  const m =/^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')
  // digests have equal length, so timingSafeEqual neither throws nor leaks the token's length
  if (config.adminToken.length < 32 || !m || !timingSafeEqual(digest(m[1]), digest(config.adminToken)))
    throw adminError(401, 'admin token required')
  const actor = c.req.header('x-selfbase-actor') || 'control'
  if (actor.length > 320) throw adminError(400, 'x-selfbase-actor is longer than 320 characters')
  c.set('actor', actor)
  return next()
})
