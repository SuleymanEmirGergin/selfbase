// Daily backups (plan D-7, spec 8.8): at 03:15 UTC one control.backup and one project.backup per project that should
// be running (ACTIVE_HEALTHY, ACTIVE_UNHEALTHY, COMING_UP: a live database; one that is really down fails as a job); the heavy lane runs them one at a time. A run missed while control was down is not replayed.
import type pg from 'pg'
import { backupBytes, checkBackupSpace } from './disk.ts'
import { DESIRED_RUNNING, enqueue, enqueueIfIdle } from './jobs/index.ts'

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

export function startSchedule(db: pg.Pool): { stop(): void } {
  let timer: NodeJS.Timeout
  // a timer may fire a little early: the next one is armed from a minute ahead, so one 03:15 never runs twice
  const arm = (from: number) => {
    timer = setTimeout(() => {
      enqueueDailyBackups(db).catch((e: Error) => console.error(`schedule: daily backups not enqueued: ${e.message}`))
      arm(60_000)
    }, msUntilNext(new Date(Date.now() + from)) + from)
    timer.unref()
  }
  arm(0)
  return { stop: () => clearTimeout(timer) }
}
