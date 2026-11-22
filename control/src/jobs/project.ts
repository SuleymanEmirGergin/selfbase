// Project lifecycle jobs (spec 7.6). Every step is idempotent: running a finished step again changes nothing, so
// a job resumed after a restart can repeat the step it was in.
import pg from 'pg'
import { admit, type Size } from '../admission.ts'
import { config } from '../config.ts'
import { ApiError } from '../errors.ts'
import { allocateHost, releaseHost } from '../hosts.ts'
import { newRef } from '../ids.ts'
import { loadProjectEnv } from '../project-env.ts'
import { generateProjectSecrets } from '../project-secrets.ts'
import { getSecrets, putSecret } from '../secrets.ts'
import { allocateSubnet } from '../subnets.ts'
import { defineJob, enqueue, type JobCtx, type Project } from './engine.ts'

// admit reserves nothing: every admission and the status change that makes the project count run under this lock
const ADMISSION_LOCK = 7213018

/**
 * One transaction holding the admission lock. A savepoint around each subnet try keeps allocateSubnet's
 * conflict-and-retry inside it (a unique violation rolls back to the savepoint, not the transaction).
 */
async function withAdmission<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('select pg_advisory_xact_lock($1)', [ADMISSION_LOCK])
    const out = await fn(c)
    await c.query('commit')
    return out
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

async function savepoint<T>(c: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await c.query('savepoint subnet_try')
  try {
    const out = await fn()
    await c.query('release savepoint subnet_try')
    return out
  } catch (e) {
    await c.query('rollback to savepoint subnet_try')
    throw e
  }
}

export type CreateInput = { orgId: string; name: string; size: Size; pool: 'project' | 'test'; createdBy: string | null
  reuseSecrets?: Record<string, string>; dbPass?: string }

/** Admits, inserts the row (status COMING_UP, so it counts at once) and enqueues project.create, all or nothing. */
export async function createProject(pool: pg.Pool, input: CreateInput): Promise<{ project: Project; jobId: string }> {
  const ref = newRef()
  const given = { ...input.reuseSecrets, ...(input.dbPass ? { POSTGRES_PASSWORD: input.dbPass } : {}) }
  try {
    generateProjectSecrets(ref, given)
  } catch (e) {
    throw new ApiError(400, 'invalid_secrets', (e as Error).message)
  }
  return withAdmission(pool, async (c) => {
    await admit(c, { size: input.size })
    const version = (await c.query(`select value from control.settings where key = 'current_template_version'`)).rows[0]?.value
      ?? config.templateVersion
    let project!: Project
    await allocateSubnet(c, (subnet) => savepoint(c, async () => {
      project = (await c.query(
        `insert into control.projects (ref, org_id, name, status, size, template_version, subnet, node_id)
         values ($1, $2, $3, 'COMING_UP', $4, $5, $6, (select id from control.nodes where name = $7)) returning *`,
        [ref, input.orgId, input.name, input.size, version, subnet, config.nodeName],
      )).rows[0]
    }))
    // in the request: the values never enter the job payload
    for (const [name, value] of Object.entries(given)) await putSecret(c, project, name, 'platform', value)
    const jobId = await enqueue(c, { type: 'project.create', projectId: project.id, payload: { pool: input.pool }, createdBy: input.createdBy })
    return { project, jobId }
  })
}

const need = (ctx: JobCtx): Project => ctx.project ?? (() => { throw new Error('the job has no project') })()
const setStatus = (ctx: JobCtx, status: string) => ctx.db.query('update control.projects set status = $2 where id = $1', [need(ctx).id, status])
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function ensure(ctx: JobCtx, recreate: string[] = []) {
  const p = need(ctx)
  const { env, hosts } = await loadProjectEnv(ctx.db, p)
  // only hosts that came through allocateHost or LEGACY_HOSTNAMES may route under the base domain (one cert each)
  const base = config.baseDomain.toLowerCase()
  const slots = new Set((await ctx.db.query('select hostname from control.host_slots where project_id = $1', [p.id])).rows.map((r) => r.hostname))
  for (const h of hosts) {
    if ((h === base || h.endsWith(`.${base}`)) && !slots.has(h) && !config.legacyHostnames.includes(h)) {
      throw new Error(`${h} is under ${base} but holds no host slot and is not a legacy hostname`)
    }
  }
  await ctx.provisioner.ensure({ ref: p.ref, templateVersion: p.template_version ?? config.templateVersion, size: p.size,
    subnet: p.subnet, hosts, env, recreate })
}

async function healthy(ctx: JobCtx) {
  const p = need(ctx)
  const until = Date.now() + ctx.waits.healthyMs
  for (;;) {
    const s = await ctx.provisioner.inspect(p.ref)
    const bad = s.services.filter((x) => !x.exists || x.state !== 'running' || (x.health !== null && x.health !== 'healthy'))
    if (s.services.length && !bad.length) return
    if (Date.now() >= until) throw new Error(`not healthy within ${ctx.waits.healthyMs / 1000} s: ${bad.map((x) => x.service).join(', ')}`)
    await pause(ctx.waits.pollMs)
  }
}

