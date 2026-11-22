// Backup, export and import jobs (spec 8.8 and section 10), heavy lane: each runs a provisioner job (job/backup.sh,
// job/restore.sh) and waits for it. Database passwords are read inside the step and go to the provisioner call only,
// never into a payload, an event or an error. A provisioner job's result is read once (the provisioner removes a
// finished job when it reports it), so a waiting step never retries.
import { config } from '../config.ts'
import { ProvisionerError } from '../provisioner.ts'
import { getSecrets } from '../secrets.ts'
import { defineJob, type JobCtx } from './engine.ts'
import { activate, certificate, createSteps, failTo, healthy, healthySteps, need, step } from './project.ts'

// what an import stops for the restore; db keeps running (the restore job connects to it)
export const RESTORE_STOPS = ['core', 'rest', 'fn', 'pooler']
// shortcut: a fixed budget for one backup or restore; make it a setting when a project's dump takes hours
const JOB_MS = 6 * 3600_000
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
    // the scripts print names and paths, never a value from their environment
    const tail = s.tail.trim().split('\n').slice(-10).join('\n')
    if (tail) await ctx.log(`${type}_output`, { tail })
    if (s.status === 'succeeded') return s.tail
    if (type === 'restore' && s.exitCode === 10) throw new Error('the restore failed and rolled back: the database was not changed')
    if (type === 'restore' && s.exitCode === 3) {
      throw new Error('the database was restored but the storage files were not (or only partly); run the import again')
    }
    throw new Error(`the ${type} job failed (${s.exitCode === null ? 'it never started' : `exit ${s.exitCode}`})`)
  }
}

const lastMatch = (re: RegExp, text: string) => [...text.matchAll(re)].at(-1)?.[1] ?? null
const retention = () => String(config.backupRetentionDays)
const dbPassword = async (ctx: JobCtx) => (await getSecrets(ctx.db, need(ctx))).POSTGRES_PASSWORD

/** project.backup and project.export: one backup job into `subdir`, then its backups row. */
const backupSteps = (subdir: (ctx: JobCtx) => string, extra: (ctx: JobCtx) => Record<string, string> = () => ({})) => [
  step('backup', async (ctx) => ctx.provisioner.runJob(need(ctx).ref, 'backup', {},
    { PGHOST: 'db', PGPASSWORD: await dbPassword(ctx), BACKUP_SUBDIR: subdir(ctx), BACKUP_RETENTION_DAYS: retention(), ...extra(ctx) })),
  step('record', async (ctx) => {
    const tail = await waitFor(ctx, need(ctx).ref, 'backup')
    const size = lastMatch(/^backup: size (\d+) bytes$/gm, tail)
    await ctx.db.query(
      `insert into control.backups (project_id, kind, status, started_at, finished_at, size_bytes, location)
       values ($1, 'logical', 'succeeded', (select created_at from control.jobs where id = $2), now(), $3, $4)`,
      [need(ctx).id, ctx.job.id, size === null ? null : Number(size), lastMatch(/^backup: wrote (\S+)$/gm, tail)],
    )
  }, false),
]

// a failed backup leaves the project as it is: the failed job is the record
defineJob('project.backup', 'heavy', backupSteps((ctx) => need(ctx).ref))

// the payload carries the manifest sealed in the request, in pieces (payload strings are capped at 2048 characters)
defineJob('project.export', 'heavy', backupSteps((ctx) => `export-${need(ctx).ref}`,
  (ctx) => ({ MANIFEST_B64: (ctx.job.payload.manifest as string[]).join('') })))

defineJob('control.backup', 'heavy', [
  step('backup', (ctx) => ctx.provisioner.runJob('control', 'backup', {},
    { PGHOST: config.dbHost, PGPASSWORD: config.dbPassword, BACKUP_SUBDIR: 'control', BACKUP_RETENTION_DAYS: retention() })),
  step('wait', async (ctx) => {
    await ctx.log('backed_up', { location: lastMatch(/^backup: wrote (\S+)$/gm, await waitFor(ctx, 'control', 'backup')) })
  }, false),
])

// The project comes up empty as a create would (status RESTORING throughout), then the backup replaces its database
// and storage with core, rest, fn and pooler stopped; core applies the platform migrations when it starts again.
defineJob('project.import', 'heavy', [
  ...createSteps,
  step('healthy', healthy, false),
  step('stop', (ctx) => ctx.provisioner.stop(need(ctx).ref, RESTORE_STOPS)),
  step('restore', async (ctx) => ctx.provisioner.runJob(need(ctx).ref, 'restore', { dir: ctx.job.payload.backup_dir },
    { PGHOST: 'db', PGPASSWORD: await dbPassword(ctx) })),
  step('restored', (ctx) => waitFor(ctx, need(ctx).ref, 'restore'), false),
  step('start', (ctx) => ctx.provisioner.start(need(ctx).ref, RESTORE_STOPS)),
  step('started', healthy, false),
  healthySteps[1], // warm
  step('certificate', certificate, false),
  activate,
], failTo('INIT_FAILED', ['certificate']))
