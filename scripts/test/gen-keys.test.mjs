// scripts/gen-keys.mjs: v1 output by default, the control stack's secrets with --control.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const script = join(import.meta.dirname, '..', 'gen-keys.mjs')
const run = (...args) => {
  const out = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return Object.fromEntries(out.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
}

test('--control prints the four control secrets as env lines', () => {
  const env = run('--control')
  assert.deepEqual(Object.keys(env), ['SELFBASE_MASTER_KEY', 'CONTROL_DB_PASSWORD', 'CONTROL_JWT_SECRET', 'PROVISIONER_TOKEN'])
  assert.match(env.SELFBASE_MASTER_KEY, /^[A-Za-z0-9+/]{43}=$/)
  assert.equal(Buffer.from(env.SELFBASE_MASTER_KEY, 'base64').length, 32)
  assert.ok(env.CONTROL_JWT_SECRET.length >= 32)
  for (const v of Object.values(env)) assert.match(v, /^[A-Za-z0-9+/=_-]{32,}$/)
  assert.notEqual(run('--control').SELFBASE_MASTER_KEY, env.SELFBASE_MASTER_KEY)
})

test('without a flag it prints the v1 keys', () => {
  assert.deepEqual(Object.keys(run()), ['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY'])
})
