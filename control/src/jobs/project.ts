// Project lifecycle jobs (spec 7.6). Every step is idempotent: running a finished step again changes nothing, so
// a job resumed after a restart can repeat the step it was in.
import pg from 'pg'
import { admit, AdmissionError, type Size } from '../admission.ts'
import { config } from '../config.ts'
import { forgetCoreIp } from '../core-addr.ts'
import { ApiError } from '../errors.ts'
import { allocateHost, assertRoutable, hostsOf, precheckHost, releaseDomains, releaseHost } from '../hosts.ts'
import { newRef } from '../ids.ts'
import { loadProjectEnv } from '../project-env.ts'
import { generateProjectSecrets } from '../project-secrets.ts'
import { getSecrets, jwtSecretInUse, putSecret } from '../secrets.ts'
import { allocateSubnet } from '../subnets.ts'
import { defineJob, enqueue, DESIRED_RUNNING, type JobCtx, type Project } from './engine.ts'

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
  reuseSecrets?: Record<string, string>; dbPass?: string
  /** an import: project_config rows by section, and the job that brings the project up instead of project.create */
  config?: Record<string, Record<string, unknown>>
  job?: { type: string; status: string; payload: Record<string, unknown> } }

/**
 * Admits, inserts the row (status COMING_UP, or the job's status, so it counts at once) and enqueues project.create
 * (or input.job), all or nothing.
 */
export async function createProject(pool: pg.Pool, input: CreateInput): Promise<{ project: Project; jobId: string }> {
  const ref = newRef()
  const given: Record<string, string> = { ...input.reuseSecrets, ...(input.dbPass ? { POSTGRES_PASSWORD: input.dbPass } : {}) }
  try {
    generateProjectSecrets(ref, given)
  } catch (e) {
    throw new ApiError(400, 'invalid_secrets', (e as Error).message)
  }
  return withAdmission(pool, async (c) => {
    // under the admission lock: two imports of one export cannot both pass
    if (given.JWT_SECRET && await jwtSecretInUse(c, given.JWT_SECRET)) {
      throw new ApiError(409, 'keys_in_use', 'This export is already live here as another project: its JWT secret and keys are in use. '
        + 'Import it with new keys (rotate_keys), or delete the other project first.')
    }
    await admit(c, { size: input.size })
    await precheckHost(c, input.pool, input.orgId)
    const version = (await c.query(`select value from control.settings where key = 'current_template_version'`)).rows[0]?.value
      ?? config.templateVersion
    let project!: Project
    await allocateSubnet(c, (subnet) => savepoint(c, async () => {
      project = (await c.query(
        `insert into control.projects (ref, org_id, name, status, size, template_version, subnet, node_id)
         values ($1, $2, $3, $8, $4, $5, $6, (select id from control.nodes where name = $7)) returning *`,
        [ref, input.orgId, input.name, input.size, version, subnet, config.nodeName, input.job?.status ?? 'COMING_UP'],
      )).rows[0]
    }))
    // in the request: the values never enter the job payload
    for (const [name, value] of Object.entries(given)) await putSecret(c, project, name, 'platform', value)
    for (const [section, data] of Object.entries(input.config ?? {})) {
      await c.query('insert into control.project_config (project_id, section, data, updated_by) values ($1, $2, $3, $4)',
        [project.id, section, data, input.createdBy])
    }
    const job = input.job ?? { type: 'project.create', payload: { pool: input.pool } }
    const jobId = await enqueue(c, { type: job.type, projectId: project.id, payload: job.payload, createdBy: input.createdBy })
    return { project, jobId }
  })
}

export const need = (ctx: JobCtx): Project => ctx.project ?? (() => { throw new Error('the job has no project') })()
export const setStatus = (ctx: JobCtx, status: string) => ctx.db.query('update control.projects set status = $2 where id = $1', [need(ctx).id, status])
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A rotating import (rotate_keys) that neither succeeded nor passed its 'restored' step under the current steps may
 * have left the restored sessions in the database (I1): its project must not start on the new keys. Read from the job
 * record (a 'succeeded' event of 'restored' means the restore job confirmed the deletes), never from a flag.
 */
