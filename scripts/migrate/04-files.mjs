#!/usr/bin/env node
// Downloads every object listed in dump/storage.objects.jsonl from Supabase Storage into
// STORAGE_DIR/<bucket>/<name> (the folder bound to core's storage volume, or docker cp it there).
// Existing files are skipped, so it can be re-run. Prints downloaded / skipped / failed counts;
// exits 1 if any failed. Env (or .env at the repo root): SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_DIR.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const envFile = new URL('../../.env', import.meta.url)
if (existsSync(envFile)) process.loadEnvFile(envFile)
const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'STORAGE_DIR'].filter((n) => !process.env[n])
if (missing.length) {
  console.error(`missing env: ${missing.join(', ')}`)
  process.exit(2)
}
const base = new URL(process.env.SUPABASE_URL).origin
const key = process.env.SUPABASE_SERVICE_KEY
const root = resolve(process.env.STORAGE_DIR)
const dumpDir = process.env.DUMP_DIR || fileURLToPath(new URL('../../dump', import.meta.url))

// Same rules as core's storage paths: no "..", leading "/", "\", empty segment or NUL; stays under root.
function target(bucket, name) {
  const parts = [bucket, ...String(name).split('/')]
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) return null
  const path = resolve(root, ...parts)
  return path.startsWith(root + sep) ? path : null
}

const file = join(dumpDir, 'storage.objects.jsonl')
if (!existsSync(file)) {
  console.error(`04: ${file} missing, run 01 first`)
  process.exit(1)
}
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
let downloaded = 0, skipped = 0, failed = 0
for (const { bucket_id: bucket, name } of rows) {
  const path = target(bucket, name)
  if (!path) {
    console.error(`04: unsafe object name skipped as failed: ${bucket}/${name}`)
    failed++
    continue
  }
  if (existsSync(path)) {
    skipped++
    continue
  }
  const url = `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${name.split('/').map(encodeURIComponent).join('/')}`
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, apikey: key } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.part`, Buffer.from(await res.arrayBuffer()))
    renameSync(`${path}.part`, path) // a half-written file never looks like a finished one on re-run
    downloaded++
  } catch (e) {
    console.error(`04: ${bucket}/${name}: ${e.message}`)
    failed++
  }
}
console.log(`04: downloaded ${downloaded}, skipped ${skipped}, failed ${failed}`)
process.exit(failed ? 1 : 0)
