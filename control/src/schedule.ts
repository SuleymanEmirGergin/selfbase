// Daily backups (plan D-7, spec 8.8): at 03:15 UTC one control.backup and one project.backup per project that should
// be running (ACTIVE_HEALTHY, ACTIVE_UNHEALTHY, COMING_UP: a live database; one that is really down fails as a job); the heavy lane runs them one at a time. A run missed while control was down is not replayed.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { config } from './config.ts'
import { backupBytes, checkBackupSpace } from './disk.ts'
import { DESIRED_RUNNING, enqueue, enqueueCoalesced, enqueueIfIdle } from './jobs/index.ts'

/** Milliseconds from `now` to the next 03:15 UTC (a full day when it is 03:15 exactly). */
export function msUntilNext(now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 15))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

/** A project with a pending or running job (a pause, an upgrade, last night's backup) is skipped tonight. */
export async function enqueueDailyBackups(db: pg.Pool): Promise<void> {
  const { rows } = await db.query(`select id, ref, org_id from control.projects where status = any($1) order by created_at`, [DESIRED_RUNNING])
  // a low backup volume: tonight's backups are refused, each as a failed job with the reason (a failed job is the record)
  const refused = await checkBackupSpace().then(() => null, (e: Error) => e.message)
  if (refused) {
    console.error(`schedule: daily backups refused: ${refused}`)
    for (const projectId of [null, ...rows.map((r) => r.id)]) {
      await db.query(`insert into control.jobs (type, project_id, lane, step, payload, status, error) values ($1, $2, 'heavy', '0', '{}', 'failed', $3)`,
        [projectId ? 'project.backup' : 'control.backup', projectId, refused])
    }
    return
  }
  // one control.backup at a time: a night whose backup is still queued or running gets no second one
  const queued = await db.query(`select 1 from control.jobs where type = 'control.backup' and status in ('pending', 'running')`)
  if (!queued.rowCount) await enqueue(db, { type: 'control.backup', payload: {}, createdBy: null })
  // each backup is sized against the space the ones queued before it tonight will take
  let queuedBytes = 0
  for (const r of rows) {
    // core's answer within disk.sizeMs, else the newest backup's size (a project whose core is down still gets one)
    const bytes = await backupBytes(db, r)
    const refusal = bytes === null ? "the project's size could not be read and it has no earlier backup" : await checkBackupSpace(queuedBytes + bytes).then(() => null, (e: Error) => e.message)
    if (refusal) {
      console.error(`schedule: backup of ${r.ref} refused: ${refusal}`)
      await db.query(`insert into control.jobs (type, project_id, lane, step, payload, status, error) values ('project.backup', $1, 'heavy', '0', '{}', 'failed', $2)`,
        [r.id, refusal])
      continue
    }
    if (await enqueueIfIdle(db, { type: 'project.backup', projectId: r.id, payload: {}, createdBy: null })) queuedBytes += bytes!
  }
}

// a backup directory's name: its UTC start time
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

/**
 * One project.prune per project, of any status (a deleted one's exports stay on disk otherwise), whose export-<ref>
 * holds an export older than EXPORT_RETENTION_DAYS. Queued behind tonight's backup, never twice while pending.
 */
export async function enqueueExportPrunes(db: pg.Pool): Promise<void> {
  const cutoff = stamp(new Date(Date.now() - config.exportRetentionDays * 86_400_000))
  // the backup root is 0711 (control cannot list it); each export-<ref> is control's group's to read (backup.sh)
  for (const { id, ref } of (await db.query('select id, ref from control.projects order by created_at')).rows) {
    let names: string[]
    try {
      names = await readdir(join(config.backupDir, `export-${ref}`))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`schedule: export-${ref} cannot be read: ${(e as Error).message}`)
      continue
    }
    if (names.some((n) => /^\d{8}-\d{6}$/.test(n) && n < cutoff)) {
      await enqueueCoalesced(db, { type: 'project.prune', projectId: id, payload: {}, createdBy: null })
    }
  }
}

export function startSchedule(db: pg.Pool): { stop(): void } {
  let timer: NodeJS.Timeout
  // a timer may fire a little early: the next one is armed from a minute ahead, so one 03:15 never runs twice
  const arm = (from: number) => {
    timer = setTimeout(() => {
      // the prunes after the backups: a refused night (low disk) still frees what has expired
      enqueueDailyBackups(db).catch((e: Error) => console.error(`schedule: daily backups not enqueued: ${e.message}`))
        .then(() => enqueueExportPrunes(db)).catch((e: Error) => console.error(`schedule: export prunes not enqueued: ${e.message}`))
      arm(60_000)
    }, msUntilNext(new Date(Date.now() + from)) + from)
    timer.unref()
  }
  arm(0)
  return { stop: () => clearTimeout(timer) }
}
