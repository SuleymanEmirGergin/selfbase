// Backup, export and import jobs (spec 8.8 and section 10), heavy lane: each runs a provisioner job (job/backup.sh,
// job/restore.sh) and waits for it. Database passwords are read inside the step and go to the provisioner call only,
// never into a payload, an event or an error. A provisioner job's result is read once (the provisioner removes a
// finished job when it reports it), so a waiting step never retries.
import { config } from '../config.ts'
import type { Db } from '../db.ts'
import { ApiError } from '../errors.ts'
import { ProvisionerError } from '../provisioner.ts'
import { getSecrets } from '../secrets.ts'
import { defineJob, type JobCtx } from './engine.ts'
import { activate, certificate, createSteps, failTo, healthy, healthySteps, need, sessionsUnconfirmed, setStatus, step } from './project.ts'

// what an import stops for the restore; db keeps running (the restore job connects to it)
export const RESTORE_STOPS = ['core', 'rest', 'fn', 'pooler']
// shortcut: a fixed budget for one backup or restore; make it a setting when a project's dump takes hours
const JOB_MS = 6 * 3600_000
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

// backup.sh's exit 4: the volume would keep less than the floor free after this backup (it measured the database and
// the storage files at its start). Only the numbers and the rule's name are taken from its line, nothing else
const REFUSED = /^backup: REFUSED: (\d+) MiB free on the backup volume, at least (\d+) MiB \((BACKUP_MIN_FREE_MIB|10% or 5 GiB, whichever is larger)\) needed after this backup of up to (\d+) MiB; free space first$/m
function volumeFull(tail: string): string {
  const m = REFUSED.exec(tail)
  const numbers = m ? `the backup volume has ${m[1]} MiB free; this backup needs up to ${m[4]} MiB and ${m[2]} MiB (${m[3]}) must stay free`
    : 'the backup volume would keep less than its floor free after this backup'
  return `backup_volume_full: ${numbers}. Remove old backups or exports, or grow the volume, then try again.`
}

/** Waits for the provisioner job of `type` to end; its output tail when it succeeded, else an error saying what changed. */
async function waitFor(ctx: JobCtx, ref: string, type: 'backup' | 'restore'): Promise<string> {
  const until = Date.now() + JOB_MS
  for (;;) {
    let s
    try {
      s = await ctx.provisioner.jobStatus(ref, type)
    } catch (e) {
      // a read that never reached the provisioner took nothing with it
      if (e instanceof ProvisionerError && e.code === 'provisioner_unreachable' && Date.now() < until) {
        await pause(ctx.waits.pollMs)
        continue
      }
      // a read that timed out may have taken the finished job's result with it: another read would only say "no job"
      if (e instanceof ProvisionerError && e.code === 'provisioner_timeout') {
        throw new Error(`the ${type} job's result was lost (the provisioner did not answer in time); check the backup directory and run it again`)
      }
      throw e
    }
    if (s.status === 'running') {
      if (Date.now() >= until) throw new Error(`the ${type} job did not finish within ${JOB_MS / 3600_000} h`)
      await pause(ctx.waits.pollMs)
      continue
    }
    // the scripts print names and paths, never a value from their environment; a failure's tail is not kept (job
    // events are shown to read_only, and a pg_restore or COPY error can quote a row): the error says what failed
    const tail = s.tail.trim().split('\n').slice(-10).join('\n')
    if (tail && s.status === 'succeeded') await ctx.log(`${type}_output`, { tail })
    if (s.status === 'succeeded') return s.tail
    if (type === 'backup' && s.exitCode === 4) throw new Error(volumeFull(s.tail))
    if (type === 'restore' && s.exitCode === 10) throw new Error('the restore failed and rolled back: the database was not changed')
    if (type === 'restore' && s.exitCode === 5) {
      throw new Error('the database was restored but its sessions could not be deleted (rotate_keys): delete this project, then import again')
    }
    if (type === 'restore' && s.exitCode === 3) {
      throw new Error('the database was restored but the storage files were not (or only partly): delete this project, then import again')
    }
    throw new Error(`the ${type} job failed (${s.exitCode === null ? 'it never started' : `exit ${s.exitCode}`})`)
  }
}

const BACKUP_OF = /^(?:export-)?([a-z]{20})\/\d{8}-\d{6}$/
const DROP_AREA = /^import\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/

/**
 * Whether an organization may import from a backup directory: `<ref>/<ts>` or `export-<ref>/<ts>` of one of its own
 * projects (any status, REMOVED too), or `import/<its slug>/<name>`, the drop area where an operator puts a v1 or
 * foreign dump. 'foreign' covers both another organization's backups and unknown ones (callers answer one 404).
 */
