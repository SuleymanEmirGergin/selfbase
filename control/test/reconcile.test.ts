import { beforeEach, expect, test } from 'vitest'
import { pool } from '../src/db.ts'
import { newRef } from '../src/ids.ts'
import { reconcileOnce } from '../src/reconcile.ts'
import { enqueue, startWorkers } from '../src/jobs/index.ts'
import { FakeProvisioner } from './fake-provisioner.ts'

let fake: FakeProvisioner
let cert: 'ok' | 'pending'
let orgId: string
let n = 0
const deps = () => ({ db: pool, provisioner: fake, probe: async () => cert })
const add = async (status: string) => {
  const ref = newRef()
  const id = (await pool.query(
    `insert into control.projects (ref, org_id, name, status, size, subnet, template_version) values ($1, $2, 'p', $3, 'micro', $4, 'test') returning id`,
    [ref, orgId, status, `10.207.${n++}.0/27`])).rows[0].id
  await pool.query(`insert into control.project_domains (project_id, hostname, kind) values ($1, $2, 'default')`, [id, `${ref}.example.test`])
  return { id, ref }
}
const jobsOf = async (id: string) => (await pool.query('select type, status, payload from control.jobs where project_id = $1', [id])).rows
const status = async (id: string) => (await pool.query('select status from control.projects where id = $1', [id])).rows[0].status

beforeEach(async () => {
  await pool.query('delete from control.projects')
  fake = new FakeProvisioner()
  cert = 'ok'
  n = 0
  orgId = (await pool.query(`insert into control.organizations (slug, name) values ($1, 'o') returning id`, [`o-${newRef()}`])).rows[0].id
})

test('a missing container enqueues project.apply once, even after three passes', async () => {
  const p = await add('ACTIVE_HEALTHY')
  fake.running(p.ref, 'test')
  fake.set(p.ref, 'rest', { exists: false, state: null })
  for (let i = 0; i < 3; i++) await reconcileOnce(deps())
  expect(await jobsOf(p.id)).toEqual([{ type: 'project.apply', status: 'pending', payload: { recreate: [] } }])
})

test('an exited container, another template version, a detached control network or a stale proxy address also enqueue project.apply', async () => {
  const a = await add('ACTIVE_HEALTHY')
  const b = await add('ACTIVE_HEALTHY')
  const c = await add('ACTIVE_HEALTHY')
  const d = await add('ACTIVE_HEALTHY')
  for (const p of [a, b, c, d]) fake.running(p.ref, 'test')
  fake.set(a.ref, 'fn', { state: 'exited' })
  fake.set(b.ref, 'core', { templateVersion: 'old' })
  fake.projects.get(c.ref)!.controlAttached = false
  fake.set(d.ref, 'core', { proxyStale: true })
  await reconcileOnce(deps())
  for (const p of [a, b, c, d]) expect((await jobsOf(p.id)).map((j) => j.type), p.ref).toEqual(['project.apply'])
  // a dead service is not healthy; a version or network drift alone says nothing about health
  expect(await status(a.id)).toBe('ACTIVE_UNHEALTHY')
  for (const p of [b, c, d]) expect(await status(p.id)).toBe('ACTIVE_HEALTHY')
})

test('a crash-looping service makes the project ACTIVE_UNHEALTHY; repeated applies back off, capped', async () => {
  const p = await add('ACTIVE_HEALTHY')
  fake.running(p.ref, 'test')
  fake.set(p.ref, 'fn', { state: 'restarting' })
  // three applies of reconcile's own already ran in the last hours, the last one just now
  for (let i = 0; i < 3; i++) {
    await pool.query(`insert into control.jobs (type, project_id, lane, status) values ('project.apply', $1, 'light', 'succeeded')`, [p.id])
  }
  const r = await reconcileOnce(deps())
  expect(await status(p.id)).toBe('ACTIVE_UNHEALTHY')
  expect(r.actions).toContainEqual({ ref: p.ref, action: 'backoff' })
  expect((await jobsOf(p.id)).filter((j) => j.status === 'pending')).toEqual([])
  // the fourth waits 4 minutes after the third ended
  await pool.query(`update control.jobs set updated_at = now() - interval '3 minutes' where project_id = $1`, [p.id])
  await reconcileOnce(deps())
  expect((await jobsOf(p.id)).filter((j) => j.status === 'pending')).toEqual([])
  await pool.query(`update control.jobs set updated_at = now() - interval '5 minutes' where project_id = $1`, [p.id])
  await reconcileOnce(deps())
  expect((await jobsOf(p.id)).filter((j) => j.status === 'pending')).toHaveLength(1)
  // never more than an hour apart, however many failed
  await pool.query(`delete from control.jobs where project_id = $1`, [p.id])
  for (let i = 0; i < 20; i++) {
    await pool.query(`insert into control.jobs (type, project_id, lane, status, updated_at) values ('project.apply', $1, 'light', 'failed', now() - interval '61 minutes')`, [p.id])
  }
  await reconcileOnce(deps())
  expect((await jobsOf(p.id)).filter((j) => j.status === 'pending')).toHaveLength(1)
})

