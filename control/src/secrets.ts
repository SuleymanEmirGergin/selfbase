// Project secrets at rest (spec 7.4, AC-10): AES-256-GCM under SELFBASE_MASTER_KEY, a random 96-bit nonce per
// value, AAD '<ref>:<name>' so a row cannot be moved to another project or name. Errors never carry a value.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from './config.ts'
import type { Db } from './db.ts'

export class SecretError extends Error {}

export type SecretRow = { ciphertext: Buffer; nonce: Buffer; keyVersion: number }

// bump on master-key rotation; rows of an older version are re-encrypted in one transaction
const KEY_VERSION = 1
const TAG = 16

export function encrypt(ref: string, name: string, plaintext: string): SecretRow {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', config.masterKey, nonce)
  cipher.setAAD(Buffer.from(`${ref}:${name}`))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { ciphertext, nonce, keyVersion: KEY_VERSION }
}

export function decrypt(ref: string, name: string, row: SecretRow): string {
  const fail = (why: string) => new SecretError(`secret ${name} of project ${ref}: ${why}`)
  if (row.keyVersion !== KEY_VERSION) throw fail(`unknown key version ${row.keyVersion}`)
  if (row.nonce.length !== 12 || row.ciphertext.length < TAG) throw fail('malformed row')
  try {
    const decipher = createDecipheriv('aes-256-gcm', config.masterKey, row.nonce)
    decipher.setAAD(Buffer.from(`${ref}:${name}`))
    decipher.setAuthTag(row.ciphertext.subarray(-TAG))
    return Buffer.concat([decipher.update(row.ciphertext.subarray(0, -TAG)), decipher.final()]).toString('utf8')
  } catch {
    throw fail('cannot be decrypted (wrong key, project or name, or the row was altered)')
  }
}

export async function putSecret(db: Db, project: { id: string; ref: string }, name: string, kind: 'platform' | 'function',
  value: string): Promise<void> {
  const row = encrypt(project.ref, name, value)
  await db.query(
    `insert into control.project_secrets (project_id, name, kind, ciphertext, nonce, key_version) values ($1, $2, $3, $4, $5, $6)
     on conflict (project_id, name) do update
       set kind = excluded.kind, ciphertext = excluded.ciphertext, nonce = excluded.nonce, key_version = excluded.key_version,
           updated_at = now()`,
    [project.id, name, kind, row.ciphertext, row.nonce, row.keyVersion],
  )
}

export async function getSecrets(db: Db, project: { id: string; ref: string }): Promise<Record<string, string>> {
  const { rows } = await db.query(
    `select name, ciphertext, nonce, key_version as "keyVersion" from control.project_secrets where project_id = $1 order by name`,
    [project.id],
  )
  return Object.fromEntries(rows.map((r) => [r.name, decrypt(project.ref, r.name, r)]))
}