export async function backupDirOf(db: Db, org: { id: string; slug: string }, dir: string): Promise<'ok' | 'foreign' | 'invalid'> {
  const own = BACKUP_OF.exec(dir)
  if (own) {
    return (await db.query('select 1 from control.projects where ref = $1 and org_id = $2', [own[1], org.id])).rowCount ? 'ok' : 'foreign'
  }
  const drop = DROP_AREA.exec(dir)
  if (drop && drop[2] !== '.' && drop[2] !== '..') return drop[1] === org.slug ? 'ok' : 'foreign'
  return 'invalid'
}

/** Starts a provisioner job; 409 job_running means a start whose answer was lost (or a resumed step) already began it. */
async function startJob(ctx: JobCtx, ref: string, type: 'backup' | 'restore', args: Record<string, unknown>, env: Record<string, string>) {
  try {
    await ctx.provisioner.runJob(ref, type, args, env)
  } catch (e) {
    // shortcut: the provisioner does not say whose job is running; another ref's job makes the wait step fail with
    // job_not_found, which is the right outcome too (nothing of ours ran). Upgrade when jobs carry an id control knows.
    if (e instanceof ProvisionerError && e.code === 'job_running') return ctx.log('already_running', { type })
    throw e
  }
}

const lastMatch = (re: RegExp, text: string) => [...text.matchAll(re)].at(-1)?.[1] ?? null
// every backup job prunes its own subdirectory by these (job/backup.sh)
const retention = () => ({ BACKUP_RETENTION_DAYS: String(config.backupRetentionDays),
  EXPORT_RETENTION_DAYS: String(config.exportRetentionDays), BACKUP_MAX_COUNT: String(config.backupMaxCount) })
const dbPassword = async (ctx: JobCtx) => (await getSecrets(ctx.db, need(ctx))).POSTGRES_PASSWORD

/** project.backup and project.export: one backup job into `subdir`, then its backups row. */
const backupSteps = (subdir: (ctx: JobCtx) => string, extra: (ctx: JobCtx) => Record<string, string> = () => ({})) => [
  step('backup', async (ctx) => startJob(ctx, need(ctx).ref, 'backup', {},
    { PGHOST: 'db', PGPASSWORD: await dbPassword(ctx), BACKUP_SUBDIR: subdir(ctx), ...retention(), ...extra(ctx) })),
  step('record', async (ctx) => {
    const tail = await waitFor(ctx, need(ctx).ref, 'backup')
    const size = lastMatch(/^backup: size (\d+) bytes$/gm, tail)
    const wrote = lastMatch(/^backup: wrote (\S+)$/gm, tail)
    // a lost result followed by another job of this ref (a backup read as an export): never recorded as this one
    if (wrote && !wrote.startsWith(`${subdir(ctx)}/`)) throw new Error(`the backup job wrote ${wrote}, not under ${subdir(ctx)}/: another job's result`)
    await ctx.db.query(
      `insert into control.backups (project_id, kind, status, started_at, finished_at, size_bytes, location)
       values ($1, 'logical', 'succeeded', (select created_at from control.jobs where id = $2), now(), $3, $4)`,
      [need(ctx).id, ctx.job.id, size === null ? null : Number(size), wrote],
    )
    // retention removed these directories: their rows would offer an import that fails at restore time
    const gone = [...tail.matchAll(/^backup: deleted (\S+)/gm)].map((m) => m[1])
    if (gone.length) await ctx.db.query('delete from control.backups where project_id = $1 and location = any($2)', [need(ctx).id, gone])
  }, false),
]

// a failed backup leaves the project as it is: the failed job is the record
defineJob('project.backup', 'heavy', backupSteps((ctx) => need(ctx).ref))

// the payload carries the manifest sealed in the request, in pieces (payload strings are capped at 2048 characters)
// and the sealed manifest leaves control-db when the job ends either way (it is offline-attackable in every backup)
const forgetManifest = (ctx: JobCtx) => ctx.db.query(`update control.jobs set payload = payload - 'manifest' where id = $1`, [ctx.job.id])
defineJob('project.export', 'heavy', [...backupSteps((ctx) => `export-${need(ctx).ref}`,
  // CONTROL_GID: the export's directories and project.json go to control's group, which an import reads them as
  (ctx) => ({ MANIFEST_B64: (ctx.job.payload.manifest as string[]).join(''), CONTROL_GID: String(process.getgid?.() ?? 1000) })),
  step('forget', forgetManifest)], { onFail: async (ctx) => { await forgetManifest(ctx) } })

