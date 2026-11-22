#!/usr/bin/env node
// Applies the app team's new migrations (<repo>/supabase/migrations/applied/*.sql) to the selfbase database.
//   node scripts/sync.mjs --repo <corteqsemir path> [--dry-run]           apply what is not applied yet
//   node scripts/sync.mjs --repo <path> --baseline [--dry-run]           once, right after the migration:
//        mark as applied every file whose version is in supabase_migrations.schema_migrations (the source's
//        history copied by 02-restore); --baseline-all marks every file when that history is empty
// Identity of a migration is its file name, recorded in selfbase.applied_migrations (created here) with a
// sha256 of the file. Each file runs in ONE transaction with its record (and its version in
// supabase_migrations.schema_migrations) as postgres through psql in postgres:17, the file on stdin;
// the first failure stops the run (exit 1). A file with transaction control beyond one BEGIN ... COMMIT
// wrapper, or a statement that cannot run in a transaction, is refused before anything of it runs.
// Env (or .env at the repo root): TARGET_DB_URL, a superuser URL reachable from a container (service name
// plus DOCKER_NETWORK, or host.docker.internal:<port>). Values are never printed.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv, refuseSupabaseTarget, requireEnv } from './migrate/05-rewrite-urls.mjs'

const lib = fileURLToPath(new URL('./migrate/lib.sh', import.meta.url)).replace(/\\/g, '/')

// Comments, string literals, quoted identifiers and dollar-quoted bodies blanked out (same length,
// newlines kept), so statement keywords and offsets can be read from what is left.
const LEXEMES = /--[^\n]*|\/\*[\s\S]*?\*\/|[Ee]'(?:\\[\s\S]|''|[^'\\])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g
export const mask = (sql) => sql.replace(LEXEMES, (s) => s.replace(/[^\n]/g, ' '))

const NO_TX = /^(vacuum|create database|drop database|alter system|create tablespace|drop tablespace|(create|alter|drop) subscription|create (unique )?index concurrently|drop index concurrently|reindex\b.*\bconcurrently\b|alter table\b.*\bdetach partition\b.*\bconcurrently\b)/
const SAFE_META = ['set', 'unset', 'echo', 'qecho', 'warn', 'if', 'elif', 'else', 'endif', 'gset', 'pset', 'timing', 'x', 'encoding']
const OTHER_TX =/^(rollback|abort|savepoint|release|prepare transaction|commit prepared)\b/

// Checks a migration can run as one transaction. Returns { error } or { commitAt }: the offset of a
// final COMMIT (a BEGIN ... COMMIT wrapper, which 200+ of the team's files have), or -1.
export function scan(sql) {
  let m = mask(sql)
  // Only meta-commands that stay inside this session; \i, \c, \!, \o, \copy ... could reach other files or databases.
  const meta = [...m.matchAll(/\\([A-Za-z]+|\S)/g)].map((x) => x[1]).find((c) => !SAFE_META.includes(c))
  if (meta) return { error: `contains the psql meta-command \\${meta}` }
  m = m.replace(/\\.*$/gm, (s) => ' '.repeat(s.length)) // a meta-command runs to the end of its line
  if (/\bbegin\s+atomic\b/i.test(m)) return { error: 'contains BEGIN ATOMIC, which this scanner cannot split' }
  const stmts = []
  let start = 0
  for (let i = 0; i <= m.length; i++) {
    if (i < m.length && m[i] !== ';') continue
    const t = m.slice(start, i).trim().toLowerCase().replace(/\s+/g, ' ')
    if (t) stmts.push({ t, at: start + m.slice(start, i).search(/\S/) })
    start = i + 1
  }
  for (const s of stmts) {
    if (NO_TX.test(s.t)) return { error: `contains "${s.t.slice(0, 60)}", which cannot run inside a transaction` }
    if (OTHER_TX.test(s.t)) return { error: `contains ${s.t.split(' ')[0].toUpperCase()} (transaction control)` }
  }
  const begins = stmts.filter((s) => /^(begin|start transaction)\b/.test(s.t))
  const commits = stmts.filter((s) => /^(commit|end)\b/.test(s.t))
  if (begins.length > 1 || commits.length > 1) return { error: 'contains more than one BEGIN or COMMIT' }
  // Read-only reports after the COMMIT are allowed (one team file prints a summary).
  // shortcut: if such a SELECT fails, the run reports FAILED although the migration and its record committed; check by hand
  if (commits.length && stmts.slice(stmts.indexOf(commits[0]) + 1).some((s) => !/^select\b/.test(s.t))) {
    return { error: 'has statements other than SELECT after its COMMIT' }
  }
  if (begins.length && commits.length && begins[0].at > commits[0].at) return { error: 'has COMMIT before BEGIN' }
  return { commitAt: commits.length ? commits[0].at : -1 }
}

