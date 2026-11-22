#!/usr/bin/env node
// Re-creates what lived outside the dumped schemas, from 01's catalog files:
//   - tables in the supabase_realtime publication -> selfbase.enable_realtime + the same publication
//   - cron.job rows -> cron.schedule (same name, schedule, command; inactive jobs stay inactive)
//   - vault secrets the migrations read (vault.decrypted_secrets where name = ...)
// Re-runnable. Env (or .env at the repo root): TARGET_DB_URL, SERVICE_ROLE_KEY.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, loadEnv, requireEnv } from './05-rewrite-urls.mjs'

// From `grep "vault.decrypted_secrets where name ="` over corteqsemir's migrations. Both are shared
// secrets the edge functions compare with NOTIFY_DISPATCH_SECRET / RADAR_NEWS_CRON_SECRET; the env var of
// that upper-cased name wins, SERVICE_ROLE_KEY otherwise (then set the function env to the same value).
const VAULT_NAMES = ['notification_dispatch_secret', 'radar_news_cron_secret']

loadEnv()
const [dbUrl, serviceKey] = requireEnv('TARGET_DB_URL', 'SERVICE_ROLE_KEY')
const dir = process.env.DUMP_DIR || fileURLToPath(new URL('../../dump', import.meta.url))
function catalog(name) {
  const file = join(dir, 'catalog', `${name}.json`)
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  console.error(`06: catalog/${name}.json missing (01 could not read it); skipped`)
  failed++
  return []
}

let failed = 0
const db = await connect(dbUrl)

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

for (const j of catalog('cron_jobs')) {
  try {
    let id
    if (j.jobname) {
      ;({ rows: [{ id }] } = await db.query('select cron.schedule($1, $2, $3) as id', [j.jobname, j.schedule, j.command]))
    } else {
      // unnamed jobs have no upsert key: match on schedule + command so a re-run adds nothing
      const { rows } = await db.query('select jobid from cron.job where jobname is null and schedule = $1 and command = $2',
        [j.schedule, j.command])
      id = rows[0]?.jobid ?? (await db.query('select cron.schedule($1, $2) as id', [j.schedule, j.command])).rows[0].id
    }
    await db.query('select cron.alter_job($1, active := $2)', [id, j.active !== false])
    console.log(`06: cron ${j.jobname || `#${j.jobid}`} ${j.schedule}${j.active === false ? ' (inactive)' : ''}`)
  } catch (e) {
    console.error(`06: cron ${j.jobname || `#${j.jobid}`}: ${e.message}`)
    failed++
  }
}

for (const name of VAULT_NAMES) {
  const value = process.env[name.toUpperCase()] || serviceKey
  const { rows } = await db.query('select id from vault.secrets where name = $1', [name])
  if (rows.length) await db.query('select vault.update_secret($1, $2)', [rows[0].id, value])
  else await db.query('select vault.create_secret($1, $2)', [value, name])
  console.log(`06: vault ${name} set`)
}

await db.end()
console.log(failed ? `06: done with ${failed} failures` : '06: done')
process.exit(failed ? 1 : 0)