async function certificate(ctx: JobCtx) {
  const host = (await loadProjectEnv(ctx.db, need(ctx))).hosts[0]
  const until = Date.now() + ctx.waits.certificateMs
  while ((await ctx.probe(host)) !== 'ok') {
    if (Date.now() >= until) throw new Error(`the certificate for ${host} is not issued yet`)
    await pause(ctx.waits.pollMs)
  }
}

const step = (name: string, run: (ctx: JobCtx) => Promise<unknown>) => ({ name, run: async (ctx: JobCtx) => { await run(ctx) } })
const healthySteps = [step('healthy', healthy)]
const activate = step('activate', (ctx) => setStatus(ctx, 'ACTIVE_HEALTHY'))
// the status a failed job leaves, unless it failed at a step listed in `keep` (status unchanged)
const failTo = (status: string, keep: string[] = []) => ({
  onFail: async (ctx: JobCtx) => { if (ctx.project && !keep.includes(ctx.step)) await setStatus(ctx, status) },
})

// onFail releases nothing: the operator deletes or retries. A certificate that is late leaves COMING_UP, and
// reconcile turns it ACTIVE_HEALTHY once the probe passes.
defineJob('project.create', 'light', [
  step('allocate', (ctx) => allocateHost(ctx.db, { projectId: need(ctx).id, ref: need(ctx).ref, pool: ctx.job.payload.pool ?? 'project' })),
  step('secrets', async (ctx) => {
    const p = need(ctx)
    const have = await getSecrets(ctx.db, p)
    const all = generateProjectSecrets(p.ref, have)
    // one transaction: a crash never leaves JWT_SECRET stored without the keys it signed
    const c = await ctx.db.connect()
    try {
      await c.query('begin')
      for (const [name, value] of Object.entries(all)) if (have[name] !== value) await putSecret(c, p, name, 'platform', value)
      await c.query('commit')
    } catch (e) {
      await c.query('rollback').catch(() => {})
      throw e
    } finally {
      c.release()
    }
  }),
  step('ensure', (ctx) => ensure(ctx)),
  ...healthySteps,
  step('certificate', certificate),
  activate,
], failTo('INIT_FAILED', ['certificate']))

defineJob('project.pause', 'light', [
  step('stop', (ctx) => ctx.provisioner.stop(need(ctx).ref)),
  step('inactive', (ctx) => ctx.db.query(
    `update control.projects set status = 'INACTIVE', paused_at = coalesce(paused_at, now()) where id = $1`, [need(ctx).id])),
], failTo('PAUSE_FAILED'))

// admission refused: the project stays INACTIVE
defineJob('project.restore', 'light', [
  step('admit', (ctx) => withAdmission(ctx.db, async (c) => {
    const p = need(ctx)
    // excluding itself makes a repeated step count the project once
    await admit(c, { size: p.size as Size, excludeProjectId: p.id })
    await c.query(`update control.projects set status = 'RESTORING', paused_at = null where id = $1`, [p.id])
  })),
  step('start', (ctx) => ctx.provisioner.start(need(ctx).ref)),
  ...healthySteps,
  activate,
], failTo('RESTORE_FAILED', ['admit']))

// The REMOVED row keeps its /27 (projects.subnet is not null unique): deleting the row would cascade to this
// job and its history. 2048 /27s in the default pool; purging old REMOVED rows is left to a later task.
defineJob('project.delete', 'light', [
  step('remove', (ctx) => ctx.provisioner.remove(need(ctx).ref, true)),
  step('release', (ctx) => releaseHost(ctx.db, need(ctx).id)),
  step('secrets', (ctx) => ctx.db.query('delete from control.project_secrets where project_id = $1', [need(ctx).id])),
  step('removed', (ctx) => setStatus(ctx, 'REMOVED')),
], failTo('ACTIVE_UNHEALTHY'))

const recreateOf = (ctx: JobCtx): string[] => (Array.isArray(ctx.job.payload.recreate) ? ctx.job.payload.recreate : [])

defineJob('project.apply', 'light', [step('ensure', (ctx) => ensure(ctx, recreateOf(ctx)))], failTo('ACTIVE_UNHEALTHY'))

defineJob('project.upgrade', 'light', [
  step('version', (ctx) => ctx.db.query(
    `update control.projects set status = 'UPGRADING',
       template_version = (select value from control.settings where key = 'current_template_version') where id = $1`, [need(ctx).id])),
  step('ensure', (ctx) => ensure(ctx, recreateOf(ctx))),
  ...healthySteps,
  activate,
], failTo('ACTIVE_UNHEALTHY'))

export { withAdmission }
