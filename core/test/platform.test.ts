import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { applyMigrations, setRolePassword } from '../src/platform/migrate.ts'
import { PLATFORM_DIR, TEST_PASSWORD, testPool } from './global-setup.ts'

const LEDGER = 'selfbase.platform_migrations'
const opts = { dir: PLATFORM_DIR, ledger: LEDGER, lockKey: 7213014, adoptV1: true }
const versions = async (p: pg.Pool) => (await p.query(`select version from ${LEDGER} order by 1`)).rows.map((r) => r.version)
const exists = async (p: pg.Pool, rel: string) => (await p.query('select to_regclass($1) is not null as e', [rel])).rows[0].e

// A directory of migration files: copies of real ones plus extra { name: sql }
const dirs: string[] = []
function migrationDir(copy: string[], extra: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'sb-platform-'))
  dirs.push(d)
  for (const f of copy) copyFileSync(join(PLATFORM_DIR, f), join(d, f))
  for (const [f, sql] of Object.entries(extra)) writeFileSync(join(d, f), sql)
  return d
}

const main = testPool(process.env.TEST_DB_PORT ?? '54329')
afterAll(async () => {
  await main.end()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('platform migrations on the test database (migrated by global setup)', () => {
  it('a gap or a duplicate version throws and applies nothing new', async () => {
    const gap = migrationDir(['0001-bootstrap.sql'], { '0003-gap.sql': 'create table public.platform_gap_marker ()' })
    await expect(applyMigrations(main, { ...opts, dir: gap })).rejects.toThrow(/0003-gap\.sql.*gap/)
    const dup = migrationDir([], { '0001-a.sql': 'select 1', '0001-b.sql': 'select 1' })
    await expect(applyMigrations(main, { ...opts, dir: dup })).rejects.toThrow(/0001-b\.sql.*duplicate/)
    expect(await versions(main)).toEqual(['0001', '0002', '0003'])
    expect(await exists(main, 'public.platform_gap_marker')).toBe(false)
  })

  it('a ledger version with no file throws', async () => {
    const short = migrationDir(['0001-bootstrap.sql'])
    await expect(applyMigrations(main, { ...opts, dir: short })).rejects.toThrow(/0002.*no file/)
  })

  it('a broken migration leaves the ledger as it was and none of its objects', async () => {
    const broken = migrationDir(['0001-bootstrap.sql', '0002-guards-2026-11-22.sql', '0003-admin-audit-actor.sql'], {
      '0004-broken.sql': 'create table public.platform_broken_marker (id int);\nselect 1 / 0;\n',
    })
    const err = await applyMigrations(main, { ...opts, dir: broken }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/0004-broken\.sql/)
    expect((err as Error).message).not.toMatch(/platform_broken_marker/) // names the file, never the SQL
    expect(await versions(main)).toEqual(['0001', '0002', '0003'])
    expect(await exists(main, 'public.platform_broken_marker')).toBe(false)
  })

  it('a second run applies nothing', async () => {
    expect(await applyMigrations(main, opts)).toEqual([])
  })

  it('0002 run twice by hand succeeds and matches the v1 bootstrap', async () => {
    const sql = readFileSync(join(PLATFORM_DIR, '0002-guards-2026-11-22.sql'), 'utf8')
    await main.query(sql)
    await main.query(sql)
    const idx = await main.query(`select indexdef from pg_indexes where schemaname = 'selfbase' and indexname = 'http_queue_pending_idx'`)
    expect(idx.rows[0].indexdef).toMatch(/WHERE \(status = 'pending'::text\)/)
    const roles = await main.query(`select r.rolname, s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
      where r.rolname in ('anon', 'authenticated') order by 1`)
    expect(roles.rows).toEqual([
      { rolname: 'anon', setconfig: ['statement_timeout=3s'] },
      { rolname: 'authenticated', setconfig: ['statement_timeout=8s'] },
    ])
  })

  it('0003 run twice by hand succeeds and leaves admin_audit.actor', async () => {
    const sql = readFileSync(join(PLATFORM_DIR, '0003-admin-audit-actor.sql'), 'utf8')
    await main.query(sql)
    await main.query(sql)
    const col = await main.query(`select data_type from information_schema.columns
      where table_schema = 'selfbase' and table_name = 'admin_audit' and column_name = 'actor'`)
    expect(col.rows).toEqual([{ data_type: 'text' }])
  })

  it('setRolePassword changes the authenticator login', async () => {
    const login = async (password: string) => {
      const c = new pg.Client({ host: 'localhost', port: main.options.port, user: 'authenticator', password, database: 'postgres' })
      try {
        await c.connect()
        return (await c.query('select current_user as u')).rows[0].u
      } finally {
        await c.end().catch(() => {})
      }
    }
    try {
      await setRolePassword(main, 'authenticator', 'platform-test-new-password')
      expect(await login('platform-test-new-password')).toBe('authenticator')
      await expect(login(TEST_PASSWORD)).rejects.toThrow(/password authentication failed/)
    } finally {
      await setRolePassword(main, 'authenticator', TEST_PASSWORD) // PostgREST and core's user pool log in with it
    }
    await expect(setRolePassword(main, 'authenticator', '')).rejects.toThrow(/empty/)
  })
})

describe('platform migrations on an empty database', () => {
  const port = process.env.TEST_DB_EMPTY_PORT ?? '54332'
  let pool: pg.Pool | undefined
  // Back to a database as the image leaves it (10_postgis.sh ran, no roles); 0001 creates cluster-wide roles.
  async function reset() {
    await pool?.end()
    pool = undefined
    const admin = testPool(port, 'template1')
    try {
      await admin.query('drop database if exists postgres with (force)')
      await admin.query(`do $$ declare r record; begin
        for r in select rolname from pg_roles where rolname !~ '^pg_' and rolname <> 'postgres' loop
          execute format('drop role %I', r.rolname);
        end loop; end $$`)
      await admin.query('create database postgres template template_postgis')
    } finally {
      await admin.end()
    }
  }
  beforeAll(reset, 60_000)
  afterAll(() => pool?.end())

  it('applies every file, then nothing', async () => {
    pool = testPool(port)
    expect(await applyMigrations(pool, opts)).toEqual(['0001', '0002', '0003'])
    expect(await applyMigrations(pool, opts)).toEqual([])
    expect(await versions(pool)).toEqual(['0001', '0002', '0003'])
  }, 60_000)

  it('two concurrent runs apply each file once', async () => {
    await reset()
    pool = testPool(port)
    const [a, b] = await Promise.all([applyMigrations(pool, opts), applyMigrations(pool, opts)])
    expect([...a, ...b].sort()).toEqual(['0001', '0002', '0003'])
    expect(await versions(pool)).toEqual(['0001', '0002', '0003'])
  }, 60_000)
})

describe('platform migrations on a v1 database', () => {
  const v1 = testPool(process.env.TEST_DB_V1_PORT ?? '54333')
  afterAll(() => v1.end())

  it('stamps 0001 without running it and applies the rest', async () => {
    await v1.query(`drop table if exists ${LEDGER}`) // a rerun against the same stack starts from v1 again
    expect(await applyMigrations(v1, opts)).toEqual(['0002', '0003']) // running 0001 would fail on "create role anon"
    expect(await versions(v1)).toEqual(['0001', '0002', '0003'])
  }, 60_000)

  it('without adoptV1 a v1 database is not stamped', async () => {
    await v1.query(`drop table if exists ${LEDGER}`)
    await expect(applyMigrations(v1, { ...opts, adoptV1: false })).rejects.toThrow(/0001-bootstrap\.sql/)
    expect(await exists(v1, LEDGER)).toBe(false)
  }, 60_000)
})
