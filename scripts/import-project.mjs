#!/usr/bin/env node
// Imports a v1 install as a new project (spec section 10), over SSH or anywhere control is reachable:
//   SELFBASE_ACCESS_TOKEN=sbp_... node scripts/import-project.mjs --url https://selfbase.<BASE> --org <slug> \
//     --name <name> --size micro|small|medium --backup-dir import/<org slug>/<name> --env-file <v1 .env>
//   ... --backup-dir export-<ref>/<ts> --passphrase -          (an export: its passphrase on stdin, or a file name)
//   ... --rotate-keys      a new JWT secret and keys, and the copy's sessions deleted (needed while the source is live here)
// --passphrase names where the passphrase is (a file, or - for stdin), never the passphrase itself: argv is visible to
// every user of the machine. Give exactly one of --env-file and --passphrase.
// --backup-dir is relative to the host backup directory: a v1 or foreign dump goes in the drop area
// import/<org slug>/<name> (a v1 backup directory moved there whole); <ref>/<ts> and export-<ref>/<ts> name backups
// of the organization's own projects. Control refuses anything else.
// Posts the env file or passphrase to POST /platform/projects/import (control encrypts the secrets, keeps neither), then
// follows the import job until it ends. Prints the project ref, the job's steps and the names of the env file's keys
// that were ignored or not recognised; never a value from the env file or the token. Exit 0 when the import succeeded.
// Node's standard library only, so it also runs inside the control image.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'

class Stop extends Error {}
// throws instead of process.exit: exiting with a fetch's socket still open crashes Node on Windows
const die = (msg) => {
  throw new Stop(msg)
}
try {
  await main()
} catch (e) {
  if (!(e instanceof Stop)) throw e
  console.error(`import: ${e.message}`)
  process.exitCode = 1
}

async function main() {
  let opts
  try {
    opts = parseArgs({ options: { ...Object.fromEntries(['url', 'org', 'name', 'size', 'backup-dir', 'env-file', 'passphrase']
      .map((k) => [k, { type: 'string' }])), 'rotate-keys': { type: 'boolean' } } }).values
  } catch (e) {
    die(e.message)
  }
  for (const k of ['url', 'org', 'name', 'size', 'backup-dir']) if (!opts[k]) die(`--${k} is required`)
  if (!opts['env-file'] === !opts.passphrase) die('give exactly one of --env-file (a v1 backup) and --passphrase (an export)')
  const token = process.env.SELFBASE_ACCESS_TOKEN
  if (!token) die('set SELFBASE_ACCESS_TOKEN to a personal access token (sbp_...)')
  const url = URL.parse(opts.url)
  if (!url || !['https:', 'http:'].includes(url.protocol)) die('--url must be an http(s) URL')
  // the env file holds the project's keys: plain http only to this machine
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) die('--url must use https (http only for localhost)')
  const base = url.href.replace(/\/+$/, '')
  const headers = { authorization: `Bearer ${token}` }

  const form = new FormData()
  form.set('organization_slug', opts.org)
  form.set('name', opts.name)
  form.set('size', opts.size)
  form.set('backup_dir', opts['backup-dir'])
  if (opts['rotate-keys']) form.set('rotate_keys', 'true')
  // the error names the code only: a passphrase typed in place of a file name must not be printed back
  const read = (path, what) => {
    try {
      return readFileSync(path === '-' ? 0 : path)
    } catch (e) {
      die(`cannot read the ${what} (${e.code ?? e.name})`)
    }
  }
  if (opts['env-file']) form.set('env_file', new Blob([read(opts['env-file'], 'env file')]), basename(opts['env-file']))
  else {
    const passphrase = read(opts.passphrase, 'passphrase').toString('utf8').replace(/\r?\n$/, '')
    if (!passphrase) die('the passphrase is empty')
    form.set('passphrase', passphrase)
  }

  // control's answers carry codes, messages and key names only
  async function call(method, path, body) {
    let res
    try {
      res = await fetch(base + path, { method, headers, body, signal: AbortSignal.timeout(120_000) })
    } catch (e) {
      die(`${method} ${path} failed (${e.name})`)
    }
    const out = await res.json().catch(() => null)
    if (!res.ok) die(`${res.status} ${out?.error ?? ''}: ${out?.message ?? 'no message'}`)
    return out
  }

  const started = await call('POST', '/platform/projects/import', form)
  console.log(`project ${started.project.ref} (${started.project.name}), job ${started.job_id}`)
  if (started.ignored.length) console.log(`ignored keys: ${started.ignored.join(', ')}`)
  if (started.unknown.length) console.log(`unknown keys (not imported): ${started.unknown.join(', ')}`)

  let shown = 0
  // control gives a restore 6 h; past that the job is stuck, not slow
  const until = Date.now() + 7 * 3600_000
  for (;;) {
    if (Date.now() > until) die(`gave up after 7 h; the job goes on in control: GET /platform/jobs/${started.job_id}`)
    const job = await call('GET', `/platform/jobs/${encodeURIComponent(started.job_id)}`)
    for (const e of job.events.slice(shown)) console.log(`  ${e.event}`)
    shown = job.events.length
    if (job.status === 'succeeded') return console.log(`import: done; project ${started.project.ref} is up`)
    if (job.status === 'failed') die(`the import job failed: ${job.error ?? 'no message'}`)
    await new Promise((r) => setTimeout(r, 2000))
  }
}
