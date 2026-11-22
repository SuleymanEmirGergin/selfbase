#!/usr/bin/env node
// Re-creates what lived outside the dumped schemas, from 01's catalog files:
//   - tables in the supabase_realtime publication -> selfbase.enable_realtime + the same publication; then
//     every table already in the publication without the trigger gets it too (no id column: reported)
//   - cron.job rows -> cron.schedule (same name, schedule, command). Registered INACTIVE unless
//     --activate is given, so the source and selfbase never both run the pipelines: run once without
//     the flag, and again with --activate at cutover (source jobs inactive keep inactive either way).
//   - vault secrets the migrations read (vault.decrypted_secrets where name = ...)
// Re-runnable. Env (or .env at the repo root): TARGET_DB_URL_HOST or, when unset, TARGET_DB_URL; SERVICE_ROLE_KEY.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, hostDbVar, loadEnv, REALTIME_FOLLOW, requireEnv } from './05-rewrite-urls.mjs'

// From `grep "vault.decrypted_secrets where name ="` over corteqsemir's migrations. Both are shared
// secrets the edge functions compare with their env var (value below); that env var wins here too,
// SERVICE_ROLE_KEY otherwise (then set the function env to the same value).
const VAULT_NAMES = { notification_dispatch_secret: 'NOTIFY_DISPATCH_SECRET', radar_news_cron_secret: 'RADAR_NEWS_CRON_SECRET' }

const activate = process.argv.includes('--activate')
loadEnv()
const dbVar = hostDbVar()
const [dbUrl, serviceKey] = requireEnv(dbVar, 'SERVICE_ROLE_KEY')
const dir = process.env.DUMP_DIR || fileURLToPath(new URL('../../dump', import.meta.url))
function catalog(name) {
  const file = join(dir, 'catalog', `${name}.json`)
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  console.error(`06: catalog/${name}.json missing (01 could not read it); skipped`)
  failed++
  return []
}

let failed = 0
const db = await connect(dbUrl, dbVar)

for (const t of catalog('realtime_tables')) {
  const rel = `${db.escapeIdentifier(t.schema)}.${db.escapeIdentifier(t.table)}`
  try {
    await db.query('select selfbase.enable_realtime($1::regclass)', [rel])
    await db.query(`do $$ begin
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                     and schemaname = ${db.escapeLiteral(t.schema)} and tablename = ${db.escapeLiteral(t.table)}) then
        alter publication supabase_realtime add table ${rel};
      end if; end $$`)
    console.log(`06: realtime ${t.schema}.${t.table}`)
  } catch (e) {
    console.error(`06: realtime ${t.schema}.${t.table}: ${e.message}`)
    failed++
  }
}

for (const { rel, what } of (await db.query(REALTIME_FOLLOW)).rows) {
  if (what === 'enabled') console.log(`06: realtime ${rel} (already in the publication)`)
  else console.warn(`06: WARNING: ${rel} is in the supabase_realtime publication but has no id column; no realtime for it`)
}

for (const j of catalog('cron_jobs')) {
  try {
    let id
    await db.query('begin') // scheduled and (de)activated together, so the job never runs in between
    if (j.jobname) {
      ;({ rows: [{ id }] } = await db.query('select cron.schedule($1, $2, $3) as id', [j.jobname, j.schedule, j.command]))
    } else {
      // unnamed jobs have no upsert key: match on schedule + command so a re-run adds nothing
      const { rows } = await db.query('select jobid from cron.job where jobname is null and schedule = $1 and command = $2',
        [j.schedule, j.command])
      id = rows[0]?.jobid ?? (await db.query('select cron.schedule($1, $2) as id', [j.schedule, j.command])).rows[0].id
    }
    const active = activate && j.active !== false
    await db.query('select cron.alter_job($1, active := $2)', [id, active])
    await db.query('commit')
    console.log(`06: cron ${j.jobname || `#${j.jobid}`} ${j.schedule} ${active ? 'ACTIVE' : 'inactive'}`)
  } catch (e) {
    await db.query('rollback').catch(() => {}) // a dead connection must not end the loop
    console.error(`06: cron ${j.jobname || `#${j.jobid}`}: ${e.message}`)
    failed++
  }
}

if (!activate) console.log('06: cron jobs registered inactive; re-run with --activate at cutover')

for (const [name, own] of Object.entries(VAULT_NAMES)) {
  const value = process.env[own] || serviceKey
  const { rows } = await db.query('select id from vault.secrets where name = $1', [name])
  if (rows.length) await db.query('select vault.update_secret($1, $2)', [rows[0].id, value])
  else await db.query('select vault.create_secret($1, $2)', [value, name])
  if (process.env[own]) console.log(`06: vault ${name} set from ${own}`)
  else console.warn(`06: WARNING: vault ${name} set from the SERVICE_ROLE_KEY FALLBACK (${own} not set); the function env ${own} must hold the same value`)
}

await db.end()
console.log(failed ? `06: done with ${failed} failures` : '06: done')
process.exit(failed ? 1 : 0)
