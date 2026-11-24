import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.ts'

/** Storage error rendered as Supabase's `{statusCode, error, message}` body. */
export class StorageError extends Error {
  status: number
  error: string
  constructor(status: number, error: string, message = error) {
    super(message)
    this.status = status
    this.error = error
  }
}

const badKey = () => new StorageError(400, 'InvalidKey', 'Invalid key')

/** Disk path of an object: <STORAGE_DIR>/<bucket>/<name>. Throws InvalidKey for anything that could escape STORAGE_DIR. */
// shortcut: assumes a case-sensitive filesystem without alternate data streams (Linux); on Windows/macOS hosts
// distinct keys like `A`/`a` or `x:y` can alias one file. Map keys to safe file names before supporting such hosts.
export function resolveObjectPath(bucket: string, name: string): string {
  for (const key of [bucket, name]) {
    if (!key || key.startsWith('/') || key.includes('\\') || key.includes('\0')) throw badKey()
    if (key.split('/').some((p) => p === '' || p === '.' || p === '..')) throw badKey()
  }
  if (bucket.includes('/')) throw badKey()
  const root = path.resolve(config.storageDir)
  const file = path.resolve(root, bucket, name)
  if (!file.startsWith(root + path.sep)) throw badKey()
  return file
}

/**
 * Whether `p` (an object's file, or the directory an upload writes into) is inside its bucket's directory once every
 * symlink is resolved. A restored or hand-placed link must never serve or receive a file outside the bucket
 * (/proc/self/environ, another bucket). False also when `p` does not exist.
 */
export async function insideBucket(bucket: string, p: string): Promise<boolean> {
  const real = await Promise.all([realpath(config.storageDir), realpath(p)]).catch(() => null)
  if (!real) return false
  const dir = path.join(real[0], bucket)
  return real[1] === dir || real[1].startsWith(dir + path.sep)
}
