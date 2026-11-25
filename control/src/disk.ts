// Free space on the backup volume (runtime I2): a backup, export or import is refused before it is queued when the
// volume runs low, so a full disk never breaks a restore halfway or stops the daily backups. This is an early refusal
// only: the backup job measures what it will dump and checks the space again when it starts (job/backup.sh, exit 4).
import { statfs } from 'node:fs/promises'
import { config } from './config.ts'
import type { Db } from './db.ts'
import { ApiError } from './errors.ts'
import { adminRequest } from './forward.ts'

const GiB = 2 ** 30
const MiB = 2 ** 20
const MIN_FREE_BYTES = 5 * GiB
const MIN_FREE_SHARE = 0.1
const gib = (n: number) => (n / GiB).toFixed(1)

// a backup writes at most the database (pg_dump is smaller than the live size) plus the stored objects. The rows are
// the project's own to change, so an object whose size is not a plain non-negative number counts as 0, never less.
// The catalog functions are pg_catalog's, and projectBytes pins search_path too: a tenant's public.pg_database_size
// (or operator) found first through a role or database search_path cannot answer for them. A superuser can still
// replace pg_catalog's own, so this is an early refusal only: the job's writers are capped (job/backup.sh)
export const SIZE_SQL = `select (pg_catalog.pg_database_size(pg_catalog.current_database()) + coalesce((select pg_catalog.sum(case
  when metadata->>'size' ~ '^[0-9]{1,18}$' then (metadata->>'size')::bigint else 0 end) from storage.objects), 0))::text`
// core runs the script in one transaction and answers with the last statement's rows
const SIZE_SCRIPT = `set local search_path to pg_catalog; ${SIZE_SQL}`

/** The volume's free and total bytes, and a project's backup size; an object, so tests can replace them. */
export const disk = {
  /** how long core may take to answer the size query: one hung core must not hold up the nightly run */
  sizeMs: 10_000,
  async space(dir: string): Promise<{ free: number; total: number }> {
    const s = await statfs(dir)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  },
  /** The project's database size plus its stored objects' size, as its core reports them. */
  async projectBytes(p: { id: string; ref: string; org_id: string }): Promise<number> {
    const res = await adminRequest(p, 'selfbase-control', '/admin/sql', {
      method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify({ query: SIZE_SCRIPT }) }, disk.sizeMs)
    const out = await res.json().catch(() => null)
    const v = out?.rows?.[0]?.[0]
    // 1 to 18 digits, as the job reads it: a negative, huge or odd answer is no size at all
    if (!res.ok || out?.error || typeof v !== 'string' || !/^[0-9]{1,18}$/.test(v)) throw new Error(`the project's size could not be read (status ${res.status})`)
    return Number(v)
  },
}

/** The size a backup of `p` is checked with: its core's answer, else its newest succeeded backup's; null when neither is known. */
export async function backupBytes(db: Db, p: { id: string; ref: string; org_id: string }): Promise<number | null> {
  try {
    return await disk.projectBytes(p)
  } catch {
    // a project whose core is down (ACTIVE_UNHEALTHY) is exactly the one to back up before repairing it
    const r = (await db.query(`select size_bytes from control.backups where project_id = $1 and status = 'succeeded'
      and size_bytes is not null order by finished_at desc nulls last limit 1`, [p.id])).rows[0]
    return r ? Number(r.size_bytes) : null
  }
}

/**
 * Refuses (507) when the backup volume would keep less than the floor free after writing `bytes`; 503 when it cannot be
 * read. The floor is BACKUP_MIN_FREE_MIB when set (the backup jobs' own), else 10% or 5 GiB, whichever is larger.
 * `bytes` is 0 for an import, which writes to the project's own volumes.
 */
export async function checkBackupSpace(bytes = 0): Promise<void> {
  let s: { free: number; total: number }
  try {
    s = await disk.space(config.backupDir)
  } catch {
    throw new ApiError(503, 'backup_volume_unavailable', 'The backup volume cannot be read, so nothing is written to it. Check that it is mounted.')
  }
  const need = config.backupMinFreeMib ? config.backupMinFreeMib * MiB : Math.max(MIN_FREE_BYTES, s.total * MIN_FREE_SHARE)
  if (s.free - bytes < need) {
    const what = bytes ? `This backup needs up to ${gib(bytes)} GiB (database and storage); the backup volume has ${gib(s.free)} GiB free`
      : `The backup volume has ${gib(s.free)} GiB free`
    throw new ApiError(507, 'backup_volume_full', `${what} and must keep at least ${gib(need)} GiB free `
      + `(${config.backupMinFreeMib ? 'BACKUP_MIN_FREE_MIB' : '10% or 5 GiB, whichever is larger'}). Remove old backups or exports, or grow the volume, then try again.`)
  }
}

/** checkBackupSpace for a backup or export of `p`; 503 when its size is not known (backupBytes). */
export async function checkProjectBackup(db: Db, p: { id: string; ref: string; org_id: string }): Promise<void> {
  const bytes = await backupBytes(db, p)
  if (bytes === null) {
    throw new ApiError(503, 'project_size_unknown', "The project's size cannot be read and it has no earlier backup, so the backup cannot be "
      + 'checked against the free space. Try again when the project is healthy.')
  }
  await checkBackupSpace(bytes)
}
