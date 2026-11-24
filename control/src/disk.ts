// Free space on the backup volume (runtime I2): a backup, export or import is refused before it is queued when the
// volume runs low, so a full disk never breaks a restore halfway or stops the daily backups.
import { statfs } from 'node:fs/promises'
import { config } from './config.ts'
import { ApiError } from './errors.ts'

const GiB = 2 ** 30
const MIN_FREE_BYTES = 5 * GiB
const MIN_FREE_SHARE = 0.1
const gib = (n: number) => (n / GiB).toFixed(1)

/** The volume's free and total bytes; an object, so tests can replace it. */
export const disk = {
  async space(dir: string): Promise<{ free: number; total: number }> {
    const s = await statfs(dir)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  },
}

/** Refuses (507) below 10% or 5 GiB free on the backup volume, whichever is larger; 503 when it cannot be read. */
export async function checkBackupSpace(): Promise<void> {
  let s: { free: number; total: number }
  try {
    s = await disk.space(config.backupDir)
  } catch {
    throw new ApiError(503, 'backup_volume_unavailable', 'The backup volume cannot be read, so nothing is written to it. Check that it is mounted.')
  }
  const need = Math.max(MIN_FREE_BYTES, s.total * MIN_FREE_SHARE)
  if (s.free < need) {
    throw new ApiError(507, 'backup_volume_full', `The backup volume has ${gib(s.free)} GiB free and needs at least ${gib(need)} GiB `
      + '(10% or 5 GiB, whichever is larger). Remove old backups or exports, or grow the volume, then try again.')
  }
}
