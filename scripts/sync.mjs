#!/usr/bin/env node
// Applies the app team's new migrations (<repo>/supabase/migrations/applied/*.sql) to the selfbase database.
//   node scripts/sync.mjs --repo <corteqsemir path> [--dry-run]          apply what is not applied yet
//   node scripts/sync.mjs --repo <path> --baseline [--dry-run]          once, right after the migration:
//        mark as applied every file the source's history (supabase_migrations.schema_migrations, copied by
//        02-restore) records; --baseline-all marks every file when that history is empty or matches none
//   node scripts/sync.mjs --repo <path> --mark-applied <file> [...]     record one file as applied without running it
//   node scripts/sync.mjs --repo <path> --from-empty [--dry-run]        first normal run on a database that really has
//        none of these migrations; without it a run over an empty selfbase.applied_migrations is refused
// After a run, every table in the supabase_realtime publication gets selfbase.enable_realtime (one
// without an id column is reported, not fatal).
// Identity of a migration is its file name, recorded in selfbase.applied_migrations (created here) with a
// sha256 of the file. Each file runs in ONE explicit transaction (its own BEGIN ... COMMIT wrapper, or
// one sync adds) together with its record and its version in supabase_migrations.schema_migrations, as
// postgres through psql in postgres:17.12 with the file on stdin; the first failure stops the run (exit 1).
// A file psql could run differently from how it is scanned here (meta-commands other than \echo,
// \qecho, \warn, \encoding and `\set ON_ERROR_STOP on`, psql variables), with transaction control
// beyond one wrapper, or with a statement that cannot run in a transaction, is refused before any of it runs.
// Independent of that scan, the session is read-only outside the one intended transaction, and a guard
// table and inflight row carrying a random per-run token must both still exist when the record is
// written, so a COMMIT or ROLLBACK the scan missed fails the run instead of being recorded.
// One sync at a time per database (advisory lock).
// Limits: sync runs migrations as a superuser and trusts them. Applying a file and recording it happen
// atomically for files whose transaction control the scanner can see. A file that hides transaction
// control from the scanner (setting names built at run time, quote-mode tricks) can break that, and then
// "(rolled back)" or "applied" may not describe the database exactly. Effects that are not transactional
// at all (NOTIFY, dblink or pg_background, COPY ... TO PROGRAM, lo_export, session settings) are never
// undone by a rollback.
// Env (or .env at the repo root): TARGET_DB_URL, a superuser URL reachable from a container (service name
// plus DOCKER_NETWORK, or host.docker.internal:<port>). Values are never printed.
import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv, REALTIME_FOLLOW, refuseSupabaseTarget, requireEnv } from './migrate/05-rewrite-urls.mjs'

const lib = fileURLToPath(new URL('./migrate/lib.sh', import.meta.url)).replace(/\\/g, '/')
export const LOCK_KEY = 7213013 // pg_advisory_lock key held for a whole sync run

const ID = /[A-Za-z0-9_$\u0080-￿]/
const lineOf = (s, i) => s.slice(0, i).split('\n').length