export async function sessionsUnconfirmed(db: pg.Pool, projectId: string, exceptJobId?: string): Promise<boolean> {
  return !!(await db.query(`select 1 from control.jobs j where j.project_id = $1 and j.type = 'project.import'
      and j.payload->>'rotate_keys' = 'true' and j.status <> 'succeeded' and j.id is distinct from $2
      and not (coalesce((j.payload->>'job_version')::int, 1) >= 2 and exists (select 1 from control.job_events e
        where e.job_id = j.id and e.status = 'succeeded' and e.step = 'restored'))`, [projectId, exceptJobId ?? null])).rowCount
}

export async function ensure(ctx: JobCtx, recreate: string[] = []) {
  const p = need(ctx)
  if (await sessionsUnconfirmed(ctx.db, p.id, ctx.job.id)) {
    throw new ApiError(409, 'sessions_not_deleted', 'This project was imported with rotate_keys and the import failed before the restored '
      + 'sessions were confirmed deleted, so it cannot start: delete this project, then import again')
  }
  const { env, hosts } = await loadProjectEnv(ctx.db, p)
  // every host gets the resolver: only counted ones (a slot, an issued host) or LEGACY_HOSTNAMES may route
  await assertRoutable(ctx.db, p.id, hosts)
  await ctx.provisioner.ensure({ ref: p.ref, templateVersion: p.template_version ?? config.templateVersion, size: p.size,
    subnet: p.subnet, hosts, env, recreate })
}

export async function healthy(ctx: JobCtx) {
  const p = need(ctx)
  const until = Date.now() + ctx.waits.healthyMs
  for (;;) {
    let waitingFor: string
    // one failed read (provisioner restarting, a lock wait) is not a verdict: only the deadline is
    try {
      const s = await ctx.provisioner.inspect(p.ref)
      const bad = s.services.filter((x) => !x.exists || x.state !== 'running' || (x.health !== null && x.health !== 'healthy'))
      if (s.services.length && !bad.length) return
      waitingFor = bad.map((x) => x.service).join(', ')
    } catch (e) {
      waitingFor = `the provisioner (${(e as Error).message})`
    }
    if (Date.now() >= until) throw new Error(`not healthy within ${ctx.waits.healthyMs / 1000} s: ${waitingFor}`)
    await pause(ctx.waits.pollMs)
  }
}

export async function certificate(ctx: JobCtx) {
  const host = (await hostsOf(ctx.db, need(ctx).id))[0]
  const until = Date.now() + ctx.waits.certificateMs
  while ((await ctx.probe(host)) !== 'ok') {
    if (Date.now() >= until) throw new Error(`the certificate for ${host} is not issued yet`)
    await pause(ctx.waits.pollMs)
  }
}

