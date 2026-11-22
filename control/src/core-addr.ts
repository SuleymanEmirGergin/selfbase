// A project's core address on sb-<ref>, as the provisioner read it from Docker. Never a DNS name: Docker's DNS may
// answer core's proxy-network address (where its admin port refuses control), and anything on a network control
// shares could answer a name. Cached per ref; forgotten after every provisioner call that may recreate, stop or
// remove the project's containers (provisioner.ts) and when a connection to it fails.
import { ApiError } from './errors.ts'
import type { Provisioner } from './provisioner.ts'

const cache = new Map<string, string>()

export async function coreIp(provisioner: Provisioner, ref: string): Promise<string> {
  const hit = cache.get(ref)
  if (hit) return hit
  const ip = (await provisioner.inspect(ref)).services.find((s) => s.service === 'core')?.projectIp
  if (!ip) throw new ApiError(502, 'project_unreachable', 'project is not reachable')
  cache.set(ref, ip)
  return ip
}

export const forgetCoreIp = (ref: string) => { cache.delete(ref) }
