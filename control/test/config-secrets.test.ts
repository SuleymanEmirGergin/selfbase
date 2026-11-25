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

it('I3: the retention settings are whole numbers (a fraction would break make_interval and the backup job)', () => {
  expect(loadConfig(plain)).toMatchObject({ backupRetentionDays: 7, exportRetentionDays: 7, backupMaxCount: 14 })
  expect(loadConfig({ ...plain, BACKUP_RETENTION_DAYS: '0', EXPORT_RETENTION_DAYS: '30', BACKUP_MAX_COUNT: '3' }))
    .toMatchObject({ backupRetentionDays: 0, exportRetentionDays: 30, backupMaxCount: 3 })
  for (const k of ['BACKUP_RETENTION_DAYS', 'EXPORT_RETENTION_DAYS']) {
    for (const bad of ['1.5', '-1', '1e3', 'x']) expect(() => loadConfig({ ...plain, [k]: bad }), bad).toThrow(`config: ${k} must be a whole number of days`)
  }
  for (const bad of ['0', '2.5', '-3']) expect(() => loadConfig({ ...plain, BACKUP_MAX_COUNT: bad }), bad).toThrow('config: BACKUP_MAX_COUNT must be a whole number from 1')
})

it('BASE_DOMAIN and TEST_HOST must be hostnames, and no IP literal is one', () => {
  for (const bad of ['example .test', 'https://example.test', 'example.test/', 'EXAMPLE.test', '203.0.113.5', 'single'])
    expect(() => loadConfig({ ...plain, BASE_DOMAIN: bad }), bad).toThrow(/BASE_DOMAIN/)
  for (const bad of ['sb test.example.test', 'sb-test.example.test:443', '203.0.113.5'])
    expect(() => loadConfig({ ...plain, TEST_HOST: bad }), bad).toThrow(/TEST_HOST/)
  expect(() => loadConfig({ ...plain, LEGACY_HOSTNAMES: '203.0.113.5' })).toThrow(/LEGACY_HOSTNAMES/)
  expect(loadConfig({ ...plain, BASE_DOMAIN: '203.0.113.5.sslip.io' }).testHost).toBe('sb-test.203.0.113.5.sslip.io')
  // a local install (REHBER, test/e2e): localhost is the one bare name allowed, for TEST_HOST too
  expect(loadConfig({ ...plain, BASE_DOMAIN: 'localhost' })).toMatchObject({ baseDomain: 'localhost', testHost: 'sb-test.localhost',
    publicUrl: 'https://selfbase.localhost' })
  expect(loadConfig({ ...plain, BASE_DOMAIN: 'localhost', TEST_HOST: 'localhost' }).testHost).toBe('localhost')
  for (const bare of ['single', 'local', 'localhost.'])
    expect(() => loadConfig({ ...plain, BASE_DOMAIN: bare }), bare).toThrow(/BASE_DOMAIN/)
})