// Lexes a migration the way psql does: comments (nested /* */ like Postgres), string literals,
// quoted identifiers and dollar-quoted bodies are blanked with spaces (same length, newlines kept), so
// keywords and offsets can be read from the rest. A backslash outside those starts a psql meta-command
// that runs to the end of its line, where psql's own lexer applies (quotes, comment openers and $$ are
// plain text there): such lines are blanked too and returned in `metas`. An unterminated construct is
// an error (psql would read the rest of the file into it). `bare` is the file with only comments and
// meta-command lines blanked, for checks that must see names inside quotes.
export function lex(sql) {
  const out = sql.split('')
  const bare = sql.split('') // only comments and meta-command lines blanked; strings and quoted names kept
  const n = sql.length
  const metas = []
  const quoteEnd = (k, q, esc) => {
    while (k < n) {
      if (esc && sql[k] === '\\') k += 2
      else if (sql[k] === q) { if (sql[k + 1] !== q) return k + 1; k += 2 } else k++
    }
    return -1
  }
  for (let i = 0; i < n;) {
    const c = sql[i]
    let j = -1
    let what = ''
    if (c === '-' && sql[i + 1] === '-') { j = sql.indexOf('\n', i); if (j < 0) j = n }
    else if (c === '\\') {
      j = sql.indexOf('\n', i); if (j < 0) j = n
      metas.push({ at: i, line: sql.slice(i, j).replace(/\r$/, '') })
    } else if (c === '/' && sql[i + 1] === '*') {
      what = 'block comment'
      let depth = 1
      for (j = i + 2; j < n && depth;) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2 } else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2 } else j++
      }
      if (depth) j = -2
    } else if (c === "'") {
      what = 'string literal'
      j = quoteEnd(i + 1, "'", /[Ee]/.test(sql[i - 1] ?? '') && !ID.test(sql[i - 2] ?? ''))
      if (j < 0) j = -2
    } else if (c === '"') {
      what = 'quoted identifier'
      j = quoteEnd(i + 1, '"', false)
      if (j < 0) j = -2
    } else if (c === '$' && !ID.test(sql[i - 1] ?? '')) {
      const t = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 100))
      if (t) {
        what = `dollar-quoted body ${t[0]}`
        const e = sql.indexOf(t[0], i + t[0].length)
        j = e < 0 ? -2 : e + t[0].length
      }
    }
    if (j === -2) return { error: `has an unterminated ${what} starting at line ${lineOf(sql, i)}` }
    if (j < 0) { i++; continue }
    const quoted = /^(string|quoted|dollar)/.test(what)
    for (let k = i; k < j; k++) if (out[k] !== '\n') { out[k] = ' '; if (!quoted) bare[k] = ' ' }
    i = j
  }
  return { m: out.join(''), metas, bare: bare.join('') }
}

const NO_TX = /^(vacuum|create database|drop database|alter system|create tablespace|drop tablespace|(create|alter|drop) subscription|create (unique )?index concurrently|drop index concurrently|reindex\b.*\bconcurrently\b|alter table\b.*\bdetach partition\b.*\bconcurrently\b)/
const OTHER_TX = /^(rollback|abort|savepoint|release|prepare transaction|commit prepared)\b/
const PLAIN_BEGIN = /^(begin( transaction| work)?|start transaction)$/
// change how the server (and psql) lex quotes, so the scan would no longer match what runs
const SCS_ON = /^set\s+(session\s+|local\s+)?standard_conforming_strings\s*(to|=)\s*'?on'?\s*;?$/i
const UTF8_ENC = /^set\s+(session\s+|local\s+)?(client_encoding\s*(to|=)|names)\s*'?utf-?8'?\s*;?$/i

