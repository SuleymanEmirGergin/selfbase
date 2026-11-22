// Needs the test stack: TEST_DB_PORT=.. TEST_REST_PORT=.. docker compose -p <name> -f compose.test.yml up -d
//   SYNC_TEST_PROJECT=<name> node --test scripts/test/sync.test.mjs          (default name sb-t13)
// The backup round trip additionally needs the full stack (compose.yml), see the "backup" suite below.
import { beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from '../sync.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const script = fileURLToPath(new URL('../sync.mjs', import.meta.url))
const P = process.env.SYNC_TEST_PROJECT ?? 'sb-t13'
const env = { ...process.env, TARGET_DB_URL: 'postgres://postgres:test-postgres-password@db:5432/postgres', DOCKER_NETWORK: `${P}_default` }

function sql(q) {
  const r = spawnSync('docker', ['compose', '-p', P, '-f', 'compose.test.yml', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1'],
    { cwd: root, input: q, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function repo(files) {
  const d = mkdtempSync(join(tmpdir(), 'sync-'))
  const dir = join(d, 'supabase', 'migrations', 'applied')
  mkdirSync(dir, { recursive: true })
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t)
  return d
}
const put = (d, n, t) => writeFileSync(join(d, 'supabase', 'migrations', 'applied', n), t)
const sync = (d, ...flags) => spawnSync(process.execPath, [script, '--repo', d, ...flags], { env, encoding: 'utf8' })
const applied = () => sql('select coalesce(string_agg(name, \',\' order by name), \'\') from selfbase.applied_migrations')

const M1 = '20260101000000_one.sql'
const M2 = '20260102000000_two.sql'
const M3 = '20260103000000_three.sql'
const ok1 = 'create table t13.a (id int);\ninsert into t13.a values (1);\n'
const bad2 = 'create table t13.b (id int);\nselect 1;\nselect * from t13.missing;\n'

describe('sync', () => {
  beforeEach(() => sql('drop table if exists selfbase.applied_migrations; truncate supabase_migrations.schema_migrations; ' +
    'drop schema if exists t13 cascade; create schema t13;'))

  test('second of two fails: first recorded, second not, exit 1; a re-run does not re-apply the first', () => {
    const d = repo({ [M1]: ok1, [M2]: bad2 })
    let r = sync(d)
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, new RegExp(`FAILED ${M2}`))
    assert.match(r.stderr, /relation "t13.missing" does not exist/)
    assert.match(r.stderr, new RegExp(`${M2}:3: ERROR`)) // file line of the failing statement
    assert.equal(applied(), M1)
    assert.equal(sql("select to_regclass('t13.b') is null"), 't') // the failed file left nothing
    assert.equal(sql("select version from supabase_migrations.schema_migrations"), '20260101000000')

    r = sync(d)
    assert.equal(r.status, 1)
    assert.equal(sql('select count(*) from t13.a'), '1')

    put(d, M2, 'create table t13.b (id int);\n')
    r = sync(d)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /applied 20260102000000_two\.sql/)
    assert.match(r.stdout, /1 migrations applied; PostgREST schema reload sent/)
    assert.match(r.stdout, /selfbase\.enable_realtime/)
    assert.equal(sql('select count(*) from t13.a'), '1')
    assert.equal(applied(), `${M1},${M2}`)
    assert.match(sync(d).stdout, /nothing to apply/)
  })

  test('a BEGIN ... COMMIT wrapper is applied with its record in the same transaction', () => {
    const d = repo({ [M1]: '-- header\nbegin;\ncreate table t13.w (id int);\ndo $$ begin perform 1; end $$;\ncommit;\n' })
    const r = sync(d)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(applied(), M1)
    assert.equal(sql("select to_regclass('t13.w') is not null"), 't')
  })

  test('a file with its own COMMIT in the middle is refused before any of it runs', () => {
    const d = repo({ [M1]: ok1, [M2]: 'create table t13.c (id int);\ncommit;\ncreate table t13.d (id int);\n' })
    const r = sync(d)
    assert.equal(r.status, 1)
    assert.match(r.stderr, new RegExp(`REFUSED ${M2}: has statements other than SELECT after its COMMIT`))
    assert.equal(applied(), M1)
    assert.equal(sql("select to_regclass('t13.c') is null"), 't')
    const dry = sync(d, '--dry-run')
    assert.match(dry.stdout, /REFUSED/)
  })

  test('--dry-run lists and changes nothing', () => {
    const d = repo({ [M1]: ok1, [M2]: 'create table t13.b (id int);\n' })
    const r = sync(d, '--dry-run')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /2 migrations to apply\n {2}20260101000000_one\.sql\n {2}20260102000000_two\.sql/)
    assert.equal(sql("select to_regclass('selfbase.applied_migrations') is null and to_regclass('t13.a') is null"), 't')
  })

  test('--baseline with a partial history lists the leftovers; the next run applies exactly those', () => {
    sql("insert into supabase_migrations.schema_migrations (version, name) values ('20260101000000', 'one'), ('20260102000000', 'two')")
    const d = repo({ [M1]: 'select 1/0;', [M2]: 'select 1/0;', [M3]: 'create table t13.c (id int);' })
    let r = sync(d)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /run --baseline first/)
    r = sync(d, '--baseline')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /marked 2 migrations as applied/)
    assert.match(r.stdout, new RegExp(`these 1 migrations exist in the repo but were not applied on the source at dump time; the next normal run will apply them:\n {2}${M3}`))
    assert.match(sync(d, '--dry-run').stdout, new RegExp(`1 migrations to apply\n {2}${M3}`))
    r = sync(d)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(applied(), `${M1},${M2},${M3}`)
    assert.match(sync(d, '--dry-run').stdout, /0 migrations to apply/)
  })

  test('--baseline refuses an empty history; --baseline-all marks everything; then 0 to apply', () => {
    const d = repo({ [M1]: ok1, [M2]: ok1 })
    let r = sync(d, '--baseline')
    assert.equal(r.status, 2)
    assert.match(r.stderr, /schema_migrations is empty/)
    r = sync(d, '--baseline-all')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /ASSUMPTION/)
    assert.match(sync(d, '--dry-run').stdout, /0 migrations to apply/)
    assert.equal(sql("select to_regclass('t13.a') is null"), 't')
  })

  test('an edited, already applied file gives a WARNING naming it', () => {
    const d = repo({ [M1]: ok1 })
    assert.equal(sync(d).status, 0)
    put(d, M1, `${ok1}-- edited\n`)
    const r = sync(d)
    assert.equal(r.status, 0)
    assert.match(r.stderr, new RegExp(`WARNING: ${M1} changed after it was applied`))
    assert.equal(sql('select count(*) from t13.a'), '1')
  })

  test('a Supabase target is refused and the URL is never printed', () => {
    const secret = 'Sup3rS3cret'
    const r = spawnSync(process.execPath, [script, '--repo', repo({ [M1]: ok1 })],
      { env: { ...env, TARGET_DB_URL: `postgres://postgres:${secret}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres` }, encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /Supabase host/)
    assert.ok(!(r.stdout + r.stderr).includes(secret))
  })
})