const lit = (s) => `'${s.replace(/'/g, "''")}'`
const VERSION = /^(\d{14})_(.*)\.sql$/

// psql in postgres:17 via lib.sh's container_run: the script and data go on stdin, the URL is split
// into PG* variables inside the container (password in PGPASSWORD), both output streams are redacted.
function psql(input) {
  const net = process.env.DOCKER_NETWORK ? ['--network', process.env.DOCKER_NETWORK] : []
  const r = spawnSync('bash', ['-c',
    '. "$0"; set -o pipefail; { container_run "$@" 2>&1 1>&3 3>&- | redact >&2; } 3>&1 | redact',
    lib, ...net, '-e', 'TARGET_DB_URL', '-e', 'PGOPTIONS'],
  { input, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, MSYS_NO_PATHCONV: '1', PGOPTIONS: '-c client_min_messages=warning' } })
  if (r.error) throw r.error
  return r
}
const run = (flags, sql) => psql(`set -e; pgenv TARGET_DB_URL; exec psql -X -q -v ON_ERROR_STOP=1 ${flags} -f -\n${sql}`)

function query(sql) {
  const r = run("-At -F $'\\t'", sql)
  if (r.status !== 0) {
    console.error(`sync: database query failed:\n${r.stderr.trim()}`)
    process.exit(1)
  }
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'))
}

const CREATE = `create table if not exists selfbase.applied_migrations (
  name text primary key, applied_at timestamptz not null default now(), checksum text);`

