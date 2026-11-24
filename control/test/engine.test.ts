import { afterEach, beforeEach, expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import { pool } from '../src/db.ts'
import { defineJob, enqueue, enqueueIfIdle, startWorkers, type Step } from '../src/jobs/engine.ts'
import { newRef } from '../src/ids.ts'
import { FakeProvisioner } from './fake-provisioner.ts'

const fake = new FakeProvisioner()
const running: { stop(): Promise<void> }[] = []
const workers = () => {
  const w = startWorkers({ db: pool, provisioner: fake, backoffMs: 1, idleMs: 20 })
  running.push(w)
  return w
}
const uniq = (name: string) => `test.${name}.${randomBytes(4).toString('hex')}`
const until = async <T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const v = await fn()
    if (v !== undefined) return v
  }
  throw new Error('timed out')
}
const job = (id: string) => pool.query('select * from control.jobs where id = $1', [id]).then((r) => r.rows[0])
const finished = (id: string) => until(async () => {
  const j = await job(id)
  return ['succeeded', 'failed'].includes(j.status) ? j : undefined
})
const events = async (id: string) => (await pool.query('select status, step from control.job_events where job_id = $1 order by id', [id])).rows

beforeEach(async () => { await pool.query('delete from control.jobs') })
afterEach(async () => { await Promise.all(running.splice(0).map((w) => w.stop())) })

test('steps run in order and job_events has one row per step', async () => {
  const seen: string[] = []
  const type = uniq('order')
  defineJob(type, 'light', ['a', 'b', 'c'].map((name) => ({ name, run: async () => { seen.push(name) } })))
  const id = await enqueue(pool, { type, payload: {}, createdBy: null })
  workers()
  const j = await finished(id)
  expect(j.status).toBe('succeeded')
  expect(seen).toEqual(['a', 'b', 'c'])
  expect(await events(id)).toEqual(['a', 'b', 'c'].map((step) => ({ status: 'succeeded', step })))
  expect(j.step).toBe('3')
})

test('a step failing twice then succeeding ends succeeded with attempts 3', async () => {
  let n = 0
  const type = uniq('flaky')
  defineJob(type, 'light', [{ name: 'x', run: async () => { if (++n < 3) throw new Error(`try ${n}`) } }])
  const id = await enqueue(pool, { type, payload: {}, createdBy: null })
  workers()
  const j = await finished(id)
  expect(j).toMatchObject({ status: 'succeeded', attempts: 3, error: null })
})

test('three failures end failed with the message only, and later steps never run', async () => {
  let later = 0
  const type = uniq('fails')
  defineJob(type, 'light', [
    { name: 'x', run: async () => { throw new Error('boom', { cause: new Error('secret-cause') }) } },
    { name: 'y', run: async () => { later++ } },
  ])
  const id = await enqueue(pool, { type, payload: {}, createdBy: null })
  workers()
  const j = await finished(id)
  expect(j).toMatchObject({ status: 'failed', attempts: 3, error: 'boom' })
  expect(later).toBe(0)
  expect(JSON.stringify(await pool.query('select * from control.job_events where job_id = $1', [id]).then((r) => r.rows))).not.toContain('secret-cause')
})

test('a worker stopped after step 2 of 4 leaves the job; a new worker runs steps 3 and 4 once and not 1 and 2 again', async () => {
  const count: Record<string, number> = { s1: 0, s2: 0, s3: 0, s4: 0 }
  let first: { stop(): Promise<void> } | undefined
  let stopped: Promise<void> | undefined
  const type = uniq('resume')
  defineJob(type, 'light', ['s1', 's2', 's3', 's4'].map((name): Step => ({ name, run: async () => {
    count[name]++
    if (name === 's2' && !stopped) stopped = first!.stop()
  } })))
  const id = await enqueue(pool, { type, payload: {}, createdBy: null })
  first = workers()
  await until(async () => (stopped ? true : undefined))
  await stopped
  expect(await job(id)).toMatchObject({ status: 'running', step: '2' })
  expect(count).toEqual({ s1: 1, s2: 1, s3: 0, s4: 0 })
  workers()
  expect((await finished(id)).status).toBe('succeeded')
  expect(count).toEqual({ s1: 1, s2: 1, s3: 1, s4: 1 })
})

test('a heavy job does not block a light one', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const heavy = uniq('heavy')
  const light = uniq('light')
  defineJob(heavy, 'heavy', [{ name: 'wait', run: () => gate }])
  defineJob(light, 'light', [{ name: 'go', run: async () => {} }])
  const h = await enqueue(pool, { type: heavy, payload: {}, createdBy: null })
  const l = await enqueue(pool, { type: light, payload: {}, createdBy: null })
  workers()
  expect((await finished(l)).status).toBe('succeeded')
  await until(async () => ((await job(h)).status === 'running' ? true : undefined))
  expect((await job(h)).step).toBe('0')
  release()
  expect((await finished(h)).status).toBe('succeeded')
})

