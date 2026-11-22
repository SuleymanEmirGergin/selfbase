#!/usr/bin/env node
// Rewrites https://<ref>.supabase.co to PUBLIC_URL in every text/varchar/json/jsonb column of the
// user schemas of the selfbase database.
//   node scripts/migrate/05-rewrite-urls.mjs --dry-run   affected rows per table.column, no writes
//   node scripts/migrate/05-rewrite-urls.mjs             applies (one transaction per column)
// Env (or .env at the repo root): SUPABASE_URL, PUBLIC_URL, TARGET_DB_URL (reachable from this host).
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Replaces https://<fromHost> (case-insensitive, whole host only) with toOrigin.
export function rewrite(text, fromHost, toOrigin) {
  const re = new RegExp(`https://${escapeRe(fromHost)}(?![A-Za-z0-9.-])`, 'gi')
  return text.replace(re, () => toOrigin)
}

// Same schemas 01-dump.sh dumps as "user" schemas.
export const PLATFORM_SCHEMAS = ['auth', 'storage', 'realtime', 'vault', 'net', 'graphql', 'graphql_public',
  'pgbouncer', 'extensions', 'supabase_functions', 'supabase_migrations', 'pgsodium', 'cron', '_realtime',
  '_analytics', 'selfbase', 'information_schema']

export function loadEnv() {
  const file = new URL('../../.env', import.meta.url)
  if (existsSync(file)) process.loadEnvFile(file)
}

export function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n])
  if (missing.length) {
    console.error(`missing env: ${missing.join(', ')}`)
    process.exit(2)
  }
  return names.map((n) => process.env[n])
}

// pg comes from core/node_modules (cd core && npm ci); no extra dependency for the scripts.
export async function connect(url) {
  let pg
  try {
    pg = createRequire(new URL('../../core/package.json', import.meta.url))('pg')
  } catch {
    console.error('pg not found: run `npm ci` in core/ first')
    process.exit(2)
  }
  const client = new pg.Client({ connectionString: url })
  try {
    await client.connect()
  } catch (e) {
    console.error(`cannot connect to TARGET_DB_URL: ${e.code || e.message.replace(/postgres(ql)?:\/\/\S+/g, '<db-url>')}`)
    process.exit(1)
  }
  return client
}

async function main() {
  loadEnv()
  const dryRun = process.argv.includes('--dry-run')
  const [supabaseUrl, publicUrl, dbUrl] = requireEnv('SUPABASE_URL', 'PUBLIC_URL', 'TARGET_DB_URL')
  const fromHost = new URL(supabaseUrl).host
  const toOrigin = new URL(publicUrl).origin
  if (!fromHost.endsWith('.supabase.co')) {
    console.error('SUPABASE_URL is not a *.supabase.co address')
    process.exit(2)
  }
  const needle = `https://${fromHost}`
  const db = await connect(dbUrl)
  const { rows: cols } = await db.query(
    `select n.nspname as schema, c.relname as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
        and a.atttypid in ('text'::regtype, 'varchar'::regtype, 'json'::regtype, 'jsonb'::regtype)
        and n.nspname <> all($1) and n.nspname not like 'pg\\_%'
      order by 1, 2, 3`,
    [PLATFORM_SCHEMAS],
  )
  let total = 0
  for (const col of cols) {
    const rel = `${db.escapeIdentifier(col.schema)}.${db.escapeIdentifier(col.table)}`
    const ident = db.escapeIdentifier(col.column)
    await db.query('begin')
    const { rows } = await db.query(
      `select ctid::text as ctid, ${ident}::text as v from ${rel} where strpos(lower(${ident}::text), lower($1)) > 0`,
      [needle],
    )
    let changed = 0
    for (const r of rows) {
      const next = rewrite(r.v, fromHost, toOrigin)
      if (next === r.v) continue
      changed++
      if (!dryRun) {
        await db.query(`update ${rel} set ${ident} = $1::${col.type} where ctid = $2::tid`, [next, r.ctid])
      }
    }
    await db.query('commit')
    if (changed) console.log(`${col.schema}.${col.table}.${col.column}: ${changed}`)
    total += changed
  }
  console.log(`${dryRun ? 'would rewrite' : 'rewrote'} ${total} values in ${cols.length} columns`)
  await db.end()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
