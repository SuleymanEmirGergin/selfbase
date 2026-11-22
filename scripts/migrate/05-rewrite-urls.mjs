#!/usr/bin/env node
// Rewrites https://<ref>.supabase.co to PUBLIC_URL in every text, varchar, text[], varchar[], json and
// jsonb column (domains over them included) of the selfbase database, user schemas plus auth and
// storage (avatar URLs in auth.users meta data, identity_data, object metadata).
//   node scripts/migrate/05-rewrite-urls.mjs --dry-run   affected rows per table.column, no writes
//   node scripts/migrate/05-rewrite-urls.mjs             applies (one transaction per column, triggers off)
// Env (or .env at the repo root): SUPABASE_URL, PUBLIC_URL, TARGET_DB_URL_HOST or, when unset, TARGET_DB_URL
// (reachable from this host).
// Also holds the helpers the other Node scripts share (env reader, target guard, pg connection).
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Replaces https://<fromHost> (case-insensitive, whole host only) with toOrigin.
export function rewrite(text, fromHost, toOrigin) {
  const re = new RegExp(`https://${escapeRe(fromHost)}(?![A-Za-z0-9.-])`, 'gi')
  return text.replace(re, () => toOrigin)
}

// Not scanned: Supabase/selfbase platform schemas. cron is left out on purpose (job commands keep
// their *.supabase.co URLs; core's queue worker rewrites or blocks those hosts).
export const SKIPPED_SCHEMAS = ['realtime', 'vault', 'net', 'graphql', 'graphql_public', 'pgbouncer', 'extensions',
  'supabase_functions', 'supabase_migrations', 'pgsodium', 'cron', '_realtime', '_analytics', 'selfbase',
  'information_schema']

// Same rules as lib.sh's load_env: KEY=value per line, value literal to end of line, trailing \r
// dropped, # lines skipped; keys already in the environment win. A key set twice throws (readers would
// disagree on which one counts).
export function parseEnv(text, name = '.env') {
  const vars = {}
  const lineOf = {}
  text.split('\n').forEach((line, n) => {
    line = line.replace(/\r$/, '')
    if (/^\s*(#|$)/.test(line) || !line.includes('=')) return
    const i = line.indexOf('=')
    const key = line.slice(0, i).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return
    if (Object.hasOwn(vars, key)) throw new Error(`${name}: ${key} is set twice (lines ${lineOf[key]} and ${n + 1}); keep one`)
    vars[key] = line.slice(i + 1)
    lineOf[key] = n + 1
  })
  return vars
}

export function loadEnv() {
  const file = new URL('../../.env', import.meta.url)
  if (!existsSync(file)) return
  let vars
  try {
    vars = parseEnv(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) process.env[k] = v
  }
}

export function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n])
  if (missing.length) {
    console.error(`missing env: ${missing.join(', ')}`)
    process.exit(2)
  }
  return names.map((n) => process.env[n])
}

// Parses a URL from env var `name`; on failure says so without ever printing the value (it may hold a password).
export function parseUrl(name, value) {
  try {
    return new URL(value)
  } catch {
    console.error(`${name} is not a valid URL (percent-encode the password)`)
    process.exit(2)
  }
}

// Every table in the supabase_realtime publication without core's trigger: selfbase.enable_realtime for
// it ('enabled'), or 'no id column' when the trigger cannot work (the caller reports it, not fatal).
// Idempotent: a table that has the trigger is not listed. Used by sync.mjs and 06-realtime-cron.mjs.
export const REALTIME_FOLLOW = `with todo as (
  select c.oid, format('%I.%I', p.schemaname, p.tablename) as rel,
         exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'id' and not a.attisdropped) as has_id
    from pg_publication_tables p
    join pg_namespace n on n.nspname = p.schemaname
    join pg_class c on c.relnamespace = n.oid and c.relname = p.tablename
   where p.pubname = 'supabase_realtime'
     and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'selfbase_realtime'))
select rel, case when has_id then (select 'enabled' from selfbase.enable_realtime(oid)) else 'no id column' end as what
  from todo order by rel;`

// Trailing dots are stripped: abc.supabase.co. is the same host.
export const isSupabaseHost = (url) => /\.supabase\.(co|com)$/i.test(new URL(url).hostname.replace(/\.+$/, ''))

