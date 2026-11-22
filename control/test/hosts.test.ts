import { beforeEach, describe, expect, test } from 'vitest'
import { config } from '../src/config.ts'
import { pool } from '../src/db.ts'
import { newRef } from '../src/ids.ts'
import { addDomain, allocateHost, HostError, hostsOf, newHostsThisWeek, releaseHost, removeDomain } from '../src/hosts.ts'

const BASE = config.baseDomain
let orgId: string
let n = 0
const project = async () => {
  const ref = newRef()
  const id = (await pool.query(`insert into control.projects (ref, org_id, name, status, size, subnet) values ($1, $2, 'p', 'COMING_UP', 'micro', $3) returning id`,
    [ref, orgId, `10.207.${Math.floor(n / 8)}.${(n++ % 8) * 32}/27`])).rows[0].id
  return { projectId: id as string, ref }
}
const setControlHost = (when: string) =>
  pool.query(`insert into control.settings (key, value) values ('control_host_first_issued_at', $1)
              on conflict (key) do update set value = excluded.value`, [when])
const refusal = (p: Promise<unknown>) => p.then(() => { throw new Error('accepted') }, (e) => e)

beforeEach(async () => {
  // the cap counts every slot, so each test starts with none
  await pool.query('delete from control.projects')
  await pool.query('delete from control.host_slots')
  await pool.query(`delete from control.settings where key = 'control_host_first_issued_at'`)
  orgId = (await pool.query(`insert into control.organizations (slug, name) values ($1, 'o') returning id`, [`o-${newRef()}`])).rows[0].id
  n = 0
})

describe('host slots and the weekly cap', () => {
  test('cap 3 with the control host recorded today: two new hosts succeed, the third throws new_host_cap', async () => {
    await setControlHost(new Date().toISOString())
    expect(await newHostsThisWeek(pool)).toBe(1)
    const a = await project()
    expect(await allocateHost(pool, { ...a, pool: 'project' })).toEqual({ hostname: `${a.ref}.${BASE}`, isNew: true })
    await allocateHost(pool, { ...(await project()), pool: 'project' })
    expect(await newHostsThisWeek(pool)).toBe(3)
    const e = await refusal(allocateHost(pool, { ...(await project()), pool: 'project' }))
    expect(e).toBeInstanceOf(HostError)
    expect(e.code).toBe('new_host_cap')
    expect(e.details.cap).toBe(3)
    // the oldest of the three (the control host, today) leaves the window in 7 days
    expect(Date.parse(e.details.retryAfter) - Date.now()).toBeGreaterThan(6.9 * 86400e3)
    expect(e.message).toMatch(/3 new hostnames/)
    expect(e.message).toContain(e.details.retryAfter.slice(0, 10))
    expect(await hostsOf(pool, a.projectId)).toEqual([`${a.ref}.${BASE}`])
  })

  test('release then allocate returns the freed hostname with isNew false, and it does not count again', async () => {
    const a = await project()
    const { hostname } = await allocateHost(pool, { ...a, pool: 'project' })
    await releaseHost(pool, a.projectId)
    expect(await hostsOf(pool, a.projectId)).toEqual([])
    const b = await project()
    expect(await allocateHost(pool, { ...b, pool: 'project' })).toEqual({ hostname, isNew: false })
    expect(await hostsOf(pool, b.projectId)).toEqual([hostname])
    expect(await newHostsThisWeek(pool)).toBe(1)
  })

  test('a second allocation for the same project returns its host', async () => {
    const a = await project()
    const first = await allocateHost(pool, { ...a, pool: 'project' })
    expect(await allocateHost(pool, { ...a, pool: 'project' })).toEqual({ hostname: first.hostname, isNew: false })
    expect(await newHostsThisWeek(pool)).toBe(1)
  })

  test('deleting a project frees its slot', async () => {
    const a = await project()
    const { hostname } = await allocateHost(pool, { ...a, pool: 'project' })
    await pool.query('delete from control.projects where id = $1', [a.projectId])
    expect(await allocateHost(pool, { ...(await project()), pool: 'project' })).toEqual({ hostname, isNew: false })
  })

  test('two concurrent allocations with one new host left: exactly one succeeds (20 runs)', async () => {
    for (let run = 0; run < 20; run++) {
      await pool.query('delete from control.host_slots')
      await setControlHost(new Date().toISOString())
      await allocateHost(pool, { ...(await project()), pool: 'project' })
      const [x, y] = [await project(), await project()]
      const results = await Promise.allSettled([allocateHost(pool, { ...x, pool: 'project' }), allocateHost(pool, { ...y, pool: 'project' })])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const failed = results.filter((r) => r.status === 'rejected')
      expect(failed).toHaveLength(1)
      expect((failed[0] as PromiseRejectedResult).reason.code).toBe('new_host_cap')
      expect(await newHostsThisWeek(pool)).toBe(3)
    }
  })

  test('a slot issued 8 days ago does not count', async () => {
    const a = await project()
    await pool.query(`insert into control.host_slots (hostname, pool, project_id, first_issued_at) values ($1, 'project', $2, now() - interval '8 days')`,
      [`old.${BASE}`, a.projectId])
    await setControlHost(new Date(Date.now() - 8 * 86400e3).toISOString())
    expect(await newHostsThisWeek(pool)).toBe(0)
  })

  test('the test pool gives TEST_HOST; a second concurrent holder gets test_host_busy', async () => {
    const [x, y] = [await project(), await project()]
    const results = await Promise.allSettled([allocateHost(pool, { ...x, pool: 'test' }), allocateHost(pool, { ...y, pool: 'test' })])
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ hostname: string; isNew: boolean }>[]
    expect(ok.map((r) => r.value)).toEqual([{ hostname: config.testHost, isNew: true }])
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('test_host_busy')
    expect(await newHostsThisWeek(pool)).toBe(1)
    // released, the next test project takes it without a new host
    const holder = (await pool.query(`select project_id from control.host_slots where pool = 'test'`)).rows[0].project_id
    await releaseHost(pool, holder)
    expect(await allocateHost(pool, { ...(await project()), pool: 'test' })).toEqual({ hostname: config.testHost, isNew: false })
  })

  test('the test host counts against the cap', async () => {
    await setControlHost(new Date().toISOString())
    await allocateHost(pool, { ...(await project()), pool: 'project' })
    await allocateHost(pool, { ...(await project()), pool: 'project' })
    expect((await refusal(allocateHost(pool, { ...(await project()), pool: 'test' }))).code).toBe('new_host_cap')
  })
})

