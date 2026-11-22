#!/usr/bin/env node
// Sets the admin panel login: writes PANEL_ADMIN_EMAIL and PANEL_ADMIN_PASSWORD_HASH (bcrypt, cost 12)
// into an env file. Usage: node scripts/set-panel-password.mjs [--env <path, default ./.env>]
// Interactive only: the password is read from the terminal without echo, never from argv or env,
// and neither it nor the hash is printed.
//
// Compose escaping: compose.yml passes ${PANEL_ADMIN_PASSWORD_HASH:-} to core, and docker compose
// interpolates `$` in .env values; a bcrypt hash ($2b$12$<salt>...) would be cut at `$<letter>`.
// So every `$` is stored as `$$` (verified with `docker compose config` / a probe container: core
// then receives the exact hash). Readers that take .env literally (scripts/migrate/lib.sh) do not
// use these two keys.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, readFileSync, writeFileSync, renameSync, statSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const MIN_PASSWORD = 12
export const escapeCompose = (v) => v.replaceAll('$', '$$$$')
export const unescapeCompose = (v) => v.replaceAll('$$', '$')

// Replaces the first `KEY=` line of each key (extra duplicates of it are dropped), appends missing
// keys; every other line stays byte-for-byte, the file's line-ending style is kept.
export function setEnvValues(text, values) {
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
  return res
}

export function getEnvValue(text, key) {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`))
  return line === undefined ? '' : unescapeCompose(line.slice(key.length + 1))
}

function readLine(prompt, { echo }) {
  return new Promise((res, rej) => {
    const { stdin, stdout } = process
    let buf = ''
    stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const finish = (fn, v) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); fn(v) }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(res, buf)
        if (ch === '\u0003') return finish(rej, new Error('aborted'))
        if (ch === '\u007f' || ch === '\b') { if (buf) { buf = buf.slice(0, -1); if (echo) stdout.write('\b \b') } continue }
        if (ch < ' ') continue
        buf += ch
        if (echo) stdout.write(ch)
      }
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
  const file = resolve(i >= 0 ? args[i + 1] ?? '' : '.env')
  if (i >= 0 && !args[i + 1]) { console.error('usage: set-panel-password.mjs [--env <path>]'); process.exit(2) }
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const current = getEnvValue(text, 'PANEL_ADMIN_EMAIL')

  let email = (await readLine(`Admin email${current ? ` [${current}]` : ''}: `, { echo: true })).trim() || current
  if (!/^\S+@\S+$/.test(email)) { console.error('set-panel-password: a valid email is required'); process.exit(1) }
  const pw = await readLine('New password: ', { echo: false })
  if (pw.length < MIN_PASSWORD) { console.error(`set-panel-password: the password must be at least ${MIN_PASSWORD} characters`); process.exit(1) }
  if (pw !== (await readLine('Repeat password: ', { echo: false }))) { console.error('set-panel-password: the passwords do not match'); process.exit(1) }

  const bcrypt = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../core/package.json'))('bcryptjs')
  const hash = await bcrypt.hash(pw, 12)
  const next = setEnvValues(text, { PANEL_ADMIN_EMAIL: email, PANEL_ADMIN_PASSWORD_HASH: hash })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, next)
  if (existsSync(file)) chmodSync(tmp, statSync(file).mode)
  renameSync(tmp, file)
  console.log(`updated ${file}\nrestart core to apply: docker compose up -d core`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`set-panel-password: ${e.message}`); process.exit(1) })
}
