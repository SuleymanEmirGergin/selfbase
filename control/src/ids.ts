// Project refs and personal access tokens (global constraints, AC-1). Same ref format as provisioner/src/names.ts.
import { createHash, randomBytes, randomInt } from 'node:crypto'

export const REF_RE = /^[a-z]{20}$/

export const newRef = (): string => Array.from({ length: 20 }, () => String.fromCharCode(97 + randomInt(26))).join('')

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** `sbp_` + 40 hex; only the hash is stored, the token is shown once. */
export function newAccessToken(): { token: string; hash: string } {
  const token = `sbp_${randomBytes(20).toString('hex')}`
  return { token, hash: hashToken(token) }
}