describe('domains', () => {
  test('custom under the base domain is refused; legacy and custom elsewhere do not count', async () => {
    const a = await project()
    await allocateHost(pool, { ...a, pool: 'project' })
    expect((await refusal(addDomain(pool, a.projectId, `shop.${BASE}`, 'custom'))).code).toBe('custom_under_base')
    expect((await refusal(addDomain(pool, a.projectId, BASE, 'custom'))).code).toBe('custom_under_base')
    await addDomain(pool, a.projectId, `legacy.${BASE}`, 'legacy')
    await addDomain(pool, a.projectId, 'API.Example.com', 'custom')
    expect(await hostsOf(pool, a.projectId)).toEqual([`${a.ref}.${BASE}`, 'api.example.com', `legacy.${BASE}`])
    expect(await newHostsThisWeek(pool)).toBe(1)
    expect(await removeDomain(pool, a.projectId, 'api.example.com')).toBe(true)
    // the default host is not removed this way
    expect(await removeDomain(pool, a.projectId, `${a.ref}.${BASE}`)).toBe(false)
    expect(await hostsOf(pool, a.projectId)).toEqual([`${a.ref}.${BASE}`, `legacy.${BASE}`])
  })

  test('a duplicate hostname is refused', async () => {
    const [a, b] = [await project(), await project()]
    const { hostname } = await allocateHost(pool, { ...a, pool: 'project' })
    await addDomain(pool, a.projectId, 'api.example.com', 'custom')
    expect((await refusal(addDomain(pool, b.projectId, 'api.example.com', 'custom'))).code).toBe('hostname_taken')
    expect((await refusal(addDomain(pool, b.projectId, hostname, 'legacy'))).code).toBe('hostname_taken')
    // a free slot is still a certified host another project will get
    await releaseHost(pool, a.projectId)
    expect((await refusal(addDomain(pool, b.projectId, hostname, 'legacy'))).code).toBe('hostname_taken')
  })

  test('a hostname that is not a DNS name is refused', async () => {
    const a = await project()
    for (const h of ['a`) || Host(`evil', 'no_underscore.com', 'single', '-a.com', ''])
      expect((await refusal(addDomain(pool, a.projectId, h, 'custom'))).code).toBe('invalid_hostname')
  })
})
