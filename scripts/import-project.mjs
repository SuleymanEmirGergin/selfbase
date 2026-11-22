#!/usr/bin/env node
// Imports a v1 install as a new project (spec section 10), over SSH or anywhere control is reachable:
//   SELFBASE_ACCESS_TOKEN=sbp_... node scripts/import-project.mjs --url https://selfbase.<BASE> --org <slug> \
//     --name <name> --size micro|small|medium --backup-dir <dir under the host backup directory> --env-file <v1 .env>
// Posts the env file to POST /platform/projects/import (control encrypts its secrets and does not keep the file), then
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
    opts = parseArgs({ options: Object.fromEntries(['url', 'org', 'name', 'size', 'backup-dir', 'env-file'].map((k) => [k, { type: 'string' }])) }).values
  } catch (e) {
    die(e.message)
  }
  for (const k of ['url', 'org', 'name', 'size', 'backup-dir', 'env-file']) if (!opts[k]) die(`--${k} is required`)
  const token = process.env.SELFBASE_ACCESS_TOKEN
  if (!token) die('set SELFBASE_ACCESS_TOKEN to a personal access token (sbp_...)')
  const url = URL.parse(opts.url)
  if (!url || !['https:', 'http:'].includes(url.protocol)) die('--url must be an http(s) URL')
  // the env file holds the project's keys: plain http only to this machine
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) die('--url must use https (http only for localhost)')
  const base = url.href.replace(/\/+$/, '')
  const headers = { authorization: `Bearer ${token}` }

  let env
  try {
    env = readFileSync(opts['env-file'])
  } catch (e) {
    die(`cannot read the env file (${e.code ?? e.name})`)
  }
  const form = new FormData()
  form.set('organization_slug', opts.org)
  form.set('name', opts.name)
  form.set('size', opts.size)
  form.set('backup_dir', opts['backup-dir'])
  form.set('env_file', new Blob([env]), basename(opts['env-file']))

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
  for (;;) {
    const job = await call('GET', `/platform/jobs/${encodeURIComponent(started.job_id)}`)
    for (const e of job.events.slice(shown)) console.log(`  ${e.event}`)
    shown = job.events.length
    if (job.status === 'succeeded') return console.log(`import: done; project ${started.project.ref} is up`)
    if (job.status === 'failed') die(`the import job failed: ${job.error ?? 'no message'}`)
    await new Promise((r) => setTimeout(r, 2000))
  }
}
