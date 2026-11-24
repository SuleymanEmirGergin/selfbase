// Job engine (spec 7.6): long operations are rows in control.jobs with idempotent steps.
// - One worker per lane. A worker claims the oldest pending or running job of its lane (`for update skip locked`)
//   and owns it through a session advisory lock on its own connection, so a job left `running` by a dead process
//   (its connection gone, the lock with it) is picked up again, and a live worker's job never is.
// - jobs.step holds the index of the next step; it advances in the transaction that records the step's
//   job_events row, so a restart resumes at the first step not recorded as done.
// - A failing step is tried up to 3 times with backoff; then the job is `failed` with the error's message and the
//   job's onFail sets the project's status. An ApiError below 500 (admission, host cap) and a permanent provisioner
//   refusal (ProvisionerError.permanent) are not retried.
// - jobs.attempts counts the tries of the current step (reset when the next step starts).
// - One job per project at a time across both lanes: a worker also holds a session advisory lock on the job's project
//   (RUN_NS) while it runs the job, and skips a job whose project another worker holds. enqueueIfIdle checks and
//   inserts under a transaction lock on the project (ENQUEUE_NS), so two requests cannot both see it idle.
import pg from 'pg'
import type { Db } from '../db.ts'
import { probeCertificate } from '../cert.ts'
import { coreIp } from '../core-addr.ts'
import { ApiError } from '../errors.ts'
import { ProvisionerError, type Provisioner } from '../provisioner.ts'
import { SECRET_ENV, THIRD_PARTY_SECRET_ENV } from '../project-env.ts'

export type Lane = 'light' | 'heavy'
export type Job = { id: string; type: string; project_id: string | null; status: string; lane: Lane; step: string | null
  payload: Record<string, any>; attempts: number; created_by: string | null }
export type Project = { id: string; ref: string; org_id: string; name: string; status: string; size: string
  template_version: string | null; subnet: string; paused_at: Date | null }
export type Waits = { pollMs: number; healthyMs: number; certificateMs: number; warmMs: number }
export type JobCtx = { db: pg.Pool; provisioner: Provisioner; job: Job; project: Project | null; step: string
  probe: (hostname: string) => Promise<'ok' | 'pending'>; waits: Waits
  /** core's URL on the project network (control is attached to sb-<ref>) */
  coreUrl(ref: string): string | Promise<string>
  log(event: string, fields?: Record<string, unknown>): Promise<void> }
/** retry: false for a step that polls on its own budget; its first failure fails the job */
export type Step = { name: string; retry?: boolean; run(ctx: JobCtx): Promise<void> }
type Def = { type: string; lane: Lane; steps: Step[]; onFail?: (ctx: JobCtx, error: Error) => Promise<void>; version: number }

export type WorkerDeps = { db: pg.Pool; provisioner: Provisioner; probe?: JobCtx['probe']; waits?: Partial<Waits>
  coreUrl?: JobCtx['coreUrl']
  /** delay before try n+1 is backoffMs * 4^(n-1) */
  backoffMs?: number; idleMs?: number }

const defs = new Map<string, Def>()
const MAX_ATTEMPTS = 3
const LOCK_NS = 7213017
// separate namespaces: a transaction lock of enqueueIfIdle must not wait for a worker's session lock on the project
const ENQUEUE_NS = 7213019
const RUN_NS = 7213020
const APP_NAME = 'selfbase-jobs'
const FORBIDDEN = new Set<string>([...SECRET_ENV, ...THIRD_PARTY_SECRET_ENV])
const MAX_VALUE = 2048
// a project should be running: reconcile acts on these, project.apply only touches these
export const DESIRED_RUNNING = ['ACTIVE_HEALTHY', 'ACTIVE_UNHEALTHY', 'COMING_UP']

/** The step names of a job type, in order (Studio shows them). */
export const stepsOf = (type: string): string[] => defs.get(type)?.steps.map((s) => s.name) ?? []

/**
 * `version`: raise it when a change to `steps` must not meet a job a previous control left in flight (jobs.step is an
 * index, so the job would resume at another step). Such a job fails instead; one that never started runs the new steps.
 */
export function defineJob(type: string, lane: Lane, steps: Step[], opts: { onFail?: Def['onFail']; version?: number } = {}): void {
  defs.set(type, { type, lane, steps, onFail: opts.onFail, version: opts.version ?? 1 })
}

function checkPayload(v: unknown, path: string): void {
  if (typeof v === 'string' && v.length > MAX_VALUE) throw new Error(`job payload: ${path} is longer than ${MAX_VALUE} characters`)
  if (Array.isArray(v)) v.forEach((x, i) => checkPayload(x, `${path}[${i}]`))
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      // the name only, never the value
      if (FORBIDDEN.has(k.toUpperCase())) throw new Error(`job payload: ${k} is a secret and cannot be part of a job payload`)
      checkPayload(x, `${path}.${k}`)
    }
  }
}

