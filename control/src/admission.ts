// Memory admission (spec section 7.6, CC-2): creating, resuming or resizing a project is refused when
// shared-stack caps + job slot + caps of running projects + the new cap > MEMORY_BUDGET_MB x OVERCOMMIT.
import { config } from './config.ts'
import type { Db } from './db.ts'
import { ApiError } from './errors.ts'
import { projectCapMb } from './sizes.ts'

export type Size = 'micro' | 'small' | 'medium'
type Sizes = Parameters<typeof projectCapMb>[1]

// Supabase's project statuses. Only these cost no memory; any other status, known or not, counts as running.
// REMOVE_FAILED counts as stopped; a delete that failed before its remove step may still hold memory until retried.
const STOPPED = ['INACTIVE', 'REMOVED', 'REMOVE_FAILED']
export const RUNNING_STATUSES = ['ACTIVE_HEALTHY', 'ACTIVE_UNHEALTHY', 'COMING_UP', 'GOING_DOWN', 'INIT_FAILED', 'PAUSING',
  'PAUSE_FAILED', 'RESIZING', 'RESTARTING', 'RESTORE_FAILED', 'RESTORING', 'UNKNOWN', 'UPGRADING']

export class AdmissionError extends ApiError {
  details: { neededMb: number; freeMb: number }
  constructor(code: 'insufficient_memory', details: { neededMb: number; freeMb: number }, message: string) {
    super(409, code, message)
    this.details = details
  }
}

/** Sum of the memory caps of every running project, optionally leaving one out (a resize). */
export async function usedMb(db: Db, sizes?: Sizes, excludeProjectId?: string): Promise<number> {
  const rows = (await db.query(
    `select size, count(*)::int as n from control.projects
     where status <> all($1) and ($2::uuid is null or id <> $2) group by size`,
    [STOPPED, excludeProjectId ?? null],
  )).rows
  return rows.reduce((sum, r) => sum + r.n * projectCapMb(r.size, sizes), 0)
}

/** The node's budget (the nodes row, seeded from MEMORY_BUDGET_MB) and what is left for one more project. */
export async function capacity(db: Db, sizes?: Sizes, excludeProjectId?: string) {
  const row = (await db.query('select memory_budget_mb from control.nodes where name = $1', [config.nodeName])).rows[0]
  if (!row) throw new Error(`admission: no nodes row named ${config.nodeName}`)
  const used = await usedMb(db, sizes, excludeProjectId)
  return {
    budget_mb: row.memory_budget_mb as number,
    reserved_mb: config.sharedReservedMb,
    job_slot_mb: config.jobSlotMb,
    used_mb: used,
    free_mb: Math.floor(row.memory_budget_mb * config.overcommit) - config.sharedReservedMb - config.jobSlotMb - used,
  }
}

/**
 * Throws AdmissionError when a project of this size does not fit. Pass `excludeProjectId` on a resize so the
 * project's current size is not counted twice.
 * shortcut: check only, no reservation; two concurrent creates can both pass. Callers serialize if that matters.
 */
export async function admit(db: Db, want: { size: Size; excludeProjectId?: string }, sizes?: Sizes): Promise<void> {
  const neededMb = projectCapMb(want.size, sizes)
  const freeMb = (await capacity(db, sizes, want.excludeProjectId)).free_mb
  if (neededMb <= freeMb) return
  throw new AdmissionError('insufficient_memory', { neededMb, freeMb },
    `This server has ${Math.max(freeMb, 0)} MiB of memory free and a ${want.size} project needs ${neededMb} MiB. ` +
      'Pause or delete a project you do not use, or choose a smaller size.')
}
