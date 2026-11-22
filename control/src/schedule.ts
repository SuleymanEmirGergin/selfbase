// Daily backups (plan D-7, spec 8.8): at 03:15 UTC one control.backup and one project.backup per ACTIVE_HEALTHY
// project; the heavy lane runs them one at a time. A run missed while control was down is not replayed.
import type { Db } from './db.ts'
import { enqueue, enqueueIfIdle } from './jobs/index.ts'

/** Milliseconds from `now` to the next 03:15 UTC (a full day when it is 03:15 exactly). */
export function msUntilNext(now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 15))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

/** A project with a pending or running job (a pause, an upgrade, last night's backup) is skipped tonight. */
export async function enqueueDailyBackups(db: Db): Promise<void> {
  // one control.backup at a time: a night whose backup is still queued or running gets no second one
  const queued = await db.query(`select 1 from control.jobs where type = 'control.backup' and status in ('pending', 'running')`)
  if (!queued.rowCount) await enqueue(db, { type: 'control.backup', payload: {}, createdBy: null })
  const { rows } = await db.query(`select id from control.projects where status = 'ACTIVE_HEALTHY' order by created_at`)
  for (const r of rows) await enqueueIfIdle(db, { type: 'project.backup', projectId: r.id, payload: {}, createdBy: null })
}

export function startSchedule(db: Db): { stop(): void } {
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
