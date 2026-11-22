// Each project network gets one /27 of PROJECT_SUBNET_POOL (2048 of them in a /16).
import { config } from './config.ts'
import type { Db } from './db.ts'
import { ApiError } from './errors.ts'

export class SubnetError extends ApiError {
  constructor(code: 'pool_exhausted', message: string) {
    super(409, code, message)
  }
}

const LOWEST_FREE = `
  select set_masklen(network($1::cidr) + n * 32, 27)::cidr::text as subnet
  from generate_series(0, (2 ^ greatest(27 - masklen($1::cidr), -1))::bigint - 1) as n
  where not exists (select 1 from control.projects p where p.subnet = set_masklen(network($1::cidr) + n * 32, 27)::cidr)
  order by n limit 1`

/**
 * The lowest free /27 of the pool. `take` writes it (the projects row); when another allocation took the same
 * subnet first, the unique constraint on projects.subnet rejects the write and the next free one is tried.
 * Without `take` nothing is reserved. `take` must not run inside an open transaction: the conflict would abort it.
 */
export async function allocateSubnet(db: Db, take?: (subnet: string) => Promise<unknown>): Promise<string> {
  // each conflict means another allocation took a subnet, so the pool size bounds the tries
  const tries = 2 ** Math.max(27 - Number(config.projectSubnetPool.split('/')[1]), 0)
  for (let i = 0; i < tries; i++) {
    const subnet: string | undefined = (await db.query(LOWEST_FREE, [config.projectSubnetPool])).rows[0]?.subnet
    if (!subnet) break
    try {
      await take?.(subnet)
      return subnet
    } catch (e) {
      // another allocation committed this subnet first: it is no longer free, so the loop makes progress
      if ((e as { code?: string; constraint?: string }).code === '23505' && (e as { constraint?: string }).constraint === 'projects_subnet_key') continue
      throw e
    }
  }
  throw new SubnetError('pool_exhausted',
    `Every /27 network of ${config.projectSubnetPool} is in use. Delete a project you do not use, or ask the operator to widen PROJECT_SUBNET_POOL.`)
}
