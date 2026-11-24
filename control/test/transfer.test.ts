import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { app } from '../src/app.ts'
import { config } from '../src/config.ts'
import { pool } from '../src/db.ts'
import { createProject, enqueue, startWorkers } from '../src/jobs/index.ts'
import { openManifest, sealManifest } from '../src/manifest.ts'
import { ProvisionerError, setProvisioner } from '../src/provisioner.ts'
import { reconcileOnce } from '../src/reconcile.ts'
import { enqueueDailyBackups, msUntilNext } from '../src/schedule.ts'
import { backfillFingerprints, fingerprint, getSecrets, putSecret } from '../src/secrets.ts'
import { forwardTarget } from '../src/forward.ts'
import { disk } from '../src/disk.ts'
import { buildEnv, loadProjectEnv, projectConfig, SECRET_ENV } from '../src/project-env.ts'
import { FakeProvisioner } from './fake-provisioner.ts'
import { join, org, project, resetDashboard, user, v1Env, withToken } from './helpers.ts'

const FOUR = ['core', 'rest', 'fn', 'pooler']
let fake: FakeProvisioner
let acme: { id: string; slug: string }
let owner: Awaited<ReturnType<typeof user>>
let dev: Awaited<ReturnType<typeof user>>
let cert: 'ok' | 'pending' = 'ok'
const running: { stop(): Promise<void> }[] = []
// core's API and admin listeners in one: records what the admin listener was sent
const adminSeen: { url: string; body: string }[] = []
const stub = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (req.url?.startsWith('/admin/')) adminSeen.push({ url: req.url, body })
  const sized = req.url === '/admin/sql' && body.includes('pg_database_size')
  res.writeHead(200, { 'content-type': 'application/json' }).end(sized ? '{"columns":["bytes"],"rows":[["1000"]]}' : '{}')
})
const workers = (waits: Record<string, number> = {}) => {
  const port = (stub.address() as AddressInfo).port
  const w = startWorkers({ db: pool, provisioner: fake, backoffMs: 1, idleMs: 20, probe: async () => cert,
    coreUrl: (ref) => `http://127.0.0.1:${port}/${ref}`, waits: { pollMs: 10, healthyMs: 2000, certificateMs: 300, warmMs: 200, ...waits } })
  running.push(w)
  return w
}
const until = async <T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const v = await fn()
    if (v !== undefined) return v
  }
  throw new Error('timed out')
}
const finished = (id: string) => until(async () => {
  const j = (await pool.query('select * from control.jobs where id = $1', [id])).rows[0]
  return ['succeeded', 'failed'].includes(j.status) ? j : undefined
})
const row = async (id: string) => (await pool.query('select * from control.projects where id = $1', [id])).rows[0]
const form = (fields: Record<string, string | Blob>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}
const postForm = (token: string, f: FormData | ReadableStream, headers: Record<string, string> = {}) =>
  app.request('/platform/projects/import', { method: 'POST', headers: { authorization: `Bearer ${token}`, ...headers }, body: f,
    ...(f instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit)
const envBlob = (text: string) => new Blob([text], { type: 'text/plain' })
const importFields = (over: Record<string, string | Blob> = {}) =>
  ({ organization_slug: 'acme', name: 'imported', size: 'micro', backup_dir: 'import/acme/corteqs-v1', ...over })
// helpers' project() has a default domain but no host slot; ensure needs one
const slotted = async (o: Parameters<typeof project>[1]) => {
  const p = await project(acme.id, o)
  await pool.query(`insert into control.host_slots (hostname, pool, project_id) values ($1, 'project', $2)`, [`${p.ref}.${config.baseDomain}`, p.id])
  return p
}
const cap = config.maxNewHostsPerWeek
const backupDir = config.backupDir
let dir: string
let budget: number

beforeAll(async () => {
  config.maxNewHostsPerWeek = 1000
  dir = mkdtempSync(joinPath(tmpdir(), 'sb-backups-'))
  config.backupDir = dir
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  forwardTarget.url = () => `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
  await resetDashboard()
  await pool.query('delete from control.jobs where project_id is null')
  budget = (await pool.query('select memory_budget_mb from control.nodes')).rows[0].memory_budget_mb
  // every test leaves its projects running
  await pool.query('update control.nodes set memory_budget_mb = 1000000')
  acme = await org('acme')
  owner = await user('owner@example.test')
  dev = await user('dev@example.test')
  await join(acme.id, owner.id, 'owner')
  await join(acme.id, dev.id, 'developer')
})
afterAll(async () => {
  config.maxNewHostsPerWeek = cap
  config.backupDir = backupDir
  await pool.query('update control.nodes set memory_budget_mb = $1', [budget])
  rmSync(dir, { recursive: true, force: true })
  await new Promise((r) => stub.close(r))
})
beforeEach(() => {
  fake = new FakeProvisioner()
  setProvisioner(fake)
  cert = 'ok'
})
afterEach(async () => {
  await Promise.all(running.splice(0).map((w) => w.stop()))
  // a job a test did not run must not reach the next test's workers
  await pool.query(`update control.jobs set status = 'failed' where status in ('pending', 'running')`)
})

describe('import', () => {
  test('a v1 env file: ensure, stop of the four, restore, start, in that order; ends ACTIVE_HEALTHY with its keys', async () => {
    const { text, vals } = v1Env({ FOO: 'bar' })
    const res = await postForm(owner.token, form({ ...importFields(), env_file: envBlob(text) }))
    expect(res.status).toBe(202)
    const out = await res.json()
    expect(out).toMatchObject({ project: { name: 'imported', status: 'RESTORING', size: 'micro' }, job_id: expect.any(String), unknown: ['FOO'] })
    expect(out.ignored).toEqual(expect.arrayContaining(['POSTGRES_PASSWORD', 'PANEL_ADMIN_PASSWORD_HASH']))
    const p = (await pool.query('select * from control.projects where ref = $1', [out.project.ref])).rows[0]
    expect((await pool.query('select type, payload from control.jobs where id = $1', [out.job_id])).rows[0])
      .toEqual({ type: 'project.import', payload: { backup_dir: 'import/acme/corteqs-v1' } })

    workers()
    expect((await finished(out.job_id)).status).toBe('succeeded')
    const order = fake.calls.map((c) => c.method).filter((m) => ['ensure', 'stop', 'runJob', 'start'].includes(m))
    expect(order).toEqual(['ensure', 'stop', 'runJob', 'start'])
    expect(fake.callsOf('stop')[0].args).toEqual([p.ref, FOUR])
    expect(fake.callsOf('start')[0].args).toEqual([p.ref, FOUR])
    const [ref, type, args, env] = fake.callsOf('runJob')[0].args
    expect([ref, type, args]).toEqual([p.ref, 'restore', { dir: 'import/acme/corteqs-v1' }])
    const s = await getSecrets(pool, p)
    expect(env).toEqual({ PGHOST: 'db', PGPASSWORD: s.POSTGRES_PASSWORD })
    expect((await row(p.id)).status).toBe('ACTIVE_HEALTHY')
    expect(s).toMatchObject({ JWT_SECRET: vals.JWT_SECRET, ANON_KEY: vals.ANON_KEY, SERVICE_ROLE_KEY: vals.SERVICE_ROLE_KEY,
      SMTP_PASS: vals.SMTP_PASS, GOOGLE_CLIENT_SECRET: vals.GOOGLE_CLIENT_SECRET })
    expect(s.POSTGRES_PASSWORD).toBeTruthy()
    expect(s.POSTGRES_PASSWORD).not.toBe(vals.POSTGRES_PASSWORD)
    const cfg = (await pool.query('select section, data from control.project_config where project_id = $1 order by section', [p.id])).rows
    expect(cfg.find((r) => r.section === 'auth').data).toMatchObject({ SITE_URL: vals.SITE_URL, SMTP_USER: vals.SMTP_USER })
    // S7: a server address in the file is never config
    expect(cfg.find((r) => r.section === 'auth').data).not.toHaveProperty('SMTP_HOST')
    expect(cfg.find((r) => r.section === 'storage').data).toEqual({ STORAGE_MAX_UPLOAD_BYTES: vals.STORAGE_MAX_UPLOAD_BYTES })
    // the ensure env carries the imported config
    expect(fake.callsOf('ensure')[0].args[0].env).toMatchObject({ SITE_URL: vals.SITE_URL, JWT_SECRET: vals.JWT_SECRET })
  })

  test('JWT_SECRET without ANON_KEY is refused with 400 and no project', async () => {
    const before = (await pool.query('select count(*)::int as n from control.projects')).rows[0].n
    const res = await postForm(owner.token, form({ ...importFields(), env_file: envBlob('JWT_SECRET=only-the-secret-value\n') }))
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('only-the-secret-value')
    expect((await pool.query('select count(*)::int as n from control.projects')).rows[0].n).toBe(before)
  })

  test('bad forms: backup_dir, both or neither source, a bad env file, a developer', async () => {
    const env = envBlob(v1Env().text)
    for (const d of ['../x', 'a/b/c', '/abs', 'a/..', '', 'import/acme/..', 'import/acme/a/b']) {
      expect((await postForm(owner.token, form({ ...importFields({ backup_dir: d }), env_file: env }))).status).toBe(400)
    }
    expect((await postForm(owner.token, form({ ...importFields(), env_file: env, passphrase: 'correct horse battery' }))).status).toBe(400)
    expect((await postForm(owner.token, form(importFields()))).status).toBe(400)
    const broken = await postForm(owner.token, form({ ...importFields(), env_file: envBlob('A=1\nA=hunter2\n') }))
    expect(broken.status).toBe(400)
    const body = await broken.text()
    expect(body).toMatch(/line 2/)
    expect(body).not.toContain('hunter2')
    expect((await postForm(dev.token, form({ ...importFields(), env_file: env }))).status).toBe(403)
    expect((await postForm(owner.token, form({ ...importFields({ size: 'large' }), env_file: env }))).status).toBe(400)
  })

  test('an env file over 64 KiB and a body without content-length over the cap answer 413', async () => {
    const big = envBlob(`A=${'x'.repeat(70 * 1024)}\n`)
    expect((await postForm(owner.token, form({ ...importFields(), env_file: big }))).status).toBe(413)
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
    let n = 0
    const stream = new ReadableStream({ pull(c) { if (n++ < 8) c.enqueue(chunk); else c.close() } })
    const res = await postForm(owner.token, stream, { 'content-type': 'multipart/form-data; boundary=zzz' })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' })
  })

  test('a restore that exits 3 tells the operator to delete the project and import again', async () => {
    fake.jobResult = () => ({ status: 'failed', exitCode: 3, tail: 'restore: FAILED in the storage step' })
    const out = await (await postForm(owner.token, form({ ...importFields({ name: 'half' }), env_file: envBlob(v1Env().text) }))).json()
    workers()
    expect((await finished(out.job_id)).error).toMatch(/delete this project, then import again/)
  })

  test('a certificate later than the wait leaves the import COMING_UP; a later reconcile pass activates it', async () => {
    cert = 'pending'
    const out = await (await postForm(owner.token, form({ ...importFields({ name: 'slow-cert' }), env_file: envBlob(v1Env().text) }))).json()
    workers()
    const job = await finished(out.job_id)
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/certificate for .* is not issued yet/)
    const p = (await pool.query('select * from control.projects where ref = $1', [out.project.ref])).rows[0]
    expect(p.status).toBe('COMING_UP')
    cert = 'ok'
    await reconcileOnce({ db: pool, provisioner: fake, probe: async () => cert })
    expect((await row(p.id)).status).toBe('ACTIVE_HEALTHY')
  })

  test('a restore that exits 10 fails the job with "the database was not changed"', async () => {
    fake.jobResult = () => ({ status: 'failed', exitCode: 10, tail: 'restore: FAILED: the database restore rolled back' })
    const res = await postForm(owner.token, form({ ...importFields({ name: 'fails' }), env_file: envBlob(v1Env().text) }))
    const out = await res.json()
    workers()
    const job = await finished(out.job_id)
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/the database was not changed/)
    expect((await pool.query('select status from control.projects where ref = $1', [out.project.ref])).rows[0].status).toBe('INIT_FAILED')
    expect(fake.callsOf('start')).toEqual([])
  })

  test('a project.json sealed by an export: the passphrase opens it', async () => {
    const secrets = { JWT_SECRET: 'exported-jwt-secret-value-0123456789', ANON_KEY: 'exported-anon', SERVICE_ROLE_KEY: 'exported-service' }
    const own = await project(acme.id, { name: 'exported' })
    mkdirSync(joinPath(dir, `export-${own.ref}`, '20261122-031500'), { recursive: true })
    const sealed = await sealManifest({ config: { auth: { SITE_URL: 'https://exported.example' } }, secrets }, 'correct horse battery')
    writeFileSync(joinPath(dir, `export-${own.ref}`, '20261122-031500', 'project.json'), Buffer.from(sealed, 'base64'))
    const fields = importFields({ name: 'from-export', backup_dir: `export-${own.ref}/20261122-031500` })
    const wrong = await postForm(owner.token, form({ ...fields, passphrase: 'wrong horse battery' }))
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ error: 'bad_passphrase' })
    const none = await postForm(owner.token, form({ ...fields, backup_dir: `export-${own.ref}/20261122-031501`, passphrase: 'correct horse battery' }))
    expect(none.status).toBe(400)
    const res = await postForm(owner.token, form({ ...fields, passphrase: 'correct horse battery' }))
    expect(res.status).toBe(202)
    const out = await res.json()
    expect(out).toMatchObject({ ignored: [], unknown: [] })
    const p = (await pool.query('select * from control.projects where ref = $1', [out.project.ref])).rows[0]
    expect(await getSecrets(pool, p)).toMatchObject(secrets)
    expect((await pool.query(`select data from control.project_config where project_id = $1 and section = 'auth'`, [p.id])).rows[0].data)
      .toEqual({ SITE_URL: 'https://exported.example' })
  })

  test('S7: a project.json import strips the keys that point core at a server', async () => {
    const own = await project(acme.id, { name: 'exported-s7' })
    mkdirSync(joinPath(dir, `export-${own.ref}`, '20261122-031500'), { recursive: true })
    const sealed = await sealManifest({ config: { auth: { SITE_URL: 'https://exported.example', SMTP_HOST: '192.0.2.2',
      GOOGLE_TOKEN_URL: 'http://192.0.2.1/' } }, secrets: { JWT_SECRET: 'exported-s7-jwt-secret-value-0123456789', ANON_KEY: 'a', SERVICE_ROLE_KEY: 's' } },
      'correct horse battery')
    writeFileSync(joinPath(dir, `export-${own.ref}`, '20261122-031500', 'project.json'), Buffer.from(sealed, 'base64'))
    const res = await postForm(owner.token, form({ ...importFields({ name: 'from-export-s7', backup_dir: `export-${own.ref}/20261122-031500` }),
      passphrase: 'correct horse battery' }))
    expect(res.status).toBe(202)
    const out = await res.json()
    expect(out.ignored).toEqual(['SMTP_HOST', 'GOOGLE_TOKEN_URL'])
    const p = (await pool.query('select id from control.projects where ref = $1', [out.project.ref])).rows[0]
    expect((await pool.query(`select data from control.project_config where project_id = $1 and section = 'auth'`, [p.id])).rows[0].data)
      .toEqual({ SITE_URL: 'https://exported.example' })
  })
})

describe('S1: an import never shares live keys', () => {
  const projectsCount = async () => (await pool.query('select count(*)::int as n from control.projects')).rows[0].n
  const fp = async (projectId: string) =>
    (await pool.query(`select fingerprint from control.project_secrets where project_id = $1 and name = 'JWT_SECRET'`, [projectId])).rows[0]?.fingerprint

  test('an env file whose JWT secret a live project holds is refused with 409 keys_in_use, naming no value', async () => {
    const { text, vals } = v1Env({ JWT_SECRET: 'live-jwt-secret-value-0123456789abcdef' })
    expect((await postForm(owner.token, form({ ...importFields({ name: 'live-1' }), env_file: envBlob(text) }))).status).toBe(202)
    const before = await projectsCount()
    const again = await postForm(owner.token, form({ ...importFields({ name: 'live-2' }), env_file: envBlob(text) }))
    expect(again.status).toBe(409)
    const body = await again.text()
    expect(JSON.parse(body)).toMatchObject({ error: 'keys_in_use' })
    expect(body).toMatch(/already live/)
    expect(body).toMatch(/rotate_keys/)
    for (const v of [vals.JWT_SECRET, vals.ANON_KEY, vals.SERVICE_ROLE_KEY]) expect(body).not.toContain(v)
    expect(await projectsCount()).toBe(before)
  })

  test('an export of a live project here (A imported as B) is refused; once A is deleted it imports', async () => {
    const a = await project(acme.id, { name: 'source-a' })
    mkdirSync(joinPath(dir, `export-${a.ref}`, '20261123-031500'), { recursive: true })
    const secrets = { JWT_SECRET: a.secrets.JWT_SECRET, ANON_KEY: a.secrets.ANON_KEY, SERVICE_ROLE_KEY: a.secrets.SERVICE_ROLE_KEY }
    writeFileSync(joinPath(dir, `export-${a.ref}`, '20261123-031500', 'project.json'),
      Buffer.from(await sealManifest({ config: {}, secrets }, 'correct horse battery'), 'base64'))
    const fields = () => form({ ...importFields({ name: 'copy-b', backup_dir: `export-${a.ref}/20261123-031500` }), passphrase: 'correct horse battery' })
    const res = await postForm(owner.token, fields())
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'keys_in_use' })
    // project.delete removes the secrets and leaves the row REMOVED
    await pool.query(`update control.projects set status = 'REMOVED' where id = $1`, [a.id])
    await pool.query('delete from control.project_secrets where project_id = $1', [a.id])
    expect((await postForm(owner.token, fields())).status).toBe(202)
  })

  test('rotate_keys: new JWT secret and keys, third-party secrets kept, sessions of the restored database deleted', async () => {
    const { text, vals } = v1Env({ JWT_SECRET: 'rotated-jwt-secret-value-0123456789abcdef' })
    expect((await postForm(owner.token, form({ ...importFields({ name: 'rot-1' }), env_file: envBlob(text) }))).status).toBe(202)
    const res = await postForm(owner.token, form({ ...importFields({ name: 'rot-2' }), env_file: envBlob(text), rotate_keys: 'true' }))
    expect(res.status).toBe(202)
    const out = await res.json()
    expect((await pool.query('select payload from control.jobs where id = $1', [out.job_id])).rows[0].payload)
      .toEqual({ backup_dir: 'import/acme/corteqs-v1', rotate_keys: true })
    adminSeen.length = 0
    workers()
    expect((await finished(out.job_id)).status).toBe('succeeded')
    const p = (await pool.query('select * from control.projects where ref = $1', [out.project.ref])).rows[0]
    const s = await getSecrets(pool, p)
    expect(s.JWT_SECRET).toBeTruthy()
    for (const k of ['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY']) expect(s[k], k).not.toBe(vals[k])
    expect(s).toMatchObject({ SMTP_PASS: vals.SMTP_PASS, GOOGLE_CLIENT_SECRET: vals.GOOGLE_CLIENT_SECRET })
    const sql = adminSeen.filter((r) => r.url === '/admin/sql')
    expect(sql).toHaveLength(1)
    const query = JSON.parse(sql[0].body).query as string
    expect(query).toMatch(/delete from auth\.refresh_tokens/)
    expect(query).toMatch(/auth\.sessions/)
    // the sessions go before the project is warmed and activated
    const steps = (await pool.query(`select step from control.job_events where job_id = $1 and status = 'succeeded' order by id`, [out.job_id]))
      .rows.map((r) => r.step)
    expect(steps.indexOf('sessions')).toBeGreaterThan(steps.indexOf('started'))
    expect(steps.indexOf('sessions')).toBeLessThan(steps.indexOf('warm'))
  })

  test('rotate_keys must be true or false', async () => {
    const res = await postForm(owner.token, form({ ...importFields({ name: 'rot-bad' }), env_file: envBlob(v1Env().text), rotate_keys: 'yes' }))
    expect(res.status).toBe(400)
  })

  test('an import without rotate_keys deletes no session', async () => {
    const out = await (await postForm(owner.token, form({ ...importFields({ name: 'keep-sessions' }), env_file: envBlob(v1Env().text) }))).json()
    adminSeen.length = 0
    workers()
    expect((await finished(out.job_id)).status).toBe('succeeded')
    expect(adminSeen.filter((r) => r.url === '/admin/sql')).toEqual([])
  })

  test('the fingerprint is an HMAC under the master key, stored at create; backfill fills rows written before it', async () => {
    const p = await project(acme.id, { name: 'fp' })
    expect(Buffer.compare(await fp(p.id), fingerprint(p.secrets.JWT_SECRET))).toBe(0)
    expect((await pool.query(`select count(*)::int as n from control.project_secrets
      where project_id = $1 and name <> 'JWT_SECRET' and fingerprint is not null`, [p.id])).rows[0].n).toBe(0)
    await pool.query('update control.project_secrets set fingerprint = null where project_id = $1', [p.id])
    await backfillFingerprints(pool)
    expect(Buffer.compare(await fp(p.id), fingerprint(p.secrets.JWT_SECRET))).toBe(0)
    await putSecret(pool, p, 'JWT_SECRET', 'platform', 'changed-jwt-secret-value-0123456789')
    expect(Buffer.compare(await fp(p.id), fingerprint('changed-jwt-secret-value-0123456789'))).toBe(0)
  })
})

describe('backup_dir belongs to the caller', () => {
  test("another organization's backups are the same 404 as an unknown one; bare or odd shapes are 400", async () => {
    const other = await org('other')
    const theirs = await project(other.id, { name: 'theirs' })
    const mine = await project(acme.id, { name: 'mine' })
    const gone = await project(acme.id, { name: 'gone', status: 'REMOVED' })
    const status = async (d: string) => {
      const res = await postForm(owner.token, form({ ...importFields({ name: 'own-check' }), backup_dir: d, env_file: envBlob(v1Env().text) }))
      return { status: res.status, body: await res.json() }
    }
    const unknownRef = 'zzzzzzzzzzzzzzzzzzzz'
    const refused404 = [`${theirs.ref}/20261121-031500`, `export-${theirs.ref}/20261121-031500`, 'import/other/corteqs-v1',
      `${unknownRef}/20261121-031500`, `export-${unknownRef}/20261121-031500`, 'import/nope/x']
    const bodies = []
    for (const d of refused404) {
      const r = await status(d)
      expect(r.status, d).toBe(404)
      bodies.push(JSON.stringify(r.body))
    }
    // no oracle: a foreign backup and an unknown one answer alike
    expect(new Set(bodies).size).toBe(1)
    for (const d of ['20261121-031500', 'v1/20261121-031500', 'import/acme', `${mine.ref}/latest`, `export-${mine.ref}`, 'export-x/20261121-031500']) {
      const r = await status(d)
      expect(r.status, d).toBe(400)
      expect(r.body.error).toBe('invalid_backup_dir')
    }
    for (const d of [`${mine.ref}/20261121-031500`, `export-${mine.ref}/20261121-031500`, `${gone.ref}/20261121-031500`, 'import/acme/corteqs-v1']) {
      expect((await status(d)).status, d).toBe(202)
    }
  })

  test('the import job checks backup_dir again: a foreign one fails before any restore', async () => {
    const other = (await pool.query(`select id from control.organizations where slug = 'other'`)).rows[0]
      ?? await org('other')
    const theirs = await project(other.id, { name: 'theirs-2' })
    const { jobId } = await createProject(pool, { orgId: acme.id, name: 'forged', size: 'micro', pool: 'project', createdBy: null,
      job: { type: 'project.import', status: 'RESTORING', payload: { backup_dir: `${theirs.ref}/20261121-031500` } } })
    workers()
    const job = await finished(jobId)
    expect(job.status).toBe('failed')
    expect(fake.callsOf('runJob')).toEqual([])
  })
})

describe('backup and export', () => {
  test('a backup job runs the provisioner job and records a backups row; rows of backups retention deleted go', async () => {
    const p = await project(acme.id, { name: 'b' })
    await pool.query(`insert into control.backups (project_id, kind, status, location) values ($1, 'logical', 'succeeded', $2)`, [p.id, `${p.ref}/x`])
    fake.jobResult = (ref) => ({ status: 'succeeded', exitCode: 0, tail: `backup: deleted ${ref}/x\nbackup: size 1234 bytes\nbackup: wrote ${ref}/20261122-031500\n` })
    expect((await withToken(dev.token, 'POST', `/platform/projects/${p.ref}/backups`)).status).toBe(403)
    const res = await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)
    expect(res.status).toBe(202)
    const { job_id } = await res.json()
    expect((await pool.query('select payload from control.jobs where id = $1', [job_id])).rows[0].payload).toEqual({})
    workers()
    expect((await finished(job_id)).status).toBe('succeeded')
    expect(fake.callsOf('runJob')[0].args).toEqual([p.ref, 'backup', {},
      { PGHOST: 'db', PGPASSWORD: p.secrets.POSTGRES_PASSWORD, BACKUP_SUBDIR: p.ref, BACKUP_RETENTION_DAYS: String(config.backupRetentionDays) }])
    const list = await (await withToken(dev.token, 'GET', `/platform/projects/${p.ref}/backups`)).json()
    expect(list).toEqual([expect.objectContaining({ kind: 'logical', status: 'succeeded', size_bytes: 1234,
      location: `${p.ref}/20261122-031500`, started_at: expect.any(String), finished_at: expect.any(String) })])
  })

  test('a paused project cannot be backed up or exported', async () => {
    const p = await project(acme.id, { name: 'paused', status: 'INACTIVE' })
    expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).status).toBe(409)
    expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/export`, { passphrase: 'correct horse battery' })).status).toBe(409)
  })

  test('a start that answers 409 job_running is taken as started and the wait follows the job', async () => {
    const p = await project(acme.id, { name: 'resumed' })
    fake.runJob = async () => { throw new ProvisionerError('job_running', 'another job is running', 409) }
    fake.jobResult = (ref) => ({ status: 'succeeded', exitCode: 0, tail: `backup: size 7 bytes\nbackup: wrote ${ref}/20261122-031500` })
    const { job_id } = await (await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).json()
    workers()
    expect((await finished(job_id)).status).toBe('succeeded')
    expect((await pool.query('select location from control.backups where project_id = $1', [p.id])).rows).toEqual([{ location: `${p.ref}/20261122-031500` }])
  })

  test("another job's result (a nightly backup read by an export) is never recorded as this job's", async () => {
    const p = await project(acme.id, { name: 'crossed' })
    fake.jobResult = (ref) => ({ status: 'succeeded', exitCode: 0, tail: `backup: size 7 bytes\nbackup: wrote ${ref}/20261122-031500` })
    const { job_id } = await (await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/export`, { passphrase: 'correct horse battery' })).json()
    workers()
    expect((await finished(job_id)).status).toBe('failed')
    expect((await pool.query('select 1 from control.backups where project_id = $1', [p.id])).rowCount).toBe(0)
  })

  test('export: the payload holds the sealed manifest and not the passphrase; the job writes it as project.json', async () => {
    const p = await project(acme.id, { name: 'e' })
    await pool.query(`insert into control.project_config (project_id, section, data) values ($1, 'auth', '{"SITE_URL":"https://e.example"}')`, [p.id])
    fake.jobResult = (ref) => ({ status: 'succeeded', exitCode: 0, tail: `backup: size 99 bytes\nbackup: wrote export-${ref}/20261122-031500` })
    const pass = 'export passphrase value'
    expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/export`, { passphrase: 'short' })).status).toBe(400)
    const res = await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/export`, { passphrase: pass })
    expect(res.status).toBe(202)
    const { job_id } = await res.json()
    const payload = (await pool.query('select payload from control.jobs where id = $1', [job_id])).rows[0].payload
    const text = JSON.stringify(payload)
    expect(text).not.toContain(pass)
    for (const v of Object.values(p.secrets)) expect(text).not.toContain(v)
    workers()
    expect((await finished(job_id)).status).toBe('succeeded')
    const [ref, type, args, env] = fake.callsOf('runJob')[0].args
    expect([ref, type, args]).toEqual([p.ref, 'backup', {}])
    expect(env).toMatchObject({ PGHOST: 'db', PGPASSWORD: p.secrets.POSTGRES_PASSWORD, BACKUP_SUBDIR: `export-${p.ref}` })
    const opened = await openManifest(env.MANIFEST_B64, pass)
    expect(opened.secrets).toEqual({ JWT_SECRET: p.secrets.JWT_SECRET, ANON_KEY: p.secrets.ANON_KEY, SERVICE_ROLE_KEY: p.secrets.SERVICE_ROLE_KEY })
    expect(opened.config).toEqual({ auth: { SITE_URL: 'https://e.example' } })
    const list = await (await withToken(owner.token, 'GET', `/platform/projects/${p.ref}/backups`)).json()
    expect(list[0]).toMatchObject({ location: `export-${p.ref}/20261122-031500`, size_bytes: 99 })
    // the sealed manifest does not stay in control-db (and its backups) once the job has ended
    expect((await pool.query('select payload from control.jobs where id = $1', [job_id])).rows[0].payload.manifest).toBeUndefined()
  })

  test('a failed backup job fails with its exit code and records no row', async () => {
    const p = await project(acme.id, { name: 'bf' })
    fake.jobResult = () => ({ status: 'failed', exitCode: 1, tail: 'backup: FAILED (exit 1)' })
    const { job_id } = await (await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).json()
    workers()
    const job = await finished(job_id)
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/exit 1/)
    // a failure's output can quote a row (pg_restore, COPY): it is not kept where read_only members read job events
    const events = (await pool.query('select message from control.job_events where job_id = $1', [job_id])).rows
    expect(JSON.stringify(events)).not.toContain('backup: FAILED')
    expect((await pool.query('select count(*)::int as n from control.backups where project_id = $1', [p.id])).rows[0].n).toBe(0)
    expect((await row(p.id)).status).toBe('ACTIVE_HEALTHY')
  })

  test('control.backup backs up the control database', async () => {
    const id = await enqueue(pool, { type: 'control.backup', payload: {}, createdBy: null })
    fake.jobResult = () => ({ status: 'succeeded', exitCode: 0, tail: 'backup: size 5 bytes\nbackup: wrote control/20261122-031500' })
    workers()
    expect((await finished(id)).status).toBe('succeeded')
    expect(fake.callsOf('runJob')[0].args).toEqual(['control', 'backup', {},
      { PGHOST: config.dbHost, PGPASSWORD: config.dbPassword, BACKUP_SUBDIR: 'control', BACKUP_RETENTION_DAYS: String(config.backupRetentionDays) }])
  })

  test('a jobStatus timeout fails the job at once: the result is not read again', async () => {
    const p = await project(acme.id, { name: 'bt' })
    const real = fake.jobStatus.bind(fake)
    let reads = 0
    fake.jobStatus = async (ref, type) => {
      reads++
      await real(ref, type)
      throw new ProvisionerError('provisioner_timeout', 'provisioner did not answer GET within 180 s')
    }
    const { job_id } = await (await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).json()
    workers()
    const job = await finished(job_id)
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/result was lost/)
    expect(reads).toBe(1)
  })
})

describe('schedule', () => {
  test('one project.backup per active project, none for a paused one, and one control.backup', async () => {
    await pool.query(`delete from control.jobs where type in ('project.backup', 'control.backup')`)
    const a = await project(acme.id, { name: 'sa' })
    const b = await project(acme.id, { name: 'sb' })
    // a failing certificate probe or one unhealthy service on the night is exactly when a backup matters
    const coming = await project(acme.id, { name: 'sc', status: 'COMING_UP' })
    const unhealthy = await project(acme.id, { name: 'su', status: 'ACTIVE_UNHEALTHY' })
    const paused = await project(acme.id, { name: 'sp', status: 'INACTIVE' })
    const busy = await project(acme.id, { name: 'sbusy' })
    await enqueue(pool, { type: 'project.pause', projectId: busy.id, payload: {}, createdBy: null })
    await enqueueDailyBackups(pool)
    // the next night while tonight's are still queued: nothing twice
    await enqueueDailyBackups(pool)
    const jobs = (await pool.query(`select type, project_id from control.jobs where type in ('project.backup', 'control.backup')`)).rows
    const of = (id: string) => jobs.filter((j) => j.project_id === id).length
    expect(of(a.id)).toBe(1)
    expect(of(b.id)).toBe(1)
    expect(of(coming.id)).toBe(1)
    expect(of(unhealthy.id)).toBe(1)
    expect(of(paused.id)).toBe(0)
    expect(of(busy.id)).toBe(0)
    expect(jobs.filter((j) => j.type === 'control.backup')).toHaveLength(1)
    expect(new Set(jobs.filter((j) => j.type === 'project.backup').map((j) => j.project_id)).size)
      .toBe(jobs.filter((j) => j.type === 'project.backup').length)
  })

  test('S8: a night with a low backup volume queues no backup and leaves a failed job with the reason per backup', async () => {
    await pool.query(`delete from control.jobs where type in ('project.backup', 'control.backup')`)
    const p = await project(acme.id, { name: 'slow-disk' })
    const space = vi.spyOn(disk, 'space').mockResolvedValue({ free: 1 * 2 ** 30, total: 100 * 2 ** 30 })
    try {
      await enqueueDailyBackups(pool)
    } finally {
      space.mockRestore()
    }
    const jobs = (await pool.query(`select type, project_id, status, error from control.jobs where type in ('project.backup', 'control.backup')`)).rows
    expect(jobs.filter((j) => j.status !== 'failed')).toEqual([])
    expect(jobs.find((j) => j.type === 'control.backup')).toMatchObject({ status: 'failed', error: expect.stringMatching(/GiB free/) })
    expect(jobs.find((j) => j.project_id === p.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/GiB free/) })
  })

  test('the next run is at 03:15 UTC; a missed one is not replayed', () => {
    expect(msUntilNext(new Date('2026-11-22T03:14:00Z'))).toBe(60_000)
    expect(msUntilNext(new Date('2026-11-22T03:15:00Z'))).toBe(86_400_000)
    expect(msUntilNext(new Date('2026-11-22T10:00:00Z'))).toBe((17 * 60 + 15) * 60_000)
  })
})

describe('carries', () => {
  test('restore refused at the job: the job error and an event carry the numbers; GET shows it', async () => {
    const p = await project(acme.id, { name: 'refused', status: 'INACTIVE', size: 'medium' })
    const id = await enqueue(pool, { type: 'project.restore', projectId: p.id, payload: {}, createdBy: null })
    await pool.query('update control.nodes set memory_budget_mb = 100')
    try {
      workers()
      const job = await finished(id)
      expect(job.status).toBe('failed')
      expect(job.error).toMatch(/MiB/)
    } finally {
      await pool.query('update control.nodes set memory_budget_mb = 1000000')
    }
    expect((await row(p.id)).status).toBe('INACTIVE')
    const detail = await (await withToken(owner.token, 'GET', `/platform/projects/${p.ref}`)).json()
    expect(detail.last_job).toMatchObject({ type: 'project.restore', status: 'failed', error: expect.stringMatching(/MiB/) })
    const ev = await (await withToken(owner.token, 'GET', `/platform/jobs/${id}`)).json()
    expect(ev.events.map((e: any) => e.event).join('\n')).toMatch(/admission_refused.*neededMb/)
  })

  test('a transient inspect failure while waiting for healthy is ridden out', async () => {
    const p = await slotted({ name: 'flaky', status: 'INACTIVE' })
    fake.fail('inspect', 2)
    const id = await enqueue(pool, { type: 'project.restore', projectId: p.id, payload: {}, createdBy: null })
    workers()
    expect((await finished(id)).status).toBe('succeeded')
    expect((await row(p.id)).status).toBe('ACTIVE_HEALTHY')
  })

  test('an upgrade with no template version to go to keeps the status', async () => {
    const p = await project(acme.id, { name: 'up', status: 'ACTIVE_HEALTHY' })
    const saved = (await pool.query(`delete from control.settings where key = 'current_template_version' returning value`)).rows[0]
    try {
      const id = await enqueue(pool, { type: 'project.upgrade', projectId: p.id, payload: {}, createdBy: null })
      workers()
      expect((await finished(id)).status).toBe('failed')
      expect((await row(p.id)).status).toBe('ACTIVE_HEALTHY')
    } finally {
      if (saved) await pool.query(`insert into control.settings (key, value) values ('current_template_version', $1)`, [saved.value])
    }
  })

  test('warm is skipped and logged when SERVICE_ROLE_KEY is missing', async () => {
    const p = await slotted({ name: 'nokey', status: 'INACTIVE' })
    const id = await enqueue(pool, { type: 'project.restore', projectId: p.id, payload: {}, createdBy: null })
    // ensure needs every secret: drop the key once ensure has run
    fake.once('ensure', async () => { await pool.query(`delete from control.project_secrets where project_id = $1 and name = 'SERVICE_ROLE_KEY'`, [p.id]) })
    workers()
    expect((await finished(id)).status).toBe('succeeded')
    const ev = await (await withToken(owner.token, 'GET', `/platform/jobs/${id}`)).json()
    expect(ev.events.map((e: any) => e.event).join('\n')).toMatch(/warm_skipped/)
  })

  test('a permanent provisioner refusal is not retried', async () => {
    const p = await slotted({ name: 'perm', status: 'INACTIVE' })
    fake.ensure = async () => { throw new ProvisionerError('invalid_env', 'env could not be rendered', 400) }
    const id = await enqueue(pool, { type: 'project.restore', projectId: p.id, payload: {}, createdBy: null })
    workers()
    const job = await finished(id)
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(1)
    expect(job.error).toMatch(/env could not be rendered/)
  })
})

describe('S8: backups cannot fill the backup volume', () => {
  const GiB = 2 ** 30
  afterEach(() => { vi.restoreAllMocks() })
  const manualJobs = async (projectId: string, n: number, type = 'project.backup', age = '10 minutes') => {
    for (let i = 0; i < n; i++) {
      await pool.query(`insert into control.jobs (type, lane, project_id, payload, status, created_by, created_at)
        values ($1, 'heavy', $2, '{}', 'succeeded', $3, now() - $4::interval)`, [type, projectId, owner.id, age])
    }
  }

  test('three manual backups or exports an hour per project; the fourth is 429, scheduled ones and older ones do not count', async () => {
    const p = await project(acme.id, { name: 's8-rate' })
    await manualJobs(p.id, 2)
    await manualJobs(p.id, 1, 'project.export')
    await manualJobs(p.id, 3, 'project.backup', '2 hours')
    await pool.query(`insert into control.jobs (type, lane, project_id, payload, status, created_by) values ('project.backup', 'heavy', $1, '{}', 'succeeded', null)`, [p.id])
    const res = await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'too_many_backups', message: expect.stringMatching(/3 .*last hour/) })
    const exp = await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/export`, { passphrase: 'correct horse battery' })
    expect(exp.status).toBe(429)
    const q = await project(acme.id, { name: 's8-rate-2' })
    await manualJobs(q.id, 2)
    expect((await withToken(owner.token, 'POST', `/platform/projects/${q.ref}/backups`)).status).toBe(202)
  })

  test('below 10% or 5 GiB free on the backup volume, backups, exports and imports are refused with the reason', async () => {
    const space = vi.spyOn(disk, 'space')
    const p = await project(acme.id, { name: 's8-disk' })
    const before = (await pool.query('select count(*)::int as n from control.jobs where project_id = $1', [p.id])).rows[0].n
    // 9% free of 100 GiB, then 4.5 GiB free of 40 GiB (over 10%, under 5 GiB)
    for (const [free, total] of [[9 * GiB, 100 * GiB], [4.5 * GiB, 40 * GiB]]) {
      space.mockResolvedValue({ free, total })
      const b = await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)
      expect(b.status).toBe(507)
      expect(await b.json()).toMatchObject({ error: 'backup_volume_full', message: expect.stringMatching(/GiB free/) })
      expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/export`, { passphrase: 'correct horse battery' })).status).toBe(507)
      const i = await postForm(owner.token, form({ ...importFields({ name: 's8-import' }), env_file: envBlob(v1Env().text) }))
      expect(i.status).toBe(507)
    }
    expect((await pool.query('select count(*)::int as n from control.jobs where project_id = $1', [p.id])).rows[0].n).toBe(before)
    expect((await pool.query(`select 1 from control.projects where name = 's8-import'`)).rowCount).toBe(0)
    // the volume cannot be read: refused too
    space.mockRejectedValue(new Error('ENOENT'))
    expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).status).toBe(503)
    space.mockResolvedValue({ free: 20 * GiB, total: 100 * GiB })
    expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).status).toBe(202)
  })

  test('the reconcile pass prunes export rows past EXPORT_RETENTION_DAYS; backups rows stay', async () => {
    const p = await project(acme.id, { name: 's8-prune' })
    const add = (location: string, days: number) => pool.query(`insert into control.backups (project_id, kind, status, started_at, finished_at, location)
      values ($1, 'logical', 'succeeded', now() - make_interval(days => $2), now() - make_interval(days => $2), $3)`, [p.id, days, location])
    await add(`export-${p.ref}/old`, 8)
    await add(`export-${p.ref}/recent`, 6)
    await add(`${p.ref}/old`, 8)
    await reconcileOnce({ db: pool, provisioner: fake, probe: async () => 'ok' })
    const left = async () => (await pool.query('select location from control.backups where project_id = $1', [p.id])).rows.map((r) => r.location).sort()
    expect(await left()).toEqual([`${p.ref}/old`, `export-${p.ref}/recent`].sort())
    const saved = config.exportRetentionDays
    config.exportRetentionDays = 5
    try {
      await reconcileOnce({ db: pool, provisioner: fake, probe: async () => 'ok' })
      expect(await left()).toEqual([`${p.ref}/old`])
    } finally {
      config.exportRetentionDays = saved
    }
  })
})

describe('fix round 2', () => {
  const GiB = 2 ** 30
  afterEach(() => { vi.restoreAllMocks() })

  test('S1: with rotate_keys, core never runs on the restored database with the stored JWT secret before its sessions are gone', async () => {
    const order: string[] = []
    const ensure = fake.ensure.bind(fake)
    const start = fake.start.bind(fake)
    const runJob = fake.runJob.bind(fake)
    fake.ensure = async (input) => { order.push(`ensure:${input.env.JWT_SECRET}`); return ensure(input) }
    fake.start = async (ref, services) => { order.push('start'); return start(ref, services) }
    fake.runJob = async (ref, type, args, env) => { order.push(`job:${type}`); return runJob(ref, type, args, env) }
    const push = adminSeen.push.bind(adminSeen)
    adminSeen.push = (...r) => { order.push(`admin:${r[0].url}`); return push(...r) }
    try {
      const res = await postForm(owner.token, form({ ...importFields({ name: 'rot-window' }), env_file: envBlob(v1Env().text), rotate_keys: 'true' }))
      expect(res.status).toBe(202)
      const out = await res.json()
      workers()
      expect((await finished(out.job_id)).status).toBe('succeeded')
      const p = (await pool.query('select * from control.projects where ref = $1', [out.project.ref])).rows[0]
      const stored = `ensure:${(await getSecrets(pool, p)).JWT_SECRET}`
      const restore = order.indexOf('job:restore')
      const deleted = order.indexOf('admin:/admin/sql')
      expect(restore).toBeGreaterThan(-1)
      expect(deleted).toBeGreaterThan(restore)
      // between the restore and the deletes: no start with the stored env, no ensure with the stored secret
      const between = order.slice(restore + 1, deleted)
      expect(between.length).toBeGreaterThan(0)
      expect(between.filter((e) => e === 'start' || e === stored)).toEqual([])
      // and the throwaway secret core ran with meanwhile is never used again
      const throwaway = between.find((e) => e.startsWith('ensure:'))!
      expect(order.slice(deleted)).not.toContain(throwaway)
      expect(order.slice(deleted)).toContain(stored)
    } finally {
      adminSeen.push = push
    }
  })

  test('S7: a manifest whose config.auth.__proto__ carries endpoints installs none of them', async () => {
    const own = await project(acme.id, { name: 'proto-src' })
    mkdirSync(joinPath(dir, `export-${own.ref}`, '20261122-031500'), { recursive: true })
    const config = JSON.parse('{"auth":{"SITE_URL":"https://exported.example","__proto__":{"SMTP_HOST":"attacker.example","GOOGLE_TOKEN_URL":"https://attacker.example/token"}}}')
    const sealed = await sealManifest({ config, secrets: { JWT_SECRET: 'proto-jwt-secret-value-0123456789abcdef', ANON_KEY: 'a', SERVICE_ROLE_KEY: 's' } },
      'correct horse battery')
    writeFileSync(joinPath(dir, `export-${own.ref}`, '20261122-031500', 'project.json'), Buffer.from(sealed, 'base64'))
    const res = await postForm(owner.token, form({ ...importFields({ name: 'proto-dst', backup_dir: `export-${own.ref}/20261122-031500` }),
      passphrase: 'correct horse battery' }))
    expect(res.status).toBe(202)
    const out = await res.json()
    const p = (await pool.query('select * from control.projects where ref = $1', [out.project.ref])).rows[0]
    const data = (await pool.query(`select data::text as t from control.project_config where project_id = $1 and section = 'auth'`, [p.id])).rows[0].t
    expect(data).not.toMatch(/__proto__|attacker/)
    // the project has no host or generated secrets until its job runs: the env as built from its config
    const env = buildEnv(p, Object.fromEntries(SECRET_ENV.map((k) => [k, 'x'])), await projectConfig(pool, p.id), ['h.example.test'])
    expect(env.SMTP_HOST).toBe('')
    expect(env.GOOGLE_TOKEN_URL).toBe('https://oauth2.googleapis.com/token')
  })

  test('S7: a stored row that already holds __proto__ is read as own keys only', async () => {
    const p = await project(acme.id, { name: 'proto-row' })
    await pool.query(`delete from control.project_config where project_id = $1`, [p.id])
    await pool.query(`insert into control.project_config (project_id, section, data) values ($1, 'auth', $2::jsonb)`,
      [p.id, '{"__proto__":{"SMTP_HOST":"attacker.example","GOOGLE_TOKEN_URL":"https://attacker.example/token"}}'])
    const { env } = await loadProjectEnv(pool, p)
    expect(env.SMTP_HOST).toBe('')
    expect(env.GOOGLE_TOKEN_URL).toBe('https://oauth2.googleapis.com/token')
  })

  test('S8: a backup or export larger than the headroom above the floor is refused; the size comes from the project', async () => {
    const p = await project(acme.id, { name: 'big-db' })
    vi.spyOn(disk, 'space').mockResolvedValue({ free: 11 * GiB, total: 100 * GiB })
    const size = vi.spyOn(disk, 'projectBytes').mockResolvedValue(12 * GiB)
    const b = await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)
    expect(b.status).toBe(507)
    expect(await b.json()).toMatchObject({ error: 'backup_volume_full', message: expect.stringMatching(/12\.0 GiB/) })
    expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/export`, { passphrase: 'correct horse battery' })).status).toBe(507)
    expect(size).toHaveBeenCalledWith(expect.objectContaining({ ref: p.ref }))
    size.mockRejectedValue(new Error('core down'))
    expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).status).toBe(503)
    size.mockResolvedValue(0.5 * GiB)
    expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).status).toBe(202)
  })

  test('S8: disk.projectBytes asks core for the database and storage size', async () => {
    const p = await project(acme.id, { name: 'sized' })
    adminSeen.length = 0
    expect(await disk.projectBytes(p)).toBe(1000)
    const q = JSON.parse(adminSeen.at(-1)!.body).query as string
    expect(q).toMatch(/pg_database_size/)
    expect(q).toMatch(/storage\.objects/)
  })

  test('S8: the nightly backups count each queued backup against the headroom; the rest fail with the reason', async () => {
    await pool.query(`delete from control.jobs where type in ('project.backup', 'control.backup')`)
    await project(acme.id, { name: 'night-a' })
    await project(acme.id, { name: 'night-b' })
    vi.spyOn(disk, 'space').mockResolvedValue({ free: 11 * GiB, total: 100 * GiB })
    vi.spyOn(disk, 'projectBytes').mockResolvedValue(0.6 * GiB)
    await enqueueDailyBackups(pool)
    const jobs = (await pool.query(`select status, error from control.jobs where type = 'project.backup'`)).rows
    expect(jobs.filter((j) => j.status === 'pending')).toHaveLength(1)
    expect(jobs.length).toBeGreaterThan(1)
    for (const j of jobs.filter((j) => j.status !== 'pending')) expect(j).toMatchObject({ status: 'failed', error: expect.stringMatching(/GiB/) })
  })
})