// Full stack: docker compose -p <name> --env-file <throwaway env> up -d --build, then
//   BACKUP_TEST_PROJECT=<name> BACKUP_TEST_ENV_FILE=<env file> node --test scripts/test/sync.test.mjs
const BP = process.env.BACKUP_TEST_PROJECT
describe('backup', { skip: !BP && 'set BACKUP_TEST_PROJECT to a running compose.yml stack' }, () => {
  const denv = { ...process.env, COMPOSE_PROJECT_NAME: BP, COMPOSE_ENV_FILES: process.env.BACKUP_TEST_ENV_FILE ?? '.env.test-local', MSYS_NO_PATHCONV: '1' }
  const dc = (...a) => spawnSync('docker', ['compose', ...a], { cwd: root, env: denv, encoding: 'utf8' })
  const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  const db = (q) => ok(dc('exec', '-T', 'db', 'psql', '-U', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', q))
  const core = (cmd) => dc('exec', '-T', 'core', 'sh', '-c', cmd)
  const inBackup = (cmd) => ok(dc('run', '--rm', '--no-deps', '-T', 'backup', 'bash', '-c', cmd))
  const backup = (...opts) => {
    const out = ok(dc('run', '--rm', '--no-deps', '-T', ...opts, 'backup', '/scripts/backup.sh'))
    return /wrote \/backups\/(\d{8}-\d{6})/.exec(out)[1]
  }
  const restore = (...a) => spawnSync('bash', ['scripts/restore.sh', ...a], { cwd: root, env: denv, encoding: 'utf8' })

  test('backup -> lose a row and a storage file -> restore -> both are back', () => {
    db('drop table if exists public.t13_keep; create table public.t13_keep (id int primary key, v text); ' +
      "insert into public.t13_keep values (1, 'a'), (2, 'b')")
    ok(core('mkdir -p /data/storage/t13 && echo hello > /data/storage/t13/f.txt'))
    const ts = backup()
    assert.match(inBackup(`cat /backups/${ts}/MANIFEST`), /^db\.dump \d+ [0-9a-f]{64}\nstorage\.tar\.gz \d+ [0-9a-f]{64}$/)
    db("delete from public.t13_keep where id = 2; update public.t13_keep set v = 'x'")
    ok(core('rm /data/storage/t13/f.txt && echo new > /data/storage/t13/new.txt'))

    let r = restore(ts)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /--yes-overwrite/)
    assert.equal(db("select string_agg(id || v, ',' order by id) from public.t13_keep"), '1x')

    r = restore(ts, '--yes-overwrite')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /start the services again: docker compose start rest core fn/)
    ok(dc('start', 'rest', 'core', 'fn'))
    assert.equal(db("select string_agg(id || v, ',' order by id) from public.t13_keep"), '1a,2b')
    assert.equal(ok(core('cat /data/storage/t13/f.txt')), 'hello')
    assert.notEqual(core('test -e /data/storage/t13/new.txt').status, 0)
  })

  test('a tampered dump or an unknown timestamp is refused, nothing is stopped', () => {
    const ts = backup()
    inBackup(`printf x >> /backups/${ts}/db.dump`)
    let r = restore(ts, '--yes-overwrite')
    assert.equal(r.status, 1)
    assert.match(r.stderr, new RegExp(`${ts}/db.dump does not match its MANIFEST`))
    assert.match(ok(dc('ps', '--status', 'running', '--services')), /core/)
    r = restore('20000101-000000', '--yes-overwrite')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /there is no backup 20000101-000000/)
  })

  test('retention deletes old backups but keeps the newest', () => {
    inBackup('mkdir -p /backups/20200101-000000 && touch /backups/20200101-000000/MANIFEST')
    const ts = backup()
    let list = inBackup('ls /backups')
    assert.doesNotMatch(list, /20200101-000000/)
    assert.match(list, new RegExp(ts))
    const ts2 = backup('-e', 'BACKUP_RETENTION_DAYS=0')
    list = inBackup('ls /backups').split('\n')
    assert.deepEqual(list, [ts2])
  })
})

test('scan: dollar bodies, comments and strings do not count as transaction control', () => {
  assert.deepEqual(scan("do $$ begin commit; end $$; -- commit;\nselect 'begin;';"), { commitAt: -1 })
  assert.equal(scan('begin;\nselect 1;\nend;\n').commitAt, 'begin;\nselect 1;\n'.length)
  assert.match(scan('create index concurrently i on t (a);').error, /cannot run inside a transaction/)
  assert.match(scan('begin; select 1; commit; begin; select 2; commit;').error, /more than one/)
  assert.match(scan('select 1; rollback;').error, /ROLLBACK/)
  assert.match(scan('\\i other.sql\n').error, /meta-command \\i/)
  assert.deepEqual(scan("\\set ON_ERROR_STOP on\nbegin;\nselect 1;\ncommit;\n\\echo 'x'\nselect 2;\n").error, undefined)
})
