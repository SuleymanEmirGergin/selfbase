// Run without npm: `node --test` from the scripts/ directory (or `node --test scripts/test/set-panel-password.test.mjs`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setEnvValues, getEnvValue, escapeCompose, writeEnvFile, processKeys, validatePassword } from '../set-panel-password.mjs'

const script = fileURLToPath(new URL('../set-panel-password.mjs', import.meta.url))
const HASH = '$2b$12$Abc.def/GHI0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'
const vals = { PANEL_ADMIN_EMAIL: 'a@b.co', PANEL_ADMIN_PASSWORD_HASH: HASH }
const tmp = () => mkdtempSync(join(tmpdir(), 'spp-'))
const win = process.platform === 'win32'

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

test('every $ is doubled for compose and round-trips, also in the email', () => {
  const out = setEnvValues('', { ...vals, PANEL_ADMIN_EMAIL: 'a$b@x.io' })
  assert.ok(out.includes('PANEL_ADMIN_PASSWORD_HASH=$$2b$$12$$Abc.'))
  assert.equal(getEnvValue(out, 'PANEL_ADMIN_PASSWORD_HASH'), HASH)
  assert.equal(getEnvValue(out, 'PANEL_ADMIN_EMAIL'), 'a$b@x.io')
  assert.equal(getEnvValue(setEnvValues(out, vals), 'PANEL_ADMIN_EMAIL'), 'a@b.co') // read -> write -> read
})

test('a leading BOM is matched through and kept', () => {
  const out = setEnvValues('﻿PANEL_ADMIN_EMAIL=old\nB=2\n', vals)
  assert.ok(out.startsWith('﻿PANEL_ADMIN_EMAIL=a@b.co\n'))
  assert.equal(out.slice(1).split('﻿').length, 1)
  assert.equal(getEnvValue('﻿PANEL_ADMIN_EMAIL=x@y.z\n', 'PANEL_ADMIN_EMAIL'), 'x@y.z')
})

test('matching quotes around an existing value are not offered as default', () => {
  assert.equal(getEnvValue('PANEL_ADMIN_EMAIL="q@x.io"\n', 'PANEL_ADMIN_EMAIL'), 'q@x.io')
  assert.equal(getEnvValue("PANEL_ADMIN_EMAIL='q@x.io'\r\n", 'PANEL_ADMIN_EMAIL'), 'q@x.io')
  assert.equal(getEnvValue('PANEL_ADMIN_EMAIL="q@x.io\n', 'PANEL_ADMIN_EMAIL'), '"q@x.io')
})

test('writeEnvFile: no temp file left after success, new file is private, existing mode kept', { skip: false }, () => {
  const d = tmp()
  try {
    const f = join(d, '.env')
    writeEnvFile(f, 'A=1\n')
    assert.equal(readFileSync(f, 'utf8'), 'A=1\n')
    assert.deepEqual(readdirSync(d), ['.env'])
    if (!win) assert.equal(statSync(f).mode & 0o777, 0o600)
    if (!win) {
      chmodSync(f, 0o640)
      writeEnvFile(f, 'A=2\n')
      assert.equal(statSync(f).mode & 0o777, 0o640)
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('writeEnvFile: a failing rename leaves no temp file behind and throws', () => {
  const d = tmp()
  try {
    const f = join(d, '.env')
    mkdirSync(f) // renaming a file over a directory fails
    assert.throws(() => writeEnvFile(f, 'SECRET=1\n'))
    assert.deepEqual(readdirSync(d), ['.env'])
  } finally { rmSync(d, { recursive: true, force: true }) }
})

const keys = (...chunks) => chunks.reduce((s, c) => processKeys(s, c), { buf: '', done: false, aborted: false })

test('key handler ignores CSI/SS3 sequences and a lone ESC', () => {
  assert.equal(keys('ab\u001b[Ac\u001b[3~d\u001b[1;5Ce\u001bOHf\u001b').buf, 'abcdef')
})

test('key handler: backspace removes a whole code point, newline ends the entry and drops the rest', () => {
  assert.equal(keys('a\u{1F600}\u007f').buf, 'a')
  const s = keys('abc\nignored')
  assert.deepEqual(s, { buf: 'abc', done: true, aborted: false })
  assert.equal(keys('x\u0003').aborted, true)
})

test('password rules count code points and bound the UTF-8 size', () => {
  assert.equal(validatePassword('a'.repeat(11)) !== null, true)
  assert.equal(validatePassword('a'.repeat(12)), null)
  assert.equal(validatePassword('\u{1F600}'.repeat(12)), null) // 12 code points, 48 bytes
  assert.equal(validatePassword('a'.repeat(72)), null)
  assert.match(validatePassword('a'.repeat(73)), /72 bytes/)
  assert.match(validatePassword('é'.repeat(40)), /72 bytes/) // 80 bytes
})

test('refuses without a terminal (piped stdin), never reads a password from it', () => {
  const r = spawnSync(process.execPath, [script, '--env', 'does-not-matter.env'], { input: 'a@b.co\nlongenoughpassword\nlongenoughpassword\n', encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /real terminal/)
  assert.ok(!r.stdout.includes('longenoughpassword') && !r.stderr.includes('longenoughpassword'))
})

test('main guard also fires when started through a symlink', (t) => {
  const d = tmp()
  try {
    const link = join(d, 'link.mjs')
    try { symlinkSync(script, link) } catch { return t.skip('symlinks not permitted here') }
    const r = spawnSync(process.execPath, [link], { input: '', encoding: 'utf8' })
    assert.equal(r.status, 2)
  } finally { rmSync(d, { recursive: true, force: true }) }
})
