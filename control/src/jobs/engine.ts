// Job engine (spec 7.6): long operations are rows in control.jobs with idempotent steps.
// - One worker per lane. A worker claims the oldest pending or running job of its lane (`for update skip locked`)
//   and owns it through a session advisory lock on its own connection, so a job left `running` by a dead process
//   (its connection gone, the lock with it) is picked up again, and a live worker's job never is.
// - jobs.step holds the index of the next step; it advances in the transaction that records the step's
//   job_events row, so a restart resumes at the first step not recorded as done.
// - A failing step is tried up to 3 times with backoff; then the job is `failed` with the error's message and the
//   job's onFail sets the project's status. An ApiError below 500 (admission, host cap) is not retried.
// - jobs.attempts counts the tries of the current step (reset when the next step starts).
import pg from 'pg'
import type { Db } from '../db.ts'
import { probeCertificate } from '../cert.ts'
import { ApiError } from '../errors.ts'
import type { Provisioner } from '../provisioner.ts'
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
  coreUrl(ref: string): string
  log(event: string, fields?: Record<string, unknown>): Promise<void> }
/** retry: false for a step that polls on its own budget; its first failure fails the job */
export type Step = { name: string; retry?: boolean; run(ctx: JobCtx): Promise<void> }
type Def = { type: string; lane: Lane; steps: Step[]; onFail?: (ctx: JobCtx, error: Error) => Promise<void> }

export type WorkerDeps = { db: pg.Pool; provisioner: Provisioner; probe?: JobCtx['probe']; waits?: Partial<Waits>
  coreUrl?: JobCtx['coreUrl']
  /** delay before try n+1 is backoffMs * 4^(n-1) */
  backoffMs?: number; idleMs?: number }

const defs = new Map<string, Def>()
const MAX_ATTEMPTS = 3
const LOCK_NS = 7213017
const APP_NAME = 'selfbase-jobs'
const FORBIDDEN = new Set<string>([...SECRET_ENV, ...THIRD_PARTY_SECRET_ENV])
const MAX_VALUE = 2048
// a project should be running: reconcile acts on these, project.apply only touches these
export const DESIRED_RUNNING = ['ACTIVE_HEALTHY', 'ACTIVE_UNHEALTHY', 'COMING_UP']

export function defineJob(type: string, lane: Lane, steps: Step[], opts: { onFail?: Def['onFail'] } = {}): void {
  defs.set(type, { type, lane, steps, onFail: opts.onFail })
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
  return (await db.query(
    `insert into control.jobs (type, project_id, lane, step, payload, created_by) select $1, $2, $3, '0', $4, $5
     where not $6 or not exists (select 1 from control.jobs where project_id = $2 and status in ('pending', 'running')) returning id`,
    [j.type, j.projectId ?? null, def.lane, j.payload, j.createdBy, ifIdle],
  )).rows[0]?.id ?? null
}

export async function enqueue(db: Db, j: EnqueueInput): Promise<string> {
  return (await insertJob(db, j, false))!
}

/** Enqueues only when the project has no pending or running job, in one statement; null when it had one. */
export const enqueueIfIdle = (db: Db, j: EnqueueInput & { projectId: string }) => insertJob(db, j, true)

const ignore = () => {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 1000)

/** Starts one worker per lane. stop() lets the current step finish, then leaves the job for the next start. */
export function startWorkers(deps: WorkerDeps): { stop(): Promise<void> } {
  let stopping = false
  const waits: Waits = { pollMs: 2000, healthyMs: 120_000, certificateMs: 600_000, warmMs: 60_000, ...deps.waits }
  const coreUrl = deps.coreUrl ?? ((ref: string) => `http://sb-${ref}-core:8080`)
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

    for (let i = Number(job.step ?? 0); i < def.steps.length; i++) {
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
          const fatal = step.retry === false || (err instanceof ApiError && err.status < 500)
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