// The exports past EXPORT_RETENTION_DAYS (and beyond BACKUP_MAX_COUNT) of a project, a deleted one too: the backup
// job's retention alone over export-<ref> (BACKUP_PRUNE_ONLY), on no network and with no database; then the rows of
// what it deleted go, as the files did (reconcile drops the rows of expired exports by their age too).
const PRUNED = (ref: string) => new RegExp(`^backup: pruned export-${ref}$`, 'm')
defineJob('project.prune', 'heavy', [
  step('prune', (ctx) => startJob(ctx, need(ctx).ref, 'backup', {},
    { BACKUP_SUBDIR: `export-${need(ctx).ref}`, BACKUP_PRUNE_ONLY: '1', ...retention() })),
  step('record', async (ctx) => {
    const { id, ref } = need(ctx)
    const tail = await waitFor(ctx, ref, 'backup')
    // a lost result followed by another job of this ref: never taken for this one
    if (!PRUNED(ref).test(tail)) throw new Error(`the prune job did not confirm that it pruned export-${ref}: another job's result`)
    const gone = [...tail.matchAll(/^backup: deleted (\S+)/gm)].map((m) => m[1]).filter((l) => l.startsWith(`export-${ref}/`))
    if (gone.length) await ctx.db.query('delete from control.backups where project_id = $1 and location = any($2)', [id, gone])
  }, false),
])

defineJob('control.backup', 'heavy', [
  step('backup', (ctx) => startJob(ctx, 'control', 'backup', {},
    { PGHOST: config.dbHost, PGPASSWORD: config.dbPassword, BACKUP_SUBDIR: 'control', ...retention() })),
  step('wait', async (ctx) => {
    await ctx.log('backed_up', { location: lastMatch(/^backup: wrote (\S+)$/gm, await waitFor(ctx, 'control', 'backup')) })
  }, false),
])

// rotate_keys: the restored refresh tokens would mint access tokens signed with the new secret. The restore job deletes
// them (ROTATE_KEYS=1) while core, rest, fn and pooler are stopped, so the plain start brings up a database without them.
const rotating = (ctx: JobCtx) => ctx.job.payload.rotate_keys === true
const SESSIONS_DELETED = /^restore: the restored sessions are deleted \(ROTATE_KEYS\)$/m
const importFailed = failTo('INIT_FAILED', ['certificate'])

// The project comes up empty as a create would (status RESTORING until the data is back), then the backup replaces its
// database and storage with core, rest, fn and pooler stopped; core applies the platform migrations when it starts
// again. COMING_UP before the certificate wait: a late certificate fails the job there, and reconcile activates a
// COMING_UP project once the probe passes, as after a create (it never looks at a RESTORING one).
defineJob('project.import', 'heavy', [
  ...createSteps,
  step('healthy', healthy, false),
  step('stop', (ctx) => ctx.provisioner.stop(need(ctx).ref, RESTORE_STOPS)),
  step('restore', async (ctx) => {
    const p = need(ctx)
    const org = (await ctx.db.query('select id, slug from control.organizations where id = $1', [p.org_id])).rows[0]
    // the route checked it; a payload from anywhere else must not reach another organization's backups either
    if (!org || (await backupDirOf(ctx.db, org, String(ctx.job.payload.backup_dir))) !== 'ok') {
      throw new ApiError(400, 'invalid_backup_dir', "backup_dir is not one of this organization's backups")
    }
    await startJob(ctx, p.ref, 'restore', { dir: ctx.job.payload.backup_dir },
      { PGHOST: 'db', PGPASSWORD: await dbPassword(ctx), ...(rotating(ctx) ? { ROTATE_KEYS: '1' } : {}) })
  }),
  step('restored', async (ctx) => {
    const tail = await waitFor(ctx, need(ctx).ref, 'restore')
    // a job image that ignores ROTATE_KEYS would leave them: never start on its word alone
    if (rotating(ctx) && !SESSIONS_DELETED.test(tail)) {
      throw new Error('the restore job did not confirm that it deleted the restored sessions (rotate_keys): delete this project, then import again')
    }
  }, false),
  step('start', (ctx) => ctx.provisioner.start(need(ctx).ref, RESTORE_STOPS)),
  step('started', healthy, false),
  healthySteps[1], // warm
  step('coming_up', (ctx) => setStatus(ctx, 'COMING_UP')),
  step('certificate', certificate, false),
  activate,
// version 2: the sessions moved into the restore job; an import an earlier control left past its restore fails (I1)
], { version: 2, onFail: async (ctx) => {
  await importFailed.onFail(ctx)
  // not past a confirmed 'restored' (an earlier control's job may have started core on its throwaway secret): the four
  // stop, and ensure refuses to start them again
  if (ctx.project && rotating(ctx) && await sessionsUnconfirmed(ctx.db, ctx.project.id)) await ctx.provisioner.stop(ctx.project.ref, RESTORE_STOPS)
} })
