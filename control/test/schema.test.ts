import { describe, expect, test } from 'vitest'
import { randomInt } from 'node:crypto'
import { config } from '../src/config.ts'
import { migrate, pool } from '../src/db.ts'
import { newRef } from '../src/ids.ts'

// Spec section 9, table by table
const SPEC: Record<string, string[]> = {
  organizations: ['id', 'slug', 'name'],
  memberships: ['org_id', 'user_id', 'role', 'project_id'],
  invitations: ['org_id', 'email', 'role', 'token_hash', 'expires_at'],
  access_tokens: ['user_id', 'name', 'token_hash', 'last_used_at', 'expires_at'],
  nodes: ['name', 'docker_endpoint', 'advertise_addr', 'proxy_mode', 'proxy_network', 'memory_budget_mb'],
  projects: ['ref', 'org_id', 'name', 'status', 'size', 'node_id', 'template_version', 'subnet', 'parent_project_id',
    'branch_name', 'git_branch', 'persistent', 'ha_enabled', 'pitr_enabled', 'db_port', 'pooler_port', 'disk_limit_mb',
    'paused_at', 'last_activity_at'],
  project_domains: ['project_id', 'hostname', 'kind'],
  host_slots: ['hostname', 'pool', 'project_id', 'first_issued_at'],
  project_secrets: ['project_id', 'name', 'kind', 'ciphertext', 'nonce', 'key_version'],
  project_config: ['project_id', 'section', 'data', 'version', 'updated_by'],
  api_keys: ['project_id', 'type', 'name', 'prefix', 'hash', 'revoked_at'],
  functions: ['project_id', 'slug', 'version', 'verify_jwt', 'entrypoint', 'import_map', 'sha256', 'status'],
  backups: ['project_id', 'kind', 'status', 'started_at', 'finished_at', 'size_bytes', 'location', 'lsn'],
  jobs: ['type', 'project_id', 'status', 'step', 'payload', 'error', 'attempts', 'created_by', 'lane'],
  job_events: ['job_id'],
  snippets: ['project_id', 'owner_id', 'name', 'sql', 'visibility'],
  audit_log: ['actor', 'org_id', 'project_id', 'action', 'target', 'ip', 'at', 'details'],
  settings: ['key', 'value'],
}

const subnet = () => `10.207.${randomInt(256)}.${randomInt(8) * 32}/27`
const org = async () =>
  (await pool.query(`insert into control.organizations (slug, name) values ($1, 'o') returning id`, [`o-${newRef()}`])).rows[0].id
const insertProject = async (ref: string, orgId: string, sn = subnet()) =>
  pool.query(`insert into control.projects (ref, org_id, name, status, size, subnet) values ($1, $2, 'p', 'COMING_UP', 'micro', $3)`, [ref, orgId, sn])

describe('control schema', () => {
  test('every table and column of spec section 9 exists', async () => {
    const rows = (await pool.query(`select table_name, column_name from information_schema.columns where table_schema = 'control'`)).rows
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`))
    const missing = Object.entries(SPEC).flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`)).filter((k) => !have.has(k))
    expect(missing).toEqual([])
  })

  test('core platform schema (auth) is in control-db too', async () => {
    expect((await pool.query(`select to_regclass('auth.users') is not null as e`)).rows[0].e).toBe(true)
  })

  test('a project ref that is not 20 lowercase letters is refused', async () => {
    const o = await org()
    await expect(insertProject('Abc', o)).rejects.toThrow(/check/)
    await expect(insertProject('abcdefghijklmnopqrsT', o)).rejects.toThrow(/check/)
  })

  test('two projects with one subnet are refused', async () => {
    const o = await org()
    const sn = subnet()
    await insertProject(newRef(), o, sn)
    await expect(insertProject(newRef(), o, sn)).rejects.toThrow(/unique|duplicate/)
  })

  test('job status and lane are checked', async () => {
    await expect(pool.query(`insert into control.jobs (type, status, lane) values ('x', 'done', 'light')`)).rejects.toThrow(/check/)
    await expect(pool.query(`insert into control.jobs (type, status, lane) values ('x', 'pending', 'medium')`)).rejects.toThrow(/check/)
    await pool.query(`insert into control.jobs (type, status, lane) values ('x', 'pending', 'heavy')`)
  })

  test('a membership without a project is unique per org and user', async () => {
    const o = await org()
    const user = (await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`${newRef()}@example.test`])).rows[0].id
    await pool.query(`insert into control.memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [o, user])
    await expect(pool.query(`insert into control.memberships (org_id, user_id, role) values ($1, $2, 'developer')`, [o, user])).rejects.toThrow(/unique|duplicate/)
    await expect(pool.query(`insert into control.memberships (org_id, user_id, role) values ($1, $2, 'boss')`, [await org(), user])).rejects.toThrow(/check/)
  })

  test('the node row is seeded from config', async () => {
    const rows = (await pool.query(`select name, memory_budget_mb from control.nodes`)).rows
    expect(rows).toEqual([{ name: config.nodeName, memory_budget_mb: config.memoryBudgetMb }])
    const v = (await pool.query(`select value from control.settings where key = 'current_template_version'`)).rows
    expect(v).toEqual([{ value: config.templateVersion }])
  })

  test('every start makes the running release current; existing projects keep theirs until an upgrade', async () => {
    await pool.query(`update control.settings set value = 'old-release' where key = 'current_template_version'`)
    await migrate()
    expect((await pool.query(`select value from control.settings where key = 'current_template_version'`)).rows)
      .toEqual([{ value: config.templateVersion }])
  })

  test('the first start records when the control host first reached the resolver; later starts keep it', async () => {
    await pool.query(`delete from control.settings where key = 'control_host_first_issued_at'`)
    await migrate()
    const at = (await pool.query(`select value::timestamptz as at from control.settings where key = 'control_host_first_issued_at'`)).rows[0].at
    expect(Date.now() - at.getTime()).toBeLessThan(60_000)
    await pool.query(`update control.settings set value = '2026-01-01T00:00:00Z' where key = 'control_host_first_issued_at'`)
    await migrate()
    expect((await pool.query(`select value from control.settings where key = 'control_host_first_issued_at'`)).rows[0].value).toBe('2026-01-01T00:00:00Z')
  })

  test('migrations run twice without error', async () => {
    await migrate()
    await migrate()
    expect((await pool.query(`select count(*)::int as n from control.nodes`)).rows[0].n).toBe(1)
    expect((await pool.query(`select version from control.migrations order by version`)).rows).toEqual([{ version: '0001' }, { version: '0002' }, { version: '0003' }, { version: '0004' }, { version: '0005' }])
  })

  test('0002 and later are safe to run again by hand', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    for (const f of readdirSync(config.controlMigrationsDir).filter((f) => f.endsWith('.sql') && f > '0002'))
      await pool.query(readFileSync(`${config.controlMigrationsDir}/${f}`, 'utf8'))
  })
})