test('two workers never run one job twice', async () => {
  const runs = new Map<string, number>()
  const type = uniq('race')
  defineJob(type, 'light', [{ name: 'x', run: async (ctx) => {
    runs.set(ctx.job.id, (runs.get(ctx.job.id) ?? 0) + 1)
    await new Promise((r) => setTimeout(r, 30))
  } }])
  const ids = await Promise.all(Array.from({ length: 12 }, () => enqueue(pool, { type, payload: {}, createdBy: null })))
  workers()
  workers()
  for (const id of ids) expect((await finished(id)).status).toBe('succeeded')
  expect(ids.map((id) => runs.get(id))).toEqual(ids.map(() => 1))
})

test('enqueue refuses a secret name anywhere in the payload, and an over-long value', async () => {
  const type = uniq('payload')
  defineJob(type, 'light', [])
  await expect(enqueue(pool, { type, payload: { JWT_SECRET: 'x' }, createdBy: null })).rejects.toThrow(/JWT_SECRET/)
  await expect(enqueue(pool, { type, payload: { a: [{ SMTP_PASS: 'x' }] }, createdBy: null })).rejects.toThrow(/SMTP_PASS/)
  await expect(enqueue(pool, { type, payload: { jwt_secret: 'x' }, createdBy: null })).rejects.toThrow(/jwt_secret/)
  await expect(enqueue(pool, { type, payload: { Service_Role_Key: 'x' }, createdBy: null })).rejects.toThrow(/Service_Role_Key/)
  await expect(enqueue(pool, { type, payload: { a: 'x'.repeat(2049) }, createdBy: null })).rejects.toThrow(/2048/)
  const err = await enqueue(pool, { type, payload: { JWT_SECRET: 'the-value' }, createdBy: null }).catch((e) => e)
  expect(err.message).not.toContain('the-value')
  expect((await pool.query('select count(*)::int as n from control.jobs')).rows[0].n).toBe(0)
})

// a bare project row: jobs.project_id needs one
let subnetN = 0
const projectRow = async () => {
  // rows a previous run left in this range
  if (subnetN === 0) await pool.query(`delete from control.projects where subnet << '10.252.0.0/16'`)
  const org = (await pool.query(`insert into control.organizations (slug, name) values ($1, 'o') returning id`, [`e-${newRef()}`])).rows[0].id
  const n = subnetN++
  return (await pool.query(`insert into control.projects (ref, org_id, name, status, size, subnet) values ($1, $2, 'p', 'ACTIVE_HEALTHY', 'micro', $3) returning id`,
    [newRef(), org, `10.252.${Math.floor(n / 8)}.${(n % 8) * 32}/27`])).rows[0].id as string
}

test('S5: 20 concurrent enqueueIfIdle calls for one project give exactly one active job (5 rounds)', async () => {
  const type = uniq('idle')
  defineJob(type, 'light', [])
  for (let round = 0; round < 5; round++) {
    const projectId = await projectRow()
    const ids = await Promise.all(Array.from({ length: 20 }, () => enqueueIfIdle(pool, { type, projectId, payload: {}, createdBy: null })))
    expect(ids.filter(Boolean), `round ${round}`).toHaveLength(1)
    expect((await pool.query(`select count(*)::int as n from control.jobs where project_id = $1 and status in ('pending', 'running')`, [projectId])).rows[0].n).toBe(1)
  }
})

test('S5: the light and heavy lanes never run two jobs of one project at once; other projects are not held up', async () => {
  const active = new Map<string, number>()
  let overlap = 0
  const busy = (ms: number) => async (ctx: Parameters<Step['run']>[0]) => {
    const n = (active.get(ctx.job.project_id!) ?? 0) + 1
    active.set(ctx.job.project_id!, n)
    if (n > 1) overlap++
    await new Promise((r) => setTimeout(r, ms))
    active.set(ctx.job.project_id!, (active.get(ctx.job.project_id!) ?? 1) - 1)
  }
  const heavy = uniq('heavy-p')
  const light = uniq('light-p')
  defineJob(heavy, 'heavy', [{ name: 'backup', run: busy(400) }])
  defineJob(light, 'light', [{ name: 'pause', run: busy(100) }])
  const one = await projectRow()
  const two = await projectRow()
  const h = await enqueue(pool, { type: heavy, projectId: one, payload: {}, createdBy: null })
  const l = await enqueue(pool, { type: light, projectId: one, payload: {}, createdBy: null })
  const other = await enqueue(pool, { type: light, projectId: two, payload: {}, createdBy: null })
  workers()
  // another project's light job runs while project one's backup holds it
  expect((await finished(other)).status).toBe('succeeded')
  expect((await job(h)).status).not.toBe('succeeded')
  for (const id of [h, l]) expect((await finished(id)).status).toBe('succeeded')
  expect(overlap).toBe(0)
})
