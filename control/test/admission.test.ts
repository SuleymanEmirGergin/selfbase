import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { config } from '../src/config.ts'
import { pool } from '../src/db.ts'
import { newRef } from '../src/ids.ts'
import { admit, AdmissionError, capacity, usedMb, type Size } from '../src/admission.ts'

// global constraints; template/sizes.json is Task 5's, so the tests bring their own table
const SIZES = {
  micro: { db: { mem_mb: 512 }, rest: { mem_mb: 128 }, core: { mem_mb: 256 }, fn: { mem_mb: 256 }, pooler: { mem_mb: 32 } },
  small: { db: { mem_mb: 1024 }, rest: { mem_mb: 256 }, core: { mem_mb: 512 }, fn: { mem_mb: 512 }, pooler: { mem_mb: 32 } },
  medium: { db: { mem_mb: 2048 }, rest: { mem_mb: 256 }, core: { mem_mb: 512 }, fn: { mem_mb: 1024 }, pooler: { mem_mb: 32 } },
}

let orgId: string
let n = 0
const add = async (size: Size, status = 'ACTIVE_HEALTHY'): Promise<string> =>
  (await pool.query(`insert into control.projects (ref, org_id, name, status, size, subnet) values ($1, $2, 'p', $3, $4, $5) returning id`,
    [newRef(), orgId, status, size, `10.207.${n++}.0/27`])).rows[0].id
// admit, then record the project as running (what createProject does)
const create = async (size: Size) => {
  await admit(pool, { size }, SIZES)
  return add(size)
}
const refusal = (p: Promise<unknown>) => p.then(() => { throw new Error('admitted') }, (e) => e)

beforeEach(async () => {
  // admission sums every running project, so the table must hold only this test's rows
  await pool.query('delete from control.projects')
  orgId = (await pool.query(`insert into control.organizations (slug, name) values ($1, 'o') returning id`, [`o-${newRef()}`])).rows[0].id
  n = 0
})
afterEach(() => { config.overcommit = 1 })

describe('admission', () => {
  test('with the defaults 11 micro are admitted and the 12th throws with freeMb 128', async () => {
    for (let i = 0; i < 11; i++) await create('micro')
    const e = await refusal(create('micro'))
    expect(e).toBeInstanceOf(AdmissionError)
    expect(e.code).toBe('insufficient_memory')
    expect(e.details).toEqual({ neededMb: 1184, freeMb: 128 })
    expect(e.message).toMatch(/128 MiB/)
    expect(e.message).toMatch(/1184 MiB/)
    expect(await usedMb(pool, SIZES)).toBe(11 * 1184)
  })

  test('one small plus 9 micro fit and a 10th micro throws', async () => {
    await create('small')
    for (let i = 0; i < 9; i++) await create('micro')
    const e = await refusal(create('micro'))
    expect(e.code).toBe('insufficient_memory')
    expect(e.details.freeMb).toBe(13152 - 2336 - 9 * 1184)
  })

  test('a paused project does not count, and resuming it is refused when the budget is full', async () => {
    const paused = await add('micro', 'INACTIVE')
    await add('micro', 'REMOVED')
    for (let i = 0; i < 11; i++) await create('micro')
    expect(await usedMb(pool, SIZES)).toBe(11 * 1184)
    const e = await refusal(admit(pool, { size: 'micro', excludeProjectId: paused }, SIZES))
    expect(e.code).toBe('insufficient_memory')
  })

  test('a status admission does not know counts as running', async () => {
    await add('micro', 'RESIZING')
    await add('micro', 'COMING_UP')
    expect(await usedMb(pool, SIZES)).toBe(2 * 1184)
  })

  test('a resize excludes the project being resized', async () => {
    const big = await add('medium')
    for (let i = 0; i < 7; i++) await add('micro')
    // 3872 + 7 * 1184 = 12160 used, 992 free: medium -> medium fits only without counting itself
    await admit(pool, { size: 'medium', excludeProjectId: big }, SIZES)
    expect((await refusal(admit(pool, { size: 'medium' }, SIZES))).code).toBe('insufficient_memory')
  })

  test('OVERCOMMIT=1.5 admits more', async () => {
    config.overcommit = 1.5
    for (let i = 0; i < 12; i++) await create('micro')
    // 16384 * 1.5 - 3232 = 21344 -> 18 micro
    for (let i = 0; i < 6; i++) await create('micro')
    expect((await refusal(create('micro'))).code).toBe('insufficient_memory')
  })

  test('capacity reports the budget from the node row', async () => {
    await add('micro')
    expect(await capacity(pool, SIZES)).toEqual({ budget_mb: 16384, reserved_mb: 2720, job_slot_mb: 512, used_mb: 1184, free_mb: 16384 - 3232 - 1184 })
  })

  test('the node row follows MEMORY_BUDGET_MB after a restart', async () => {
    const { migrate } = await import('../src/db.ts')
    const before = config.memoryBudgetMb
    try {
      config.memoryBudgetMb = 8192
      await migrate()
      expect((await capacity(pool, SIZES)).budget_mb).toBe(8192)
    } finally {
      config.memoryBudgetMb = before
      await migrate()
    }
  })
})