// Checks a migration runs in psql exactly as read here and as one transaction. Returns { error } or
// { commitAt, ownBegin, beginEnd }: the offset of its COMMIT (a BEGIN ... COMMIT wrapper, which 200 of
// the team's files have) or -1, whether its own BEGIN is the first statement (then it opens the
// transaction) and the offset just after that BEGIN's semicolon.
export function scan(sql) {
  const lexed = lex(sql)
  if (lexed.error) return lexed
  const { m, metas, bare } = lexed
  // Meta-commands: only output, \encoding UTF8 and \set ON_ERROR_STOP on. \if hides statements, \gset/\g
  // end one, \set feeds variables, \i \c \! \o \copy reach other files, databases or the shell.
  for (const { at, line } of metas) {
    const cmd = /^\\([A-Za-z]+|.?)/.exec(line)[1]
    if (m.slice(m.lastIndexOf('\n', at) + 1, at).trim()) return { error: `has the psql meta-command \\${cmd} after SQL on the same line` }
    if (line.includes('`')) return { error: `has a backtick (shell command) in \\${cmd}` }
    if (line.indexOf('\\', 1) >= 0) return { error: `has a second backslash in the line of \\${cmd}` }
    if (/:[A-Za-z_'"{\u0080-￿]/.test(line)) return { error: `uses a psql variable reference in \\${cmd}` }
    const ok = ['echo', 'qecho', 'warn'].includes(cmd) || /^\\encoding\s+(['"]?)utf8\1\s*$/i.test(line) ||
      /^\\set\s+on_error_stop\s+on\s*$/i.test(line)
    if (!ok) return { error: `contains the psql meta-command ${line.trim().slice(0, 60)}` }
  }
  // psql variables (:name, :'name', :"name", :{?name}); not :: casts, := or slices like a[1:2]
  for (let k = 0; k < m.length; k++) {
    if (m[k] !== ':' || m[k - 1] === ':' || m[k + 1] === ':') continue
    if (/[A-Za-z_{\u0080-￿]/.test(m[k + 1] ?? '') || (m[k + 1] === ' ' && /['"]/.test(sql[k + 1]))) {
      return { error: `uses the psql variable reference "${sql.slice(k, k + 20).split('\n')[0]}"` }
    }
  }
  if (/\bbegin\s+atomic\b/i.test(m)) return { error: 'contains BEGIN ATOMIC, which this scanner cannot split' }
  const stmts = []
  let start = 0
  let depth = 0 // psql ends a statement only at a semicolon outside parentheses
  for (let i = 0; i <= m.length; i++) {
    if (m[i] === '(') depth++
    else if (m[i] === ')') depth = Math.max(0, depth - 1)
    if (i < m.length && (m[i] !== ';' || depth)) continue
    const t = m.slice(start, i).trim().toLowerCase().replace(/\s+/g, ' ')
    const at = start + m.slice(start, i).search(/\S/)
    if (t) stmts.push({ t, at, end: i + 1 })
    start = i + 1
  }
  for (const s of stmts) {
    if (NO_TX.test(s.t)) return { error: `contains "${s.t.slice(0, 60)}", which cannot run inside a transaction` }
    if (OTHER_TX.test(s.t)) return { error: `contains ${s.t.split(' ')[0].toUpperCase()} (transaction control)` }
    if (/^show\b/.test(s.t)) continue
    const raw = sql.slice(s.at, s.end).trim()
    const k = bare.slice(s.at, s.end).toLowerCase() // names inside strings and quoted identifiers count here
    const quoteMode = `changes how quotes or text are read ("${s.t.slice(0, 60)}"); only standard_conforming_strings = on and UTF8 are allowed`
    const readOnly = `changes the transaction read-only mode ("${s.t.slice(0, 60)}"), which sync relies on`
    if (/\b(update|insert\s+into|delete\s+from|merge\s+into)\s+(only\s+)?("?pg_catalog"?\s*\.\s*)?"?pg_settings\b/.test(k)) {
      return { error: `writes to pg_settings ("${s.t.slice(0, 60)}"), which changes sync's session settings` }
    }
    const name = /\b(standard_conforming_strings|backslash_quote|client_encoding|default_transaction_read_only|transaction_read_only)\b/.exec(k)?.[1]
    if (name && /\bset_config"?\s*\(/.test(k)) return { error: `calls set_config('${name}', ...), which changes how sync's session reads the file` }
    if (name === 'backslash_quote' || (name === 'standard_conforming_strings' && !SCS_ON.test(raw)) ||
        (name === 'client_encoding' && !UTF8_ENC.test(raw)) || (/^set (session |local )?names\b/.test(s.t) && !UTF8_ENC.test(raw))) {
      return { error: quoteMode }
    }
    // sync runs the file read-only except inside its one transaction; nothing may switch that back
    if (/transaction_read_only$/.test(name ?? '') || /^set session characteristics\b/.test(s.t) || /^reset all\b/.test(s.t)) return { error: readOnly }
    if (/^set (session |local )?transaction\b/.test(s.t)) {
      return { error: /\bread (only|write)\b/.test(s.t) ? readOnly
        : `sets transaction options outside its BEGIN ("${s.t.slice(0, 60)}"); set the isolation level on the BEGIN statement` }
    }
  }
  const begins = stmts.filter((s) => /^(begin|start transaction)\b/.test(s.t))
  const commits = stmts.filter((s) => /^(commit|end)\b/.test(s.t))
  if (begins.length > 1 || commits.length > 1) return { error: 'contains more than one BEGIN or COMMIT' }
  const [begin] = begins
  const [commit] = commits
  if (commit && commit !== stmts.at(-1)) {
    const after = stmts[stmts.indexOf(commit) + 1].t.slice(0, 40)
    return { error: `has a statement after its COMMIT ("${after}"); move it inside the transaction, before the COMMIT` }
  }
  if (begin && commit && begin.at > commit.at) return { error: 'has COMMIT before BEGIN' }
  const ownBegin = begin === stmts[0] && begin !== undefined
  if (begin && !ownBegin && !PLAIN_BEGIN.test(begin.t)) {
    return { error: 'has a BEGIN with options that is not its first statement, so the options would not take effect' }
  }
  if (ownBegin && /\bread only\b/.test(begin.t)) return { error: 'has a READ ONLY BEGIN; a migration has to write' }
  return { commitAt: commit ? commit.at : -1, ownBegin, beginEnd: ownBegin ? begin.end : 0 }
}

const lit = (s) => `'${s.replace(/'/g, "''")}'`
const VERSION = /^(\d{14})_(.*)\.sql$/

// psql in postgres:17.12 via lib.sh's container_run: the script and data go on stdin, the URL is split
// into PG* variables inside the container (password in PGPASSWORD), both output streams are redacted.
const net = () => (process.env.DOCKER_NETWORK ? ['--network', process.env.DOCKER_NETWORK] : [])
const bashEnv = () => ({ ...process.env, MSYS_NO_PATHCONV: '1', PGOPTIONS: '-c client_min_messages=warning' })
function psql(input) {
  const r = spawnSync('bash', ['-c',
    '. "$0"; set -o pipefail; { container_run "$@" 2>&1 1>&3 3>&- | redact >&2; } 3>&1 | redact',
    lib, ...net(), '-e', 'TARGET_DB_URL', '-e', 'PGOPTIONS'],
  { input, encoding: 'utf8', maxBuffer: 1 << 28, env: bashEnv() })
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

// Holds a session advisory lock in its own psql (stdin kept open) for the whole run; it ends with this process.
async function takeLock() {
  const child = spawn('bash', ['-c', '. "$0"; { container_run "$@" 2>&1 1>&3 3>&- | redact >&2; } 3>&1',
    lib, ...net(), '-e', 'TARGET_DB_URL', '-e', 'PGOPTIONS'], { stdio: ['pipe', 'pipe', 'inherit'], env: bashEnv() })
  child.stdin.write(`set -e; pgenv TARGET_DB_URL; exec psql -X -At -v ON_ERROR_STOP=1 -f -\nselect pg_try_advisory_lock(${LOCK_KEY});\n`)
  const got = await new Promise((resolve) => {
    let b = ''
    child.stdout.on('data', (d) => { b += d; if (b.includes('\n')) resolve(b.trim()) })
    child.on('exit', () => resolve(b.trim()))
  })
  if (got !== 't') {
    console.error(got === 'f' ? 'sync: another sync is running against this database; run again when it has finished'
      : 'sync: cannot take the sync lock (is the database reachable?)')
    process.exit(1)
  }
  return child
}

// sync_inflight holds a row only inside a migration's transaction: one left after a failure means the
// migration committed outside that transaction (a COMMIT the scan did not see).
const CREATE = `create table if not exists selfbase.applied_migrations (
  name text primary key, applied_at timestamptz not null default now(), checksum text);
create table if not exists selfbase.sync_inflight (name text primary key, started_at timestamptz not null default now());
alter table selfbase.sync_inflight add column if not exists nonce text;`
const LIMITS = 'sync: see the limits in the header of scripts/sync.mjs'
const record = (f) => `insert into selfbase.applied_migrations (name, checksum) values (${lit(f.name)}, ${lit(f.sum)})
  on conflict (name) do nothing;\n${f.version ? `insert into supabase_migrations.schema_migrations (version, name)
  values (${lit(f.version)}, ${lit(f.label)}) on conflict (version) do nothing;\n` : ''}`

function markApplied(list) {
  const r = run('', `begin;\n${CREATE}\n${list.map(record).join('')}commit;\n`)
  if (r.status !== 0) { console.error(`sync: recording failed:\n${r.stderr.trim()}`); process.exit(1) }
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (f) => args.includes(f)
  const values = (f) => args.flatMap((a, i) => (a === f ? [args[i + 1]] : []))
  const [repo] = values('--repo')
  const toMark = values('--mark-applied')
  if (!repo || repo.startsWith('--') || toMark.some((v) => !v || v.startsWith('--'))) {
    console.error('usage: sync.mjs --repo <app repo> [--baseline | --baseline-all | --from-empty | --mark-applied <file> ...] [--dry-run]')
    process.exit(2)
  }
  const dryRun = flag('--dry-run')
  const baselineAll = flag('--baseline-all')
  const baseline = baselineAll || flag('--baseline')
  const fromEmpty = flag('--from-empty')
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
  const files = names.map((name) => {
    const raw = readFileSync(join(dir, name), 'utf8')
    const v = VERSION.exec(name) // no 14-digit prefix: applied and recorded by name, not in schema_migrations
    return { name, version: v?.[1], label: v?.[2], text: raw.replace(/^﻿/, ''), sum: createHash('sha256').update(raw).digest('hex') }
  })
  const lock = dryRun ? null : await takeLock()

  const rows = query(`select to_regclass('selfbase.applied_migrations') is not null as has_am,
  to_regclass('supabase_migrations.schema_migrations') is not null as has_sm \\gset
\\if :has_am
select 'A', name, coalesce(checksum, '') from selfbase.applied_migrations;
\\endif
\\if :has_sm
select 'V', version, coalesce(name, '') from supabase_migrations.schema_migrations;
\\else
\\echo 'X'
\\endif
`)
  if (rows.some((r) => r[0] === 'X')) {
    console.error('sync: supabase_migrations.schema_migrations is missing (db/bootstrap/40-compat.sql creates it)')
    process.exit(2)
  }
  const applied = new Map(rows.filter((r) => r[0] === 'A').map((r) => [r[1], r[2]]))
  const history = new Map(rows.filter((r) => r[0] === 'V').map((r) => [r[1], r[2] ?? '']))
  for (const f of files) {
    const sum = applied.get(f.name)
    if (sum && sum !== f.sum) console.error(`sync: WARNING: ${f.name} changed after it was applied (checksum differs); not re-applied`)
  }
  const pending = files.filter((f) => !applied.has(f.name))
  const sameVersion = (f) => files.filter((g) => g.version && g.version === f.version)

  if (toMark.length) {
    const list = toMark.map((n) => files.find((f) => f.name === n) ?? (console.error(`sync: ${n} is not in ${dir}`), process.exit(2)))
    if (!dryRun) markApplied(list)
    console.log(`sync: ${dryRun ? 'would mark' : 'marked'} as applied without running: ${toMark.join(', ')}`)
    lock?.stdin.end()
    return
  }

  if (baseline) {
    let mark = []
    let left = []
    const manual = []
    const siblings = []
    for (const f of pending) {
      const same = sameVersion(f)
      const named = same.find((g) => g.label === history.get(f.version))
      if (!f.version || !history.has(f.version)) left.push(f)
      else if (same.length === 1) mark.push(f)
      // a shared version: the history row's name says which file ran; if it cannot tell, the operator decides
      else if (named === f) mark.push(f)
      else if (named) siblings.push([f, named])
      else manual.push(f)
    }
    if (!mark.length && !manual.length && !siblings.length && pending.length) {
      const why = history.size ? `supabase_migrations.schema_migrations has ${history.size} rows but none matches a file here`
        : 'supabase_migrations.schema_migrations is empty (the source history was not copied)'
      if (!baselineAll) {
        console.error(`sync: ${why}; refusing to guess. --baseline-all marks every file as applied.`)
        process.exit(2)
      }
      console.error(`sync: WARNING: ASSUMPTION: ${why}; marking all ${pending.length} files as applied without running them`)
      mark = pending
      left = []
    }
    if (!dryRun && mark.length) markApplied(mark)
    console.log(`sync: ${dryRun ? 'would mark' : 'marked'} ${mark.length} migrations as applied (baseline)`)
    if (left.length) {
      console.log(`sync: these ${left.length} migrations exist in the repo but were not applied on the source at dump time; ` +
        'the next normal run will apply them:')
      for (const f of left) console.log(`  ${f.name}`)
    }
    for (const [f, named] of siblings) {
      console.log(`sync: ${named.name} is recorded on the source; ${f.name} shares its version and is NOT in the source history — ` +
        'review it and either apply it by leaving it unmarked (it will be applied by the next normal run) or mark it with ' +
        `--mark-applied:\n  node scripts/sync.mjs --repo ${repo} --mark-applied ${f.name}`)
    }
    if (manual.length) {
      console.log(`sync: these ${manual.length} migrations need a manual decision: they share a version with another file and ` +
        'the source history cannot tell which ran. Mark each one that ran on the source; normal runs refuse until then:')
      for (const f of manual) console.log(`  ${f.name}  ->  node scripts/sync.mjs --repo ${repo} --mark-applied ${f.name}`)
    }
    lock?.stdin.end()
    return
  }

  if (!applied.size && history.size && pending.length) {
    console.error('sync: selfbase.applied_migrations is empty but the source history is not: run --baseline first')
    process.exit(2)
  }
  if (!applied.size && pending.length && !fromEmpty) {
    console.error('sync: selfbase.applied_migrations is empty, so no sync has recorded anything here yet. After a migration ' +
      'from Supabase run --baseline (or --baseline-all) first; only if this database really has none of these ' +
      'migrations, run again with --from-empty (nothing applied)')
    process.exit(2)
  }
  // Files sharing a version the source recorded, none marked yet and none named by the history: one of
  // them ran on the source, so applying any could repeat it.
  const unresolved = pending.filter((f) => history.has(f.version) && sameVersion(f).length > 1 &&
    sameVersion(f).every((g) => !applied.has(g.name) && g.label !== history.get(f.version)))
  if (unresolved.length) {
    console.error('sync: these files share a version the source recorded and the history cannot tell which ran; ' +
      'mark the one(s) that ran first (nothing applied):')
    for (const f of unresolved) console.error(`  ${f.name}  ->  node scripts/sync.mjs --repo ${repo} --mark-applied ${f.name}`)
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
  if (!pending.length) { console.log('sync: nothing to apply'); followRealtime(); lock.stdin.end(); return }

  let done = 0
  const stop = (msg) => {
    console.error(msg)
    reload(done)
    process.exit(1)
  }
  const created = run('', CREATE)
  if (created.status !== 0) stop(`sync: cannot create selfbase.applied_migrations:\n${created.stderr.trim()}`)
  for (const f of pending) {
    const s = scan(f.text)
    if (s.error) {
      stop(`sync: REFUSED ${f.name}: ${s.error}; nothing of it was applied (${done} applied before it). ` +
        'Fix the file, or apply it by hand and run --mark-applied.')
    }
    // One explicit transaction, so a cut stream rolls back: the file's own BEGIN when it comes first,
    // else one added on line 1; the record goes before the file's COMMIT, or a COMMIT is added.
    // Tripwire, independent of the scan: a guard created right after that BEGIN (on the same line, so
    // error line numbers stay the file's) is dropped by any COMMIT, and the record block reads it first.
    // The session is read-only by default and only the one intended transaction is read-write, so after
    // a COMMIT or ROLLBACK the scan missed, every later write fails instead of committing on its own.
    const t = f.text
    const b = s.ownBegin ? s.beginEnd : 0
    const c = s.commitAt < 0 ? t.length : s.commitAt
    // A random token per run names the guard and marks the inflight row, so a file cannot re-create either.
    const nonce = randomBytes(16).toString('hex')
    const guard = `create temp table _selfbase_sync_guard_${nonce} () on commit drop; ` +
      `insert into selfbase.sync_inflight (name, nonce) values (${lit(f.name)}, '${nonce}');`
    const rec = `\nreset role;\nselect from pg_temp._selfbase_sync_guard_${nonce};\ndo $sync_${nonce}$ declare n int; begin\n` +
      `delete from selfbase.sync_inflight where name = ${lit(f.name)} and nonce = '${nonce}'; get diagnostics n = row_count;\n` +
      `if n <> 1 then raise exception 'sync: its inflight row is gone (% rows)', n; end if; end $sync_${nonce}$;\n${record(f)}`
    const sql = `set default_transaction_read_only = on; ${s.ownBegin ? '' : 'begin read write; '}${t.slice(0, b)}` +
      `${s.ownBegin ? ' set transaction read write;' : ''} ${guard} ${t.slice(b, c)}` +
      (s.commitAt < 0 ? `\n;${rec}commit;\n` : `${rec}${t.slice(c)}`)
    const r = run('', sql)
    // "already in progress" is expected when sync's BEGIN wraps a later plain BEGIN of the file; "no
    // transaction in progress" can only come from a COMMIT the scan did not see.
    const out = r.stderr.split('\n').filter((l) => l && !/there is already a transaction in progress/.test(l))
      .map((l) => l.replace(/^psql:<stdin>:/, `${f.name}:`))
    const unseenCommit = out.some((l) => /there is no transaction in progress/.test(l))
    const guardGone = out.some((l) => /_selfbase_sync_guard_[0-9a-f]+" does not exist|its inflight row is gone/.test(l))
    if (r.status !== 0 || unseenCommit) {
      const tail = `(${done} applied before it):\n${out.join('\n')}\n${LIMITS}`
      const check = run("-At", `select name from selfbase.sync_inflight where name = ${lit(f.name)} and nonce = '${nonce}';
delete from selfbase.sync_inflight where name = ${lit(f.name)};`)
      if (check.status !== 0) {
        stop(`sync: FAILED ${f.name}: could not determine whether it committed or was recorded; inspect the database ` +
          `before running sync again (${done} applied before it):\n${out.join('\n')}\n${check.stderr.trim()}\n${LIMITS}`)
      }
      if (check.stdout.trim() || unseenCommit) {
        const msg = `sync: FAILED ${f.name}: it committed outside the expected transaction; it is NOT recorded; ` +
          `inspect the database before running sync again ${tail}`
        done++ // its changes are in the database, so PostgREST still has to reload
        stop(msg)
      }
      if (guardGone) {
        stop(`sync: FAILED ${f.name}: sync's guard was gone when the record was to be written (the file dropped it, ` +
          'ran DISCARD TEMP, or ended the transaction with a COMMIT or ROLLBACK the scan did not see); it is NOT recorded; ' +
          `the database state must be inspected before running sync again ${tail}`)
      }
      stop(`sync: FAILED ${f.name} (rolled back) ${tail}`)
    }
    done++
    console.log(`sync: applied ${f.name}`)
    for (const l of out) console.log(`  ${l}`)
  }
  reload(done)
  console.log(`sync: ${done} migrations applied`)
  followRealtime()
  lock.stdin.end()
}

// Realtime follows the publication: a migration's ALTER PUBLICATION supabase_realtime ADD TABLE is enough.
function followRealtime() {
  for (const [rel, what] of query(REALTIME_FOLLOW)) {
    if (what === 'enabled') console.log(`sync: realtime enabled for ${rel}`)
    else console.error(`sync: WARNING: ${rel} is in the supabase_realtime publication but has no id column; no realtime for it`)
  }
}

function reload(done) {
  if (!done) return
  if (run('', "notify pgrst, 'reload schema';").status !== 0) console.error('sync: WARNING: could not notify PostgREST; restart rest')
  else console.error('sync: PostgREST schema reload sent')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