test("reconcile's finished applies older than a week are deleted; other jobs stay", async () => {
  const p = await add('ACTIVE_HEALTHY')
  fake.running(p.ref, 'test')
  const old = `now() - interval '8 days'`
  await pool.query(`insert into control.jobs (type, project_id, lane, status, created_at) values
    ('project.apply', $1, 'light', 'failed', ${old}), ('project.apply', $1, 'light', 'succeeded', now()),
    ('project.backup', $1, 'heavy', 'succeeded', ${old})`, [p.id])
  await pool.query(`insert into control.jobs (type, project_id, lane, status, created_at, created_by) values
    ('project.apply', $1, 'light', 'succeeded', ${old}, gen_random_uuid())`, [p.id])
  await reconcileOnce(deps())
  expect((await pool.query('select type, created_by is null as auto from control.jobs where project_id = $1 order by type, auto', [p.id])).rows)
    .toEqual([{ type: 'project.apply', auto: false }, { type: 'project.apply', auto: true }, { type: 'project.backup', auto: true }])
})

test('a release apply that failed is retried with core recreated, under the backoff, until one succeeds', async () => {
  const p = await add('ACTIVE_HEALTHY')
  fake.running(p.ref, 'test')
  await pool.query(`insert into control.jobs (type, project_id, lane, status, payload) values
    ('project.apply', $1, 'light', 'failed', '{"recreate":["core"],"released":"gone.example.test"}')`, [p.id])
  const pending = async () => (await jobsOf(p.id)).filter((j) => j.status === 'pending')
  // the failed one just ended: the first retry waits a minute like any of reconcile's applies
  expect((await reconcileOnce(deps())).actions).toContainEqual({ ref: p.ref, action: 'backoff' })
  expect(await pending()).toEqual([])
  await pool.query(`update control.jobs set updated_at = now() - interval '2 minutes' where project_id = $1`, [p.id])
  expect((await reconcileOnce(deps())).actions).toContainEqual({ ref: p.ref, action: 'apply release' })
  expect(await pending()).toEqual([{ type: 'project.apply', status: 'pending', payload: { recreate: ['core'] } }])
  // once a later apply succeeded the router no longer has the name: nothing more to do
  await pool.query(`update control.jobs set status = 'succeeded', updated_at = now() - interval '2 hours' where project_id = $1 and status = 'pending'`, [p.id])
  await reconcileOnce(deps())
  expect(await pending()).toEqual([])
})

test("a failed release apply older than a week is kept while it still holds its name", async () => {
  const p = await add('ACTIVE_HEALTHY')
  fake.running(p.ref, 'test')
  await pool.query(`insert into control.jobs (type, project_id, lane, status, payload, created_at) values
    ('project.apply', $1, 'light', 'failed', '{"recreate":["core"],"released":"gone.example.test"}', now() - interval '8 days')`, [p.id])
  await reconcileOnce(deps())
  expect((await jobsOf(p.id)).filter((j) => j.status === 'failed')).toHaveLength(1)
})

test('a core detached from the proxy network is attached again', async () => {
  const p = await add('ACTIVE_HEALTHY')
  fake.running(p.ref, 'test')
  fake.set(p.ref, 'core', { proxyAttached: false })
  const r = await reconcileOnce(deps())
  expect(fake.callsOf('attachProxy').map((c) => c.args)).toEqual([[p.ref]])
  expect(r.actions).toContainEqual({ ref: p.ref, action: 'attachProxy' })
  expect(await jobsOf(p.id)).toEqual([])
})

test('a running container of a paused project is stopped', async () => {
  const p = await add('INACTIVE')
  fake.running(p.ref, 'test')
  await reconcileOnce(deps())
  expect(fake.callsOf('stop').map((c) => c.args[0])).toEqual([p.ref])
  // stopped now: the next pass does nothing
  await reconcileOnce(deps())
  expect(fake.callsOf('stop')).toHaveLength(1)
})

test('FR2: a project gated by an unconfirmed rotating import gets core, rest, fn and pooler stopped once; later passes are quiet', async () => {
  const importJob = async (projectId: string) => (await pool.query(`insert into control.jobs (type, lane, project_id, step, status, payload)
    values ('project.import', 'heavy', $1, '9', 'failed', $2) returning id`, [projectId, { backup_dir: 'import/o/x', rotate_keys: true, job_version: 2 }])).rows[0].id
  // its onFail stop failed (the provisioner was down): the four still run
  const p = await add('INIT_FAILED')
  fake.running(p.ref, 'test')
  await importJob(p.id)
  // the restore confirmed the deletes before a later step failed: not gated
  const q = await add('INIT_FAILED')
  fake.running(q.ref, 'test')
  await pool.query(`insert into control.job_events (job_id, status, step) values ($1, 'succeeded', 'restored')`, [await importJob(q.id)])
  const first = await reconcileOnce(deps())
  expect(first.actions).toEqual([{ ref: p.ref, action: 'stop sessions_not_deleted' }])
  expect(fake.callsOf('stop').map((c) => c.args)).toEqual([[p.ref, ['core', 'rest', 'fn', 'pooler']]])
  const second = await reconcileOnce(deps())
  expect(second.actions).toEqual([])
  expect(fake.callsOf('stop')).toHaveLength(1)
})