type EnqueueInput = { type: string; projectId?: string; payload: Record<string, unknown>; createdBy: string | null }

async function insertJob(db: Db, j: EnqueueInput, ifIdle: boolean): Promise<string | null> {
  const def = defs.get(j.type)
  if (!def) throw new Error(`unknown job type ${j.type}`)
  checkPayload(j.payload, 'payload')
  const payload = def.version === 1 ? j.payload : { ...j.payload, job_version: def.version }
  return (await db.query(
    `insert into control.jobs (type, project_id, lane, step, payload, created_by) select $1, $2, $3, '0', $4, $5
     where not $6 or not exists (select 1 from control.jobs where project_id = $2 and status in ('pending', 'running')) returning id`,
    [j.type, j.projectId ?? null, def.lane, payload, j.createdBy, ifIdle],
  )).rows[0]?.id ?? null
}

export async function enqueue(db: Db, j: EnqueueInput): Promise<string> {
  return (await insertJob(db, j, false))!
}

/**
 * Enqueues only when the project has no pending or running job; null when it had one. The check and the insert run
 * under a per-project transaction lock: under READ COMMITTED, `insert ... where not exists` alone lets two concurrent
 * calls both see the project idle. Its own transaction, so it takes the pool, never a client.
 */
export const enqueueIfIdle = (db: pg.Pool, j: EnqueueInput & { projectId: string }): Promise<string | null> =>
  underEnqueueLock(db, j.projectId, (c) => insertJob(c, j, true))

/**
 * At most one pending job of this type and payload per project: an existing one is returned (it reads the project's
 * state when it runs, so it covers this change too), else a new one queues behind whatever runs. For changes that
 * must not be refused while another job runs (domains), yet must not pile up.
 */
export const enqueueCoalesced = (db: pg.Pool, j: EnqueueInput & { projectId: string }): Promise<string> =>
  underEnqueueLock(db, j.projectId, async (c) => (await c.query(
    `select id from control.jobs where project_id = $1 and type = $2 and payload = $3::jsonb and status = 'pending' limit 1`,
    [j.projectId, j.type, j.payload])).rows[0]?.id ?? (await insertJob(c, j, false))!)