function main() {
  const args = process.argv.slice(2)
  const flag = (f) => args.includes(f)
  const repo = args[args.indexOf('--repo') + 1]
  if (!flag('--repo') || !repo || repo.startsWith('--')) {
    console.error('usage: sync.mjs --repo <app repo> [--baseline | --baseline-all] [--dry-run]')
    process.exit(2)
  }
  const dryRun = flag('--dry-run')
  const baselineAll = flag('--baseline-all')
  const baseline = baselineAll || flag('--baseline')
  loadEnv()
  const [url] = requireEnv('TARGET_DB_URL')
  refuseSupabaseTarget(url)

  const dir = join(repo, 'supabase', 'migrations', 'applied')
  let names
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.sql') && lstatSync(join(dir, n)).isFile()).sort()
  } catch {
    console.error(`sync: ${dir} not found`)
    process.exit(2)
  }
  const files = []
  for (const name of names) {
    const v = VERSION.exec(name)
    if (!v) { console.error(`sync: WARNING: ${name} has no 14-digit version prefix; skipped`); continue }
    const text = readFileSync(join(dir, name), 'utf8')
    files.push({ name, version: v[1], label: v[2], text, sum: createHash('sha256').update(text).digest('hex') })
  }

  const rows = query(`select to_regclass('selfbase.applied_migrations') is not null as has_am,
  to_regclass('supabase_migrations.schema_migrations') is not null as has_sm \\gset
\\if :has_am
select 'A', name, coalesce(checksum, '') from selfbase.applied_migrations;
\\endif
\\if :has_sm
select 'V', version from supabase_migrations.schema_migrations;
\\else
\\echo 'X'
\\endif
`)
  if (rows.some((r) => r[0] === 'X')) {
    console.error('sync: supabase_migrations.schema_migrations is missing (db/bootstrap/40-compat.sql creates it)')
    process.exit(2)
  }
  const applied = new Map(rows.filter((r) => r[0] === 'A').map((r) => [r[1], r[2]]))
  const history = new Set(rows.filter((r) => r[0] === 'V').map((r) => r[1]))
  for (const f of files) {
    const sum = applied.get(f.name)
    if (sum && sum !== f.sum) console.error(`sync: WARNING: ${f.name} changed after it was applied (checksum differs); not re-applied`)
  }
  const pending = files.filter((f) => !applied.has(f.name))

  if (baseline) {
    let mark = pending.filter((f) => history.has(f.version))
    if (!history.size) {
      if (!baselineAll) {
        console.error('sync: supabase_migrations.schema_migrations is empty (the source history was not copied); ' +
          'refusing to guess. --baseline-all marks every file as applied.')
        process.exit(2)
      }
      console.error(`sync: WARNING: ASSUMPTION: no source history; marking all ${pending.length} files as applied without running them`)
      mark = pending
    }
    const left = pending.filter((f) => !mark.includes(f))
    if (!dryRun && mark.length) {
      const r = run('--single-transaction', `${CREATE}
insert into selfbase.applied_migrations (name, checksum) values
${mark.map((f) => `(${lit(f.name)}, ${lit(f.sum)})`).join(',\n')}
on conflict (name) do nothing;\n`)
      if (r.status !== 0) { console.error(`sync: baseline failed:\n${r.stderr.trim()}`); process.exit(1) }
    }
    console.log(`sync: ${dryRun ? 'would mark' : 'marked'} ${mark.length} migrations as applied (baseline)`)
    if (left.length) {
      console.log(`sync: these ${left.length} migrations exist in the repo but were not applied on the source at dump time; ` +
        'the next normal run will apply them:')
      for (const f of left) console.log(`  ${f.name}`)
    }
    return
  }

  if (!applied.size && history.size && pending.length) {
    console.error('sync: selfbase.applied_migrations is empty but the source history is not: run --baseline first')
    process.exit(2)
  }
  if (dryRun) {
    console.log(`sync: ${pending.length} migrations to apply`)
    for (const f of pending) {
      const s = scan(f.text)
      console.log(`  ${f.name}${s.error ? `  (REFUSED: ${s.error})` : ''}`)
    }
    return
  }
  if (!pending.length) { console.log('sync: nothing to apply'); return }

  let done = 0
  const created = run('', CREATE)
  if (created.status !== 0) { console.error(`sync: cannot create selfbase.applied_migrations:\n${created.stderr.trim()}`); process.exit(1) }
  for (const f of pending) {
    const s = scan(f.text)
    if (s.error) {
      console.error(`sync: REFUSED ${f.name}: ${s.error}; nothing of it was applied (${done} applied before it). ` +
        'Apply it by hand, then record it in selfbase.applied_migrations.')
      process.exit(1)
    }
    const record = `\nreset role;
insert into selfbase.applied_migrations (name, checksum) values (${lit(f.name)}, ${lit(f.sum)});
insert into supabase_migrations.schema_migrations (version, name) values (${lit(f.version)}, ${lit(f.label)})
  on conflict (version) do nothing;\n`
    // A BEGIN ... COMMIT wrapper gets the record before its COMMIT, so both stay in one transaction.
    const sql = s.commitAt < 0 ? `${f.text}\n;${record}` : `${f.text.slice(0, s.commitAt)}${record}${f.text.slice(s.commitAt)}`
    const r = run('--single-transaction', sql)
    const out = r.stderr.split('\n').filter((l) => l && !/transaction in progress/.test(l))
      .map((l) => l.replace(/^psql:<stdin>:/, `${f.name}:`))
    if (r.status !== 0) {
      console.error(`sync: FAILED ${f.name} (rolled back; ${done} applied before it):\n${out.join('\n')}`)
      process.exit(1)
    }
    done++
    console.log(`sync: applied ${f.name}`)
    for (const l of out) console.log(`  ${l}`)
  }
  if (run('', "notify pgrst, 'reload schema';").status !== 0) console.error('sync: WARNING: could not notify PostgREST; restart rest')
  console.log(`sync: ${done} migrations applied; PostgREST schema reload sent`)
  console.log('sync: new tables that need realtime: select selfbase.enable_realtime(\'<schema>.<table>\');')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
