import { beforeEach, describe, expect, test } from 'vitest'
import { config } from '../src/config.ts'
import { pool } from '../src/db.ts'
import { newRef } from '../src/ids.ts'
import { allocateSubnet, SubnetError } from '../src/subnets.ts'

let orgId: string
// what createProject does: the project row takes the subnet, the unique constraint settles races
const insert = (subnet: string) =>
  pool.query(`insert into control.projects (ref, org_id, name, status, size, subnet) values ($1, $2, 'p', 'COMING_UP', 'micro', $3)`,
    [newRef(), orgId, subnet])

beforeEach(async () => {
  // other files insert random subnets; "lowest free" needs an empty table
  await pool.query('delete from control.projects')
  orgId = (await pool.query(`insert into control.organizations (slug, name) values ($1, 'o') returning id`, [`o-${newRef()}`])).rows[0].id
})

describe('subnets', () => {
  test('first is 10.207.0.0/27, second 10.207.0.32/27', async () => {
    expect(await allocateSubnet(pool, insert)).toBe('10.207.0.0/27')
    expect(await allocateSubnet(pool, insert)).toBe('10.207.0.32/27')
  })

  test('without a writer it only returns the lowest free subnet', async () => {
    expect(await allocateSubnet(pool)).toBe('10.207.0.0/27')
    expect(await allocateSubnet(pool)).toBe('10.207.0.0/27')
  })

  test('a freed subnet is reused', async () => {
    for (let i = 0; i < 3; i++) await allocateSubnet(pool, insert)
    await pool.query(`delete from control.projects where subnet = '10.207.0.32/27'`)
    expect(await allocateSubnet(pool, insert)).toBe('10.207.0.32/27')
    expect(await allocateSubnet(pool, insert)).toBe('10.207.0.96/27')
  })

  test('20 concurrent allocations give 20 distinct subnets', async () => {
    const got = await Promise.all(Array.from({ length: 20 }, () => allocateSubnet(pool, insert)))
    expect(new Set(got).size).toBe(20)
    expect(got.toSorted()).toEqual(Array.from({ length: 20 }, (_, i) => `10.207.${Math.floor(i / 8)}.${(i % 8) * 32}/27`).toSorted())
  })

  test('a full pool throws pool_exhausted', async () => {
    const before = config.projectSubnetPool
    try {
      config.projectSubnetPool = '10.207.0.0/26'
      await allocateSubnet(pool, insert)
      await allocateSubnet(pool, insert)
      const e = await allocateSubnet(pool, insert).catch((x) => x)
      expect(e).toBeInstanceOf(SubnetError)
      expect(e.code).toBe('pool_exhausted')
    } finally {
      config.projectSubnetPool = before
    }
  })

  test('a writer error other than the subnet conflict is not retried', async () => {
    await expect(allocateSubnet(pool, () => pool.query('select 1/0'))).rejects.toThrow(/division by zero/)
  })
})

describe('subnet retries', () => {
  test('a writer that always conflicts stops at the pool size with pool_exhausted', async () => {
    const before = config.projectSubnetPool
    let calls = 0
    const conflict = async () => { calls++; throw Object.assign(new Error('dup'), { code: '23505', constraint: 'projects_subnet_key' }) }
    try {
      config.projectSubnetPool = '10.207.0.0/25'
      expect((await allocateSubnet(pool, conflict).catch((x) => x)).code).toBe('pool_exhausted')
      expect(calls).toBe(4)
    } finally {
      config.projectSubnetPool = before
    }
  })
})
