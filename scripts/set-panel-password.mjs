#!/usr/bin/env node
// Sets the admin panel login: writes PANEL_ADMIN_EMAIL and PANEL_ADMIN_PASSWORD_HASH (bcrypt, cost 12)
// into an env file. Usage: node scripts/set-panel-password.mjs [--env <path, default ./.env>]
// Interactive only: the password is read from the terminal without echo, never from argv or env,
// and neither it nor the hash is printed.
//
// Compose escaping: compose.yml passes ${PANEL_ADMIN_PASSWORD_HASH:-} to core, and docker compose
// interpolates `$` in .env values; a bcrypt hash ($2b$12$<salt>...) would be cut at `$<letter>`.
// So every `$` is stored as `$$` (verified with a probe container: core then receives the exact
// hash). Readers that take .env literally (scripts/migrate/lib.sh) do not use these two keys.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, renameSync, statSync, chmodSync, unlinkSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const MIN_PASSWORD = 12 // code points
export const MAX_PASSWORD_BYTES = 72 // bcrypt ignores everything after 72 bytes
export const escapeCompose = (v) => v.replaceAll('$', '$$$$')
export const unescapeCompose = (v) => v.replaceAll('$$', '$')

const BOM = '﻿'

// Replaces the first `KEY=` line of each key (extra duplicates of it are dropped), appends missing
// keys; every other line stays byte-for-byte, the file's line-ending style and a leading BOM are kept.
export function setEnvValues(input, values) {
  const bom = input.startsWith(BOM) ? BOM : ''
  const text = bom ? input.slice(1) : input
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.split(/(?<=\n)/) // keeps each line's own terminator
  const done = new Set()
  const out = []
  for (const line of lines) {
    const key = Object.keys(values).find((k) => line.startsWith(`${k}=`))
    if (!key) { out.push(line); continue }
    if (done.has(key)) continue
    done.add(key)
    out.push(`${key}=${escapeCompose(values[key])}${line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''}`)
  }
  let res = out.join('')
  const missing = Object.keys(values).filter((k) => !done.has(k))
  if (missing.length && res !== '' && !res.endsWith('\n')) res += eol
  for (const k of missing) res += `${k}=${escapeCompose(values[k])}${eol}`
  return bom + res
}

// Value as compose would see it: BOM ignored, matching surrounding quotes removed, `$$` -> `$`.
export function getEnvValue(input, key) {
  const text = input.startsWith(BOM) ? input.slice(1) : input
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`))
  if (line === undefined) return ''
  let v = line.slice(key.length + 1)
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1)
  return unescapeCompose(v)
}

export function validatePassword(pw) {
  if (Array.from(pw).length < MIN_PASSWORD) return `the password must be at least ${MIN_PASSWORD} characters`
  if (Buffer.byteLength(pw, 'utf8') > MAX_PASSWORD_BYTES) return `the password must be at most ${MAX_PASSWORD_BYTES} bytes in UTF-8 (bcrypt would silently ignore the rest)`
  return null
}

// Private from the first byte (existing file's mode kept, new file 0600); the temp file never
// outlives a failed write or rename.
export function writeEnvFile(file, content) {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600
  const tmp = `${file}.${process.pid}.tmp`
  let renamed = false
  try {
    writeFileSync(tmp, content, { mode, flag: 'wx' })
    chmodSync(tmp, mode) // umask may have cleared bits of the existing mode
    renameSync(tmp, file)
    renamed = true
  } finally {
    if (!renamed) { try { unlinkSync(tmp) } catch { /* not created */ } }
  }
}

// Pure key handling for the terminal reader. state: { buf, done, aborted }.
// shortcut: an escape sequence split across two chunks leaks its tail; terminals send one per chunk.
export function processKeys(state, chunk) {
  let { buf } = state
  const cs = Array.from(chunk)
  for (let i = 0; i < cs.length; i++) {
    const ch = cs[i]
    if (ch === '\r' || ch === '\n') return { buf, done: true, aborted: false } // rest of a pasted chunk is deliberately ignored
    if (ch === '\u0003') return { buf, done: true, aborted: true }
    if (ch === '\u001b') { // swallow CSI (ESC [ ... final 0x40-0x7E), SS3 (ESC O x) or a lone ESC
      if (cs[i + 1] === '[') {
        i += 2
        while (i < cs.length && !(cs[i] >= '@' && cs[i] <= '~')) i++
      } else if (cs[i + 1] === 'O') i += 2
      continue
    }
    if (ch === '\u007f' || ch === '\b') { buf = Array.from(buf).slice(0, -1).join(''); continue } // one code point
    if (ch < ' ') continue
    buf += ch
  }
  return { buf, done: false, aborted: false }
}

function readLine(prompt, { echo }) {
  return new Promise((res, rej) => {
    const { stdin, stdout } = process
    let state = { buf: '', done: false, aborted: false }
    stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const finish = (fn, v) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); fn(v) }
    const onData = (chunk) => {
      state = processKeys(state, chunk)
      if (state.aborted) return finish(rej, new Error('aborted'))
      if (state.done) return finish(res, state.buf)
      if (echo) stdout.write(`\r\x1b[K${prompt}${state.buf}`)
    }
    stdin.on('data', onData)
  })
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('set-panel-password: stdin is not a terminal. Run it in a real terminal; the password is never read from pipes, argv or env.')
    process.exit(2)
  }
  const args = process.argv.slice(2)
  const i = args.indexOf('--env')
  if (i >= 0 && !args[i + 1]) { console.error('usage: set-panel-password.mjs [--env <path>]'); process.exit(2) }
  const file = resolve(i >= 0 ? args[i + 1] : '.env')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const current = getEnvValue(text, 'PANEL_ADMIN_EMAIL')

  const email = (await readLine(`Admin email${current ? ` [${current}]` : ''}: `, { echo: true })).trim() || current
  if (!/^\S+@\S+$/.test(email)) { console.error('set-panel-password: a valid email is required'); process.exit(1) }
  const pw = await readLine('New password: ', { echo: false })
  const bad = validatePassword(pw)
  if (bad) { console.error(`set-panel-password: ${bad}`); process.exit(1) }
  if (pw !== (await readLine('Repeat password: ', { echo: false }))) { console.error('set-panel-password: the passwords do not match'); process.exit(1) }

  const bcrypt = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../core/package.json'))('bcryptjs')
  const hash = await bcrypt.hash(pw, 12)
  try {
    writeEnvFile(file, setEnvValues(text, { PANEL_ADMIN_EMAIL: email, PANEL_ADMIN_PASSWORD_HASH: hash }))
  } catch (e) {
    console.error(`set-panel-password: could not update ${file} (${e.code ?? e.message}); the file was left unchanged`)
    process.exit(1)
  }
  console.log(`updated ${file}\nrestart core to apply: docker compose up -d core`)
}

// Main guard on real paths (symlinks), case-insensitive on Windows.
const norm = (p) => { try { const r = realpathSync(p); return process.platform === 'win32' ? r.toLowerCase() : r } catch { return '' } }
if (process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(`set-panel-password: ${e.message}`); process.exit(1) })
}
