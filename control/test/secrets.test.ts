import { describe, expect, test } from 'vitest'
import { randomBytes, randomInt } from 'node:crypto'
import { TEST_ENV } from './global-setup.ts'
import { loadConfig } from '../src/config.ts'
import { pool } from '../src/db.ts'
import { newRef } from '../src/ids.ts'
import { decrypt, encrypt, getSecrets, putSecret, SecretError } from '../src/secrets.ts'

const refA = newRef()
const refB = newRef()

describe('encrypt / decrypt', () => {
  test('round trip', () => {
    expect(decrypt(refA, 'JWT_SECRET', encrypt(refA, 'JWT_SECRET', 'hello wörld'))).toBe('hello wörld')
  })

  test('a row is bound to its project ref and secret name', () => {
    const row = encrypt(refA, 'JWT_SECRET', 'value')
    expect(() => decrypt(refB, 'JWT_SECRET', row)).toThrow(SecretError)
    expect(() => decrypt(refA, 'ANON_KEY', row)).toThrow(SecretError)
  })

  test('one flipped ciphertext bit fails', () => {
    const row = encrypt(refA, 'JWT_SECRET', 'value')
    for (const i of [0, row.ciphertext.length - 1]) {
      const ciphertext = Buffer.from(row.ciphertext)
      ciphertext[i] ^= 1
      expect(() => decrypt(refA, 'JWT_SECRET', { ...row, ciphertext })).toThrow(SecretError)
    }
  })

  test('two encryptions of one value differ', () => {
    const a = encrypt(refA, 'JWT_SECRET', 'value')
    const b = encrypt(refA, 'JWT_SECRET', 'value')
    expect(a.nonce.length).toBe(12)
    expect(a.nonce.equals(b.nonce)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
  })

  test('an unknown key version fails', () => {
    expect(() => decrypt(refA, 'JWT_SECRET', { ...encrypt(refA, 'JWT_SECRET', 'v'), keyVersion: 2 })).toThrow(SecretError)
  })
})

describe('master key', () => {
  test('a key of 31 bytes stops startup, naming the key', () => {
    expect(() => loadConfig({ ...TEST_ENV, SELFBASE_MASTER_KEY: randomBytes(31).toString('base64') })).toThrow(/SELFBASE_MASTER_KEY/)
  })

  test('a missing key stops startup, naming the key', () => {
    expect(() => loadConfig({ ...TEST_ENV, SELFBASE_MASTER_KEY: '' })).toThrow(/SELFBASE_MASTER_KEY/)
  })

  test('a 32-byte key is accepted', () => {
    expect(loadConfig(TEST_ENV).masterKey.length).toBe(32)
  })
})

describe('putSecret / getSecrets', () => {
  test('returns what was stored; the ciphertext column never holds the plaintext', async () => {
    const org = (await pool.query(`insert into control.organizations (slug, name) values ($1, 'Secrets') returning id`, [`o-${refA}`])).rows[0]
    const project = (await pool.query(
      `insert into control.projects (ref, org_id, name, status, size, subnet) values ($1, $2, 'p', 'COMING_UP', 'micro', $3) returning id, ref`,
      [refA, org.id, `10.207.${randomInt(256)}.${randomInt(8) * 32}/27`],
    )).rows[0]
    const value = `secret-${randomBytes(16).toString('hex')}`
    await putSecret(pool, project, 'JWT_SECRET', 'platform', value)
    await putSecret(pool, project, 'MY_FN_KEY', 'function', 'fn-value')
    await putSecret(pool, project, 'MY_FN_KEY', 'function', 'fn-value-2') // an update replaces the row
    expect(await getSecrets(pool, project)).toEqual({ JWT_SECRET: value, MY_FN_KEY: 'fn-value-2' })

    const rows = (await pool.query(`select ciphertext from control.project_secrets where project_id = $1`, [project.id])).rows
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.ciphertext.includes(Buffer.from(value))).toBe(false)
      expect(r.ciphertext.includes(Buffer.from('fn-value'))).toBe(false)
    }
  })
})
