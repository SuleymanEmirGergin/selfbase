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
