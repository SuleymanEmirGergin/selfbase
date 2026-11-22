import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setEnvValues, getEnvValue, escapeCompose } from '../set-panel-password.mjs'

const script = fileURLToPath(new URL('../set-panel-password.mjs', import.meta.url))
const HASH = '$2b$12$Abc.def/GHI0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'
const vals = { PANEL_ADMIN_EMAIL: 'a@b.co', PANEL_ADMIN_PASSWORD_HASH: HASH }

test('appends missing keys, leaves other lines untouched', () => {
  const out = setEnvValues('A=1\n# note\nB=$x y\n', vals)
  assert.equal(out, `A=1\n# note\nB=$x y\nPANEL_ADMIN_EMAIL=a@b.co\nPANEL_ADMIN_PASSWORD_HASH=${escapeCompose(HASH)}\n`)
})

test('replaces existing lines in place', () => {
  const out = setEnvValues('A=1\nPANEL_ADMIN_EMAIL=old@x.io\nB=2\nPANEL_ADMIN_PASSWORD_HASH=\nC=3', vals)
  assert.equal(out, `A=1\nPANEL_ADMIN_EMAIL=a@b.co\nB=2\nPANEL_ADMIN_PASSWORD_HASH=${escapeCompose(HASH)}\nC=3`)
})

test('keeps CRLF style, also when appending to a file without final newline', () => {
  const out = setEnvValues('A=1\r\nPANEL_ADMIN_EMAIL=old\r\nB=2', vals)
  assert.equal(out, `A=1\r\nPANEL_ADMIN_EMAIL=a@b.co\r\nB=2\r\nPANEL_ADMIN_PASSWORD_HASH=${escapeCompose(HASH)}\r\n`)
  assert.ok(!/[^\r]\n/.test(out))
})

test('empty file and idempotent re-run', () => {
  const once = setEnvValues('', vals)
  assert.equal(setEnvValues(once, vals), once)
})

test('every $ is doubled for compose and round-trips', () => {
  const out = setEnvValues('', vals)
  assert.ok(out.includes(`PANEL_ADMIN_PASSWORD_HASH=$$2b$$12$$Abc.`))
  assert.equal(getEnvValue(out, 'PANEL_ADMIN_PASSWORD_HASH'), HASH)
  assert.equal(getEnvValue(out, 'PANEL_ADMIN_EMAIL'), 'a@b.co')
})

test('refuses without a terminal (piped stdin), never reads a password from it', () => {
  const r = spawnSync(process.execPath, [script, '--env', 'does-not-matter.env'], { input: 'a@b.co\nlongenoughpassword\nlongenoughpassword\n', encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /real terminal/)
  assert.ok(!r.stdout.includes('longenoughpassword') && !r.stderr.includes('longenoughpassword'))
})
