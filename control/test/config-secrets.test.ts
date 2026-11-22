// The control stack's secrets come from files (compose secrets), so they are not in the container's Config.Env, which
// Traefik's socket proxy may read; the plain variables stay a fallback for development and tests.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const dir = mkdtempSync(join(tmpdir(), 'sb-config-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = (name: string, value: string) => {
  writeFileSync(join(dir, name), `${value}\n`)
  return join(dir, name)
}
const KEY = Buffer.alloc(32, 3).toString('base64')
const plain = { SELFBASE_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), CONTROL_DB_PASSWORD: 'plain-db', CONTROL_JWT_SECRET: 'p'.repeat(40),
  PROVISIONER_TOKEN: 'plain-token-0123456789abcdef0123456789', BASE_DOMAIN: 'example.test', TEMPLATE_VERSION: '2.0.0' }

it('reads <KEY>_FILE before <KEY>, trimming the trailing newline', () => {
  const c = loadConfig({ ...plain, SELFBASE_MASTER_KEY_FILE: file('master_key', KEY), CONTROL_DB_PASSWORD_FILE: file('db', 'file-db'),
    CONTROL_JWT_SECRET_FILE: file('jwt', 'j'.repeat(40)), PROVISIONER_TOKEN_FILE: file('token', 't'.repeat(40)) })
  expect(c.masterKey.equals(Buffer.from(KEY, 'base64'))).toBe(true)
  expect([c.dbPassword, c.jwtSecret, c.provisionerToken]).toEqual(['file-db', 'j'.repeat(40), 't'.repeat(40)])
})

it('falls back to the plain variable, and names an unreadable file by key only', () => {
  expect(loadConfig(plain).dbPassword).toBe('plain-db')
  expect(() => loadConfig({ ...plain, PROVISIONER_TOKEN_FILE: join(dir, 'missing') })).toThrow('config: PROVISIONER_TOKEN_FILE cannot be read')
})
