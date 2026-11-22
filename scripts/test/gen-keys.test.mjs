// scripts/gen-keys.mjs: v1 output by default; with --secrets <dir> [gid] the control stack's secret files, never
// printed, never overwritten.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const script = join(import.meta.dirname, '..', 'gen-keys.mjs')

test('without a flag it prints the v1 keys', () => {
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  assert.deepEqual(out.trim().split('\n').map((l) => l.slice(0, l.indexOf('='))), ['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY'])
})
const FILES = ['master_key', 'control_db_password', 'control_jwt_secret', 'provisioner_token']

test('writes the four secret files, prints nothing secret, refuses to overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-gen-keys-'))
  try {
    const r = spawnSync(process.execPath, [script, '--secrets', dir], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const values = FILES.map((f) => readFileSync(join(dir, f), 'utf8').trim())
    assert.match(values[0], /^[A-Za-z0-9+/]{43}=$/)
    for (const v of values.slice(1)) assert.ok(v.length >= 32)
    for (const v of values) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v))
    if (process.platform === 'linux') for (const f of FILES) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o640, f)
    const again = spawnSync(process.execPath, [script, '--secrets', dir], { encoding: 'utf8' })
    assert.equal(again.status, 1)
    assert.match(again.stderr, /master_key exists already/)
    assert.equal(readFileSync(join(dir, 'master_key'), 'utf8').trim(), values[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
