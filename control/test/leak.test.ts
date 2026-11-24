// Review Focus 5: secret values never leak through failure paths. A create (with a failing ensure first), an export
// and an import whose restore job exits 10 run with stdout and stderr captured; then no secret, passphrase or env file
// value may occur in jobs, job_events, audit_log, an HTTP response of the run, or the captured output.
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { app } from '../src/app.ts'
import { config } from '../src/config.ts'
import { pool } from '../src/db.ts'
import { enqueue, startWorkers } from '../src/jobs/index.ts'
import { setProvisioner } from '../src/provisioner.ts'
import { getSecrets } from '../src/secrets.ts'
import { FakeProvisioner } from './fake-provisioner.ts'
import { join, org, resetDashboard, user, v1Env } from './helpers.ts'

const fake = new FakeProvisioner()
const PASS = 'leak test passphrase value'
const captured: string[] = []
const bodies: string[] = []
const cap = config.maxNewHostsPerWeek
const backupDir = config.backupDir
let token: string
let dir: string

const request = async (method: string, path: string, body?: unknown) => {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}` } }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
  }
  const res = await app.request(path, init)
  const text = await res.text()
  bodies.push(text)
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const finished = async (id: string) => {
  for (const end = Date.now() + 15_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const j = (await pool.query('select status from control.jobs where id = $1', [id])).rows[0]
    if (['succeeded', 'failed'].includes(j.status)) return j.status
  }
  throw new Error('timed out')
}

beforeAll(async () => {
  config.maxNewHostsPerWeek = 1000
  dir = mkdtempSync(joinPath(tmpdir(), 'sb-leak-'))
  config.backupDir = dir
  await resetDashboard()
  await pool.query('delete from control.jobs where project_id is null')
  setProvisioner(fake)
  const acme = await org('acme')
  const u = await user('leak@example.test')
  token = u.token
  await join(acme.id, u.id, 'owner')
  const keep = (orig: (...a: any[]) => any) => (...a: any[]) => { captured.push(a.map(String).join(' ')); return orig(...a) }
  vi.spyOn(process.stdout, 'write').mockImplementation(keep(process.stdout.write.bind(process.stdout)) as never)
  vi.spyOn(process.stderr, 'write').mockImplementation(keep(process.stderr.write.bind(process.stderr)) as never)
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(keep(() => {}) as never)
})
afterAll(() => {
  config.maxNewHostsPerWeek = cap
  config.backupDir = backupDir
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

test('no secret value reaches jobs, events, audit rows, responses or logs', { timeout: 60_000 }, async () => {
  const w = startWorkers({ db: pool, provisioner: fake, backoffMs: 1, idleMs: 20, probe: async () => 'ok',
    coreUrl: () => 'http://127.0.0.1:9', waits: { pollMs: 10, healthyMs: 2000, certificateMs: 300, warmMs: 50 } })
  try {
    // create, with one failing ensure on the way
    fake.fail('ensure', 1)
    const created = await request('POST', '/platform/projects', { organization_slug: 'acme', name: 'leak', size: 'micro' })
    expect(created.status).toBe(201)
    expect(await finished(created.json.job_id)).toBe('succeeded')
    const ref = created.json.project.ref
    await request('GET', `/platform/jobs/${created.json.job_id}`)
    await request('GET', `/platform/projects/${ref}`)

    // export
    fake.jobResult = () => ({ status: 'succeeded', exitCode: 0, tail: `backup: size 1 bytes\nbackup: wrote export-${ref}/20261122-031500` })
    const exp = await request('POST', `/platform/projects/${ref}/export`, { passphrase: PASS })
    expect(exp.status).toBe(202)
    expect(await finished(exp.json.job_id)).toBe('succeeded')
    await request('GET', `/platform/jobs/${exp.json.job_id}`)
    // what the backup job would have written: project.json from the sealed manifest (the payload forgot it)
    expect((await pool.query('select payload from control.jobs where id = $1', [exp.json.job_id])).rows[0].payload.manifest).toBeUndefined()
    const manifest = fake.callsOf('runJob').at(-1)!.args[3].MANIFEST_B64
    mkdirSync(joinPath(dir, `export-${ref}`, '20261122-031500'), { recursive: true })
    writeFileSync(joinPath(dir, `export-${ref}`, '20261122-031500', 'project.json'), Buffer.from(manifest, 'base64'))

    // a backup, and the control database's backup (its password goes to the provisioner call only)
    fake.jobResult = (r) => ({ status: 'succeeded', exitCode: 0, tail: `backup: size 1 bytes\nbackup: wrote ${r}/20261122-031600` })
    const bak = await request('POST', `/platform/projects/${ref}/backups`)
    expect(bak.status).toBe(202)
    expect(await finished(bak.json.job_id)).toBe('succeeded')
    const ctl = await enqueue(pool, { type: 'control.backup', payload: {}, createdBy: null })
    expect(await finished(ctl)).toBe('succeeded')
    await request('GET', `/platform/jobs/${bak.json.job_id}`)
    await request('GET', `/platform/projects/${ref}/backups`)
    // a refused export and a refused import carry no value either
    await request('POST', `/platform/projects/${ref}/export`, { passphrase: 'short' })
    const { text, vals } = v1Env()
    const refused = new FormData()
    for (const [k, v] of Object.entries({ organization_slug: 'acme', name: 'refused', size: 'micro', backup_dir: 'import/acme/x' })) refused.set(k, v)
    refused.set('env_file', new Blob([`${text}JWT_SECRET=${vals.JWT_SECRET}\n`]))
    expect((await request('POST', '/platform/projects/import', refused)).status).toBe(400)

    // import whose restore exits 10
    fake.jobResult = () => ({ status: 'failed', exitCode: 10, tail: 'restore: FAILED: the database restore rolled back' })
    const f = new FormData()
    for (const [k, v] of Object.entries({ organization_slug: 'acme', name: 'leak-import', size: 'micro', backup_dir: 'import/acme/corteqs-v1' })) f.set(k, v)
    f.set('env_file', new Blob([text]))
    const imp = await request('POST', '/platform/projects/import', f)
    expect(imp.status).toBe(202)
    expect(await finished(imp.json.job_id)).toBe('failed')
    await request('GET', `/platform/jobs/${imp.json.job_id}`)
    await request('GET', `/platform/projects/${imp.json.project.ref}`)

    // import of the export with its passphrase (a wrong one first), whose restore exits 10 as well
    const pf = (passphrase: string, rotate = 'true') => {
      const g = new FormData()
      for (const [k, v] of Object.entries({ organization_slug: 'acme', name: 'leak-export', size: 'micro',
        backup_dir: `export-${ref}/20261122-031500`, passphrase, rotate_keys: rotate })) g.set(k, v)
      return g
    }
    expect((await request('POST', '/platform/projects/import', pf('wrong leak passphrase'))).status).toBe(400)
    // the source project is live: its keys are refused (and named nowhere), new keys are not
    expect((await request('POST', '/platform/projects/import', pf(PASS, 'false'))).status).toBe(409)
    const pimp = await request('POST', '/platform/projects/import', pf(PASS))
    expect(pimp.status).toBe(202)
    expect(await finished(pimp.json.job_id)).toBe('failed')
    await request('GET', `/platform/jobs/${pimp.json.job_id}`)

    const refs = [ref, imp.json.project.ref, pimp.json.project.ref]
    const projects = (await pool.query('select id, ref from control.projects where ref = any($1)', [refs])).rows
    expect(projects).toHaveLength(3)
    const values = new Set<string>([PASS, config.dbPassword, ...Object.values(vals)])
    for (const p of projects) for (const v of Object.values(await getSecrets(pool, p))) values.add(v)
    expect(values.size).toBeGreaterThan(50)

    const rows = [
      ...(await pool.query('select payload::text as a, error as b from control.jobs')).rows,
      ...(await pool.query('select message as a, step as b from control.job_events')).rows,
      ...(await pool.query('select details::text as a, target as b from control.audit_log')).rows,
    ].map((r) => `${r.a} ${r.b}`)
    expect(rows.length).toBeGreaterThan(10)
    const haystacks = { rows: rows.join('\n'), bodies: bodies.join('\n'), output: captured.join('\n') }
    for (const [where, hay] of Object.entries(haystacks)) {
      for (const v of values) if (hay.includes(v)) throw new Error(`a secret value occurs in ${where}`)
    }
  } finally {
    await w.stop()
  }
})
