// Free space on the backup volume (runtime I2): a backup, export or import is refused before it is queued when the
// volume runs low, so a full disk never breaks a restore halfway or stops the daily backups.
import { statfs } from 'node:fs/promises'
import { config } from './config.ts'
import { ApiError } from './errors.ts'
import { adminRequest } from './forward.ts'

const GiB = 2 ** 30
const MIN_FREE_BYTES = 5 * GiB
const MIN_FREE_SHARE = 0.1
const gib = (n: number) => (n / GiB).toFixed(1)

// a backup writes at most the database (pg_dump is smaller than the live size) plus the stored objects (storage.tar.gz)
const SIZE_SQL = `select (pg_database_size(current_database())
  + coalesce((select sum((metadata->>'size')::bigint) from storage.objects), 0))::text`

/** The volume's free and total bytes, and a project's backup size; an object, so tests can replace them. */
export const disk = {
  async space(dir: string): Promise<{ free: number; total: number }> {
    const s = await statfs(dir)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  },
  /** The project's database size plus its stored objects' size, as its core reports them. */
  async projectBytes(p: { id: string; ref: string; org_id: string }): Promise<number> {
    const res = await adminRequest(p, 'selfbase-control', '/admin/sql', {
      method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify({ query: SIZE_SQL }) })
    const out = await res.json().catch(() => null)
    const n = Number(out?.rows?.[0]?.[0])
    if (!res.ok || out?.error || !Number.isFinite(n)) throw new Error(`the project's size could not be read (status ${res.status})`)
    return n
  },
}

/**
 * Refuses (507) when the backup volume would keep less than 10% or 5 GiB free (whichever is larger) after writing
 * `bytes`; 503 when it cannot be read. `bytes` is 0 for an import, which writes to the project's own volumes.
 */
export async function checkBackupSpace(bytes = 0): Promise<void> {
  let s: { free: number; total: number }
  try {
    s = await disk.space(config.backupDir)
  } catch {
    throw new ApiError(503, 'backup_volume_unavailable', 'The backup volume cannot be read, so nothing is written to it. Check that it is mounted.')
  }
  const need = Math.max(MIN_FREE_BYTES, s.total * MIN_FREE_SHARE)
  if (s.free - bytes < need) {
    const what = bytes ? `This backup needs up to ${gib(bytes)} GiB (database and storage); the backup volume has ${gib(s.free)} GiB free`
      : `The backup volume has ${gib(s.free)} GiB free`
    throw new ApiError(507, 'backup_volume_full', `${what} and must keep at least ${gib(need)} GiB free `
      + '(10% or 5 GiB, whichever is larger). Remove old backups or exports, or grow the volume, then try again.')
  }
}

/** checkBackupSpace for a backup or export of `p`, sized by its database and storage; 503 when the size is unknown. */
export async function checkProjectBackup(p: { id: string; ref: string; org_id: string }): Promise<void> {
  let bytes: number
  try {
    bytes = await disk.projectBytes(p)
  } catch {
    throw new ApiError(503, 'project_size_unknown', "The project's size cannot be read, so the backup cannot be checked against the free space. Try again when the project is healthy.")
  }
  await checkBackupSpace(bytes)
}