test('an unknown sb- ref is reported and nothing is removed', async () => {
  fake.running('zzzzzzzzzzzzzzzzzzzz', 'test')
  const r = await reconcileOnce(deps())
  expect(r.orphans).toEqual(['zzzzzzzzzzzzzzzzzzzz'])
  expect(fake.calls.filter((c) => !['list', 'inspect'].includes(c.method))).toEqual([])
})

test('a project with a running job is skipped', async () => {
  const p = await add('ACTIVE_HEALTHY')
  await pool.query(`insert into control.jobs (type, project_id, lane, status) values ('project.create', $1, 'light', 'running')`, [p.id])
  const r = await reconcileOnce(deps())
  expect(r.skipped).toEqual([p.ref])
  expect(fake.callsOf('inspect')).toEqual([])
  expect((await jobsOf(p.id))).toHaveLength(1)
})

test('a failing probe turns ACTIVE_HEALTHY into COMING_UP and back; an unhealthy container makes ACTIVE_UNHEALTHY', async () => {
  const p = await add('ACTIVE_HEALTHY')
  fake.running(p.ref, 'test')
  cert = 'pending'
  await reconcileOnce(deps())
  expect(await status(p.id)).toBe('COMING_UP')
  cert = 'ok'
  await reconcileOnce(deps())
  expect(await status(p.id)).toBe('ACTIVE_HEALTHY')
  fake.set(p.ref, 'db', { health: 'unhealthy' })
  await reconcileOnce(deps())
  expect(await status(p.id)).toBe('ACTIVE_UNHEALTHY')
  fake.set(p.ref, 'db', { health: 'healthy' })
  await reconcileOnce(deps())
  expect(await status(p.id)).toBe('ACTIVE_HEALTHY')
})

// runs one job to its end with a worker of its own, as another process would
const runJob = async (type: string, projectId: string) => {
  const id = await enqueue(pool, { type, projectId, payload: {}, createdBy: null })
  const w = startWorkers({ db: pool, provisioner: fake, backoffMs: 1, idleMs: 10 })
  try {
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
      const s = (await pool.query('select status from control.jobs where id = $1', [id])).rows[0].status
      if (s === 'succeeded' || s === 'failed') return s
    }
    throw new Error('timed out')
  } finally {
    await w.stop()
  }
}
// runs whatever the pass enqueued
const drain = async () => {
  const w = startWorkers({ db: pool, provisioner: fake, backoffMs: 1, idleMs: 10 })
  try {
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
      if (!(await pool.query(`select 1 from control.jobs where status in ('pending', 'running')`)).rowCount) return
    }
    throw new Error('timed out')
  } finally {
    await w.stop()
  }
}

test('a delete that runs during a pass never ends ACTIVE_UNHEALTHY and is not undone', async () => {
  const p = await add('ACTIVE_HEALTHY')
  fake.running(p.ref, 'test')
  // the pass reads unhealthy and a container missing; by the time it acts, the project is deleted
  fake.set(p.ref, 'db', { health: 'unhealthy' })
  fake.set(p.ref, 'rest', { exists: false, state: null })
  fake.once('inspect', async () => { expect(await runJob('project.delete', p.id)).toBe('succeeded') })
  await reconcileOnce(deps())
  await drain()
  expect(await status(p.id)).toBe('REMOVED')
  expect(fake.callsOf('ensure')).toEqual([])
  expect((await jobsOf(p.id)).map((j) => j.type)).toEqual(['project.delete'])
})

test('a pause during a pass is not undone', async () => {
  const p = await add('ACTIVE_HEALTHY')
  fake.running(p.ref, 'test')
  fake.set(p.ref, 'fn', { state: 'exited' })
  fake.set(p.ref, 'core', { proxyAttached: false })
  fake.once('inspect', async () => { expect(await runJob('project.pause', p.id)).toBe('succeeded') })
  await reconcileOnce(deps())
  await drain()
  expect(await status(p.id)).toBe('INACTIVE')
  expect(fake.calls.filter((c) => ['ensure', 'start', 'attachProxy'].includes(c.method))).toEqual([])
  expect(fake.state(p.ref).services.every((s) => s.state !== 'running')).toBe(true)
})

test('project.apply leaves a project that should not be running alone', async () => {
  for (const st of ['INACTIVE', 'REMOVED', 'REMOVE_FAILED', 'INIT_FAILED']) {
    const p = await add(st)
    expect(await runJob('project.apply', p.id)).toBe('succeeded')
    expect(await status(p.id)).toBe(st)
  }
  expect(fake.callsOf('ensure')).toEqual([])
})

test('reconcile leaves REMOVE_FAILED alone', async () => {
  const p = await add('REMOVE_FAILED')
  fake.running(p.ref, 'test')
  fake.set(p.ref, 'rest', { exists: false, state: null })
  const r = await reconcileOnce(deps())
  expect(r.actions).toEqual([])
  expect(await jobsOf(p.id)).toEqual([])
})