async function underEnqueueLock<T>(db: pg.Pool, projectId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('begin')
    await c.query('select pg_advisory_xact_lock($1, hashtext($2))', [ENQUEUE_NS, projectId])
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

const ignore = () => {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 1000)

/** Starts one worker per lane. stop() lets the current step finish, then leaves the job for the next start. */
export function startWorkers(deps: WorkerDeps): { stop(): Promise<void> } {
  let stopping = false
  // certificateMs is short: the light lane waits behind it, and reconcile activates a COMING_UP project once the probe
  // passes (create and import both set COMING_UP before this wait)
  const waits: Waits = { pollMs: 2000, healthyMs: 120_000, certificateMs: 120_000, warmMs: 60_000, ...deps.waits }
  // by core's address on the project network (core-addr.ts says why)
  const coreUrl = deps.coreUrl ?? (async (ref: string) => `http://${await coreIp(deps.provisioner, ref)}:8080`)
  const probe = deps.probe ?? probeCertificate
  const idleMs = deps.idleMs ?? 1000
  const backoffMs = deps.backoffMs ?? 2000

  async function claim(c: pg.PoolClient, lane: Lane): Promise<Job | null> {
    await c.query('begin')
    try {
      const rows = (await c.query(
        `select * from control.jobs where lane = $1 and status in ('pending', 'running') order by created_at limit 20 for update skip locked`,
        [lane],
      )).rows as Job[]
      for (const job of rows) {
        if (!(await c.query('select pg_try_advisory_lock($1, hashtext($2)) as ok', [LOCK_NS, job.id])).rows[0].ok) continue
        // the other lane runs a job of this project: this one waits its turn
        if (job.project_id && !(await c.query('select pg_try_advisory_lock($1, hashtext($2)) as ok', [RUN_NS, job.project_id])).rows[0].ok) {
          await c.query('select pg_advisory_unlock($1, hashtext($2))', [LOCK_NS, job.id])
          continue
        }
        await c.query(`update control.jobs set status = 'running', updated_at = now() where id = $1`, [job.id])
        await c.query('commit')
        return job
      }
      await c.query('commit')
      return null
    } catch (e) {
      await c.query('rollback').catch(() => {})
      throw e
    }
  }

  async function run(c: pg.PoolClient, job: Job): Promise<void> {
    const def = defs.get(job.type)
    const loadProject = async () => job.project_id
      ? ((await deps.db.query('select * from control.projects where id = $1', [job.project_id])).rows[0] ?? null) as Project | null
      : null
    const ctxFor = async (step: string): Promise<JobCtx> => ({
      db: deps.db, provisioner: deps.provisioner, job, project: await loadProject(), step, probe, waits, coreUrl,
      log: async (event, fields) => {
        await deps.db.query(`insert into control.job_events (job_id, status, step, message) values ($1, 'log', $2, $3)`,
          [job.id, step, fields ? `${event} ${JSON.stringify(fields)}`.slice(0, MAX_VALUE) : event])
      },
    })
    const fail = async (step: string, error: Error) => {
      // onFail first: whoever sees the job failed also sees the project status it left (a crash here re-runs the step)
      if (def?.onFail) await def.onFail(await ctxFor(step), error).catch((e) => console.error(`job ${job.id} onFail: ${message(e)}`))
      await c.query('begin')
      await c.query(`insert into control.job_events (job_id, status, step, message) values ($1, 'failed', $2, $3)`, [job.id, step, message(error)])
      await c.query(`update control.jobs set status = 'failed', error = $2, updated_at = now() where id = $1`, [job.id, message(error)])
      await c.query('commit')
    }
    if (!def) return fail('-', new Error(`unknown job type ${job.type}`))
    const at = Number(job.step ?? 0)
    if ((job.payload.job_version ?? 1) !== def.version) {
      if (at > 0) {
        return fail(def.steps[at]?.name ?? '-', new Error(`the ${job.type} job was started by an earlier version of control whose steps differ, `
          + 'so it cannot resume safely: start it again (an import: delete this project, then import again)'))
      }
      // not started yet: it runs this version's steps, and resumes under them after a restart
      job.payload = { ...job.payload, job_version: def.version }
      await c.query(`update control.jobs set payload = $2 where id = $1`, [job.id, job.payload])
    } else if (at > 0 && at >= def.steps.length) {
      return fail('-', new Error(`the ${job.type} job is past its last step and cannot resume`))
    }

    for (let i = at; i < def.steps.length; i++) {
      if (stopping) return
      const step = def.steps[i]
      for (;;) {
        const attempts = (await c.query(
          `update control.jobs set attempts = attempts + 1, updated_at = now() where id = $1 returning attempts`, [job.id],
        )).rows[0].attempts as number
        try {
          await step.run(await ctxFor(step.name))
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e))
          const fatal = step.retry === false || (err instanceof ApiError && err.status < 500) || (err instanceof ProvisionerError && err.permanent)
          if (fatal || attempts >= MAX_ATTEMPTS) return fail(step.name, err)
          await c.query(`insert into control.job_events (job_id, status, step, message) values ($1, 'retry', $2, $3)`, [job.id, step.name, message(err)])
          for (let t = backoffMs * 4 ** (attempts - 1); t > 0 && !stopping; t -= 100) await sleep(Math.min(t, 100))
          if (stopping) return
          continue
        }
        const last = i + 1 === def.steps.length
        await c.query('begin')
        await c.query(`insert into control.job_events (job_id, status, step) values ($1, 'succeeded', $2)`, [job.id, step.name])
        await c.query(
          `update control.jobs set step = $2, attempts = case when $3 then attempts else 0 end,
             status = case when $3 then 'succeeded' else status end, updated_at = now() where id = $1`,
          [job.id, String(i + 1), last],
        )
        await c.query('commit')
        break
      }
    }
  }

  async function loop(lane: Lane): Promise<void> {
    while (!stopping) {
      let c: pg.PoolClient | undefined
      try {
        c = await deps.db.connect()
        // a checked-out client whose backend dies emits 'error'; the next query rejects and is handled below
        c.on('error', ignore)
        const job = await claim(c, lane)
        if (!job) {
          c.off('error', ignore)
          c.release()
          c = undefined
          await sleep(idleMs)
          continue
        }
        await c.query(`set application_name = '${APP_NAME}'`)
        await run(c, job)
        await c.query('select pg_advisory_unlock($1, hashtext($2))', [LOCK_NS, job.id])
        if (job.project_id) await c.query('select pg_advisory_unlock($1, hashtext($2))', [RUN_NS, job.project_id])
        await c.query('reset application_name')
        c.off('error', ignore)
        c.release()
        c = undefined
      } catch (e) {
        // the connection (and with it the job's lock) is dropped; the job resumes at its recorded step
        console.error(`jobs ${lane}: ${message(e)}`)
        c?.release(true)
        c = undefined
        if (!stopping) await sleep(idleMs)
      }
    }
  }

  const loops = (['light', 'heavy'] as const).map(loop)
  return {
    async stop() {
      stopping = true
      await Promise.all(loops)
    },
  }
}