// PostgREST loads its schema cache on the first request; make that request ours. service_role has no statement
// timeout (0001-bootstrap sets 3 s for anon, 8 s for authenticated only). Not fatal: the project works without it.
async function warm(ctx: JobCtx) {
  const p = need(ctx)
  const key = (await getSecrets(ctx.db, p)).SERVICE_ROLE_KEY
  if (!key) return ctx.log('warm_skipped', { reason: 'no SERVICE_ROLE_KEY' })
  const until = Date.now() + ctx.waits.warmMs
  let last = ''
  for (;;) {
    try {
      const res = await fetch(`${await ctx.coreUrl(p.ref)}/rest/v1/`, { headers: { apikey: key, authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(Math.max(1000, Math.min(10_000, until - Date.now()))) })
      await res.body?.cancel()
      if (res.status === 200) return
      last = `status ${res.status}`
    } catch (e) {
      last = (e as Error).name
      forgetCoreIp(p.ref) // recreated (or not up yet): read its address again
    }
    if (Date.now() >= until) return ctx.log('warm_failed', { last })
    await pause(ctx.waits.pollMs)
  }
}

export const step = (name: string, run: (ctx: JobCtx) => Promise<unknown>, retry = true) =>
  ({ name, retry, run: async (ctx: JobCtx) => { await run(ctx) } })
// these poll on their own budgets (120 s, 10 min); a retry would only multiply the time the light lane waits
export const healthySteps = [step('healthy', healthy, false), step('warm', warm)]
export const activate = step('activate', (ctx) => setStatus(ctx, 'ACTIVE_HEALTHY'))
// the status a failed job leaves, unless it failed at a step listed in `keep` (status unchanged)
export const failTo = (status: string, keep: string[] = []) => ({
  onFail: async (ctx: JobCtx) => { if (ctx.project && !keep.includes(ctx.step)) await setStatus(ctx, status) },
})

// up to ensure: shared with project.import
export const createSteps = [
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
]

// onFail releases nothing: the operator deletes or retries. A certificate that is late leaves COMING_UP, and
// reconcile turns it ACTIVE_HEALTHY once the probe passes.
defineJob('project.create', 'light', [
  ...createSteps,
  ...healthySteps,
  step('certificate', certificate, false),
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
    await admit(c, { size: p.size as Size, excludeProjectId: p.id }).catch(async (e) => {
      // the refusal's numbers go with the failed job (Studio shows the project's last job)
      if (e instanceof AdmissionError) await ctx.log('admission_refused', e.details)
      throw e
    })
    await c.query(`update control.projects set status = 'RESTORING', paused_at = null where id = $1`, [p.id])
  })),
  // ensure, not start: a domain or config changed while paused must reach the containers (their router labels).
  // The provisioner's ensure recreates what changed and starts every stopped container.
  step('start', (ctx) => ensure(ctx)),
  ...healthySteps,
  activate,
], failTo('RESTORE_FAILED', ['admit']))

// The REMOVED row keeps its /27 (projects.subnet is not null unique): deleting the row would cascade to this
// job and its history. 2048 /27s in the default pool; purging old REMOVED rows is left to a later task.
// REMOVE_FAILED is ignored by reconcile and not counted by admission.
defineJob('project.delete', 'light', [
  step('remove', (ctx) => ctx.provisioner.remove(need(ctx).ref, true)),
  step('release', async (ctx) => {
    await releaseHost(ctx.db, need(ctx).id)
    // legacy and custom names too: free for the org's other projects at once, for other orgs after the hold
    await releaseDomains(ctx.db, need(ctx).id)
  }),
  step('secrets', (ctx) => ctx.db.query('delete from control.project_secrets where project_id = $1', [need(ctx).id])),
  step('removed', (ctx) => setStatus(ctx, 'REMOVED')),
], failTo('REMOVE_FAILED'))

const recreateOf = (ctx: JobCtx): string[] => (Array.isArray(ctx.job.payload.recreate) ? ctx.job.payload.recreate : [])

// reconcile may enqueue this from a read that is stale by now: it acts only on a project that should be running
defineJob('project.apply', 'light', [step('ensure', async (ctx) => {
  if (!ctx.project || !DESIRED_RUNNING.includes(ctx.project.status)) return ctx.log('skipped', { status: ctx.project?.status ?? null })
  await ensure(ctx, recreateOf(ctx))
})], {
  onFail: async (ctx) => {
    if (ctx.project) {
      await ctx.db.query(`update control.projects set status = 'ACTIVE_UNHEALTHY' where id = $1 and status = any($2)`,
        [ctx.project.id, DESIRED_RUNNING])
    }
  },
})

defineJob('project.upgrade', 'light', [
  step('version', async (ctx) => {
    const r = await ctx.db.query(
      `update control.projects set status = 'UPGRADING', template_version = s.value
       from control.settings s where s.key = 'current_template_version' and control.projects.id = $1`, [need(ctx).id])
    if (!r.rowCount) throw new ApiError(409, 'no_template_version', 'current_template_version is not set; nothing to upgrade to')
  }),
  step('ensure', (ctx) => ensure(ctx, recreateOf(ctx))),
  ...healthySteps,
  activate,
  // refused for a missing current_template_version: nothing changed, the status stays
], failTo('ACTIVE_UNHEALTHY', ['version']))

export { withAdmission }