// Host-side scripts (05, 06) prefer TARGET_DB_URL_HOST (localhost:<published port>) over TARGET_DB_URL
// (container-reachable, db:5432). Returns the variable's NAME so errors can say which one without its value.
export const hostDbVar = (env = process.env) => (env.TARGET_DB_URL_HOST ? 'TARGET_DB_URL_HOST' : 'TARGET_DB_URL')

// The target must be selfbase, never the hosted project being migrated away from.
export function refuseSupabaseTarget(url, name = 'TARGET_DB_URL') {
  parseUrl(name, url)
  if (isSupabaseHost(url)) {
    console.error(`${name} points at a Supabase host; it must be the selfbase database`)
    process.exit(2)
  }
}

// pg comes from core/node_modules (cd core && npm ci); no extra dependency for the scripts.
export async function connect(url, name = 'TARGET_DB_URL') {
  refuseSupabaseTarget(url, name)
  let pg
  try {
    pg = createRequire(new URL('../../core/package.json', import.meta.url))('pg')
  } catch {
    console.error('pg not found: run `npm ci` in core/ first')
    process.exit(2)
  }
  let client
  try {
    client = new pg.Client({ connectionString: url })
    await client.connect()
  } catch (e) {
    console.error(`cannot connect to ${name}: ${e.code || e.message.replace(/postgres(ql)?:\/\/\S+/g, '<db-url>')}`)
    process.exit(1)
  }
  return client
}

async function main() {
  loadEnv()
  const dryRun = process.argv.includes('--dry-run')
  const dbVar = hostDbVar()
  const [supabaseUrl, publicUrl, dbUrl] = requireEnv('SUPABASE_URL', 'PUBLIC_URL', dbVar)
  const fromHost = parseUrl('SUPABASE_URL', supabaseUrl).host
  const toOrigin = parseUrl('PUBLIC_URL', publicUrl).origin
  if (!fromHost.endsWith('.supabase.co')) {
    console.error('SUPABASE_URL is not a *.supabase.co address')
    process.exit(2)
  }
  const needle = `https://${fromHost}`
  const db = await connect(dbUrl, dbVar)
  // base type: the domain's base for domains, else the column type itself
  const { rows: cols } = await db.query(
    `select n.nspname as schema, c.relname as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_type t on t.oid = a.atttypid
      where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
        and (case when t.typtype = 'd' then t.typbasetype else t.oid end) in
            ('text'::regtype, 'varchar'::regtype, 'json'::regtype, 'jsonb'::regtype, 'text[]'::regtype, 'varchar[]'::regtype)
        and n.nspname <> all($1) and n.nspname not like 'pg\\_%'
      order by 1, 2, 3`,
    [SKIPPED_SCHEMAS],
  )
  let total = 0
  for (const col of cols) {
    const rel = `${db.escapeIdentifier(col.schema)}.${db.escapeIdentifier(col.table)}`
    const ident = db.escapeIdentifier(col.column)
    let changed = 0
    try {
      await db.query('begin')
      // updated_at, audit and notification triggers must not fire for a URL rewrite
      await db.query('set local session_replication_role = replica')
      const { rows } = await db.query(
        `select ctid::text as ctid, ${ident}::text as v from ${rel} where strpos(lower(${ident}::text), lower($1)) > 0`,
        [needle],
      )
      for (const r of rows) {
        const next = rewrite(r.v, fromHost, toOrigin)
        if (next === r.v) continue
        changed++
        // untyped parameter: assignment semantics, so a value too long for varchar(n) fails, never truncates
        if (!dryRun) await db.query(`update ${rel} set ${ident} = $1 where ctid = $2::tid`, [next, r.ctid])
      }
      await db.query('commit')
    } catch (e) {
      await db.query('rollback').catch(() => {})
      console.error(`${col.schema}.${col.table}.${col.column} (${col.type}): ${e.message}; this column was rolled back`)
      process.exit(1)
    }
    if (changed) console.log(`${col.schema}.${col.table}.${col.column}: ${changed}`)
    total += changed
  }
  const schemas = [...new Set(cols.map((c) => c.schema))].join(', ')
  console.log(`${dryRun ? 'would rewrite' : 'rewrote'} ${total} values in ${cols.length} columns; schemas scanned: ${schemas}`)
  await db.end()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
