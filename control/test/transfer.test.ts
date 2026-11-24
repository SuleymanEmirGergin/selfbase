import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
import { enqueueDailyBackups, enqueueExportPrunes, msUntilNext } from '../src/schedule.ts'
import { backfillFingerprints, fingerprint, getSecrets, putSecret } from '../src/secrets.ts'
import { forwardTarget } from '../src/forward.ts'
import { disk, SIZE_SQL } from '../src/disk.ts'
import { buildEnv, loadProjectEnv, projectConfig, SECRET_ENV } from '../src/project-env.ts'
import { FakeProvisioner } from './fake-provisioner.ts'
import { join, org, project, resetDashboard, user, v1Env, withToken } from './helpers.ts'

const FOUR = ['core', 'rest', 'fn', 'pooler']
// what restore.sh prints when ROTATE_KEYS=1 deleted the restored sessions
const ROTATED_TAIL = 'restore: database restored\nrestore: the restored sessions are deleted (ROTATE_KEYS)\nrestore: storage restored\n'
let fake: FakeProvisioner
let acme: { id: string; slug: string }
let owner: Awaited<ReturnType<typeof user>>
let dev: Awaited<ReturnType<typeof user>>
let cert: 'ok' | 'pending' = 'ok'
const running: { stop(): Promise<void> }[] = []
// core's API and admin listeners in one: records what the admin listener was sent
const adminSeen: { url: string; body: string }[] = []
// what the stub answers to the size query
let sizeAnswer = '1000'
// a hung core: the size query gets no answer until the test ends it
const hung: { on: boolean; held: import('node:http').ServerResponse[] } = { on: false, held: [] }
const stub = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (req.url?.startsWith('/admin/')) adminSeen.push({ url: req.url, body })
  const sized = req.url === '/admin/sql' && body.includes('pg_database_size')
  if (sized && hung.on) return void hung.held.push(res)
  res.writeHead(200, { 'content-type': 'application/json' }).end(sized ? JSON.stringify({ columns: ['bytes'], rows: [[sizeAnswer]] }) : '{}')
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
  ({ organization_slug: 'acme', name: 'imported', size: 'micro', backup_dir: 'import/acme/v1-dump', ...over })
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
      .toEqual({ type: 'project.import', payload: { backup_dir: 'import/acme/v1-dump', job_version: 2 } })

    workers()
    expect((await finished(out.job_id)).status).toBe('succeeded')
    const order = fake.calls.map((c) => c.method).filter((m) => ['ensure', 'stop', 'runJob', 'start'].includes(m))
    expect(order).toEqual(['ensure', 'stop', 'runJob', 'start'])
    expect(fake.callsOf('stop')[0].args).toEqual([p.ref, FOUR])
    expect(fake.callsOf('start')[0].args).toEqual([p.ref, FOUR])
    const [ref, type, args, env] = fake.callsOf('runJob')[0].args
    expect([ref, type, args]).toEqual([p.ref, 'restore', { dir: 'import/acme/v1-dump' }])
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

  test('rotate_keys: new JWT secret and keys, third-party secrets kept, the restore job told to delete the sessions', async () => {
    const { text, vals } = v1Env({ JWT_SECRET: 'rotated-jwt-secret-value-0123456789abcdef' })
    expect((await postForm(owner.token, form({ ...importFields({ name: 'rot-1' }), env_file: envBlob(text) }))).status).toBe(202)
    const res = await postForm(owner.token, form({ ...importFields({ name: 'rot-2' }), env_file: envBlob(text), rotate_keys: 'true' }))
    expect(res.status).toBe(202)
    const out = await res.json()
    expect((await pool.query('select payload from control.jobs where id = $1', [out.job_id])).rows[0].payload)
      .toEqual({ backup_dir: 'import/acme/v1-dump', rotate_keys: true, job_version: 2 })
    adminSeen.length = 0
    fake.jobResult = () => ({ status: 'succeeded', exitCode: 0, tail: ROTATED_TAIL })
    workers()
    expect((await finished(out.job_id)).status).toBe('succeeded')
    const p = (await pool.query('select * from control.projects where ref = $1', [out.project.ref])).rows[0]
    const s = await getSecrets(pool, p)
    expect(s.JWT_SECRET).toBeTruthy()
    for (const k of ['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY']) expect(s[k], k).not.toBe(vals[k])
    expect(s).toMatchObject({ SMTP_PASS: vals.SMTP_PASS, GOOGLE_CLIENT_SECRET: vals.GOOGLE_CLIENT_SECRET })
    // the restore job deletes them while core is stopped: control sends no SQL of its own
    const env = fake.callsOf('runJob').find((c) => c.args[0] === p.ref)!.args[3]
    expect({ ...env, PGPASSWORD: env.PGPASSWORD === s.POSTGRES_PASSWORD }).toEqual({ PGHOST: 'db', PGPASSWORD: true, ROTATE_KEYS: '1' })
    expect(adminSeen.filter((r) => r.url === '/admin/sql')).toEqual([])
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
    expect(fake.callsOf('runJob')[0].args[3]).not.toHaveProperty('ROTATE_KEYS')
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
    const refused404 = [`${theirs.ref}/20261121-031500`, `export-${theirs.ref}/20261121-031500`, 'import/other/v1-dump',
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
    for (const d of [`${mine.ref}/20261121-031500`, `export-${mine.ref}/20261121-031500`, `${gone.ref}/20261121-031500`, 'import/acme/v1-dump']) {
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
      { PGHOST: 'db', PGPASSWORD: p.secrets.POSTGRES_PASSWORD, BACKUP_SUBDIR: p.ref, BACKUP_RETENTION_DAYS: String(config.backupRetentionDays),
        EXPORT_RETENTION_DAYS: String(config.exportRetentionDays), BACKUP_MAX_COUNT: String(config.backupMaxCount) }])
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
    expect(env).toMatchObject({ PGHOST: 'db', PGPASSWORD: p.secrets.POSTGRES_PASSWORD, BACKUP_SUBDIR: `export-${p.ref}`,
      EXPORT_RETENTION_DAYS: String(config.exportRetentionDays), BACKUP_MAX_COUNT: String(config.backupMaxCount) })
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
      { PGHOST: config.dbHost, PGPASSWORD: config.dbPassword, BACKUP_SUBDIR: 'control', BACKUP_RETENTION_DAYS: String(config.backupRetentionDays),
        EXPORT_RETENTION_DAYS: String(config.exportRetentionDays), BACKUP_MAX_COUNT: String(config.backupMaxCount) }])
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

  // the provisioner refuses to rebuild an old network while a job container is still on it (R1/R6): that passes
  const busy = () => new ProvisionerError('network_busy', 'sb-x-job is on sb-x; retry when it is gone', 409)
  const retries = async (id: string) => (await pool.query(`select count(*)::int as n from control.job_events where job_id = $1
    and status = 'retry'`, [id])).rows[0].n

  test('I3: 409 network_busy from ensure is retried, and the job goes on once the network is free', async () => {
    const p = await slotted({ name: 'busy-once', status: 'INACTIVE' })
    let left = 2
    const real = fake.ensure.bind(fake)
    fake.ensure = async (input) => { if (left-- > 0) throw busy(); return real(input) }
    const id = await enqueue(pool, { type: 'project.restore', projectId: p.id, payload: {}, createdBy: null })
    workers()
    expect((await finished(id)).status).toBe('succeeded')
    expect(await retries(id)).toBe(2)
    expect(fake.callsOf('ensure')).toHaveLength(1)
  })

  test('I3: network_busy on every try fails the job after the bounded retries, saying why; never a success', async () => {
    const restore = await slotted({ name: 'busy-restore', status: 'INACTIVE' })
    const applied = await slotted({ name: 'busy-apply' })
    fake.ensure = async () => { throw busy() }
    const ids = [await enqueue(pool, { type: 'project.restore', projectId: restore.id, payload: {}, createdBy: null }),
      await enqueue(pool, { type: 'project.apply', projectId: applied.id, payload: {}, createdBy: null })]
    workers()
    for (const id of ids) {
      const job = await finished(id)
      expect(job).toMatchObject({ status: 'failed', attempts: 3 })
      expect(job.error).toMatch(/sb-x-job is on sb-x; retry when it is gone/)
    }
    expect((await row(restore.id)).status).toBe('RESTORE_FAILED')
    expect((await row(applied.id)).status).toBe('ACTIVE_UNHEALTHY')
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

  test('I1: with rotate_keys no core starts before the restore job ended the sessions; then a plain start with the stored keys', async () => {
    const order: string[] = []
    const saved = { ensure: fake.ensure, start: fake.start, runJob: fake.runJob, jobStatus: fake.jobStatus }
    let polls = 0
    adminSeen.length = 0
    // a digest of the secret: never the value in a failure message
    const tag = (secret: string) => `ensure:${createHash('sha256').update(secret).digest('hex').slice(0, 8)}`
    fake.ensure = async (input) => { order.push(tag(input.env.JWT_SECRET)); return saved.ensure.call(fake, input) }
    fake.start = async (ref, services) => { order.push('start'); return saved.start.call(fake, ref, services) }
    fake.runJob = async (ref, type, args, env) => { order.push(`job:${type}:${env.ROTATE_KEYS ?? '-'}`); return saved.runJob.call(fake, ref, type, args, env) }
    // the restore runs for two polls, then succeeds
    fake.jobStatus = async (ref, type) => {
      await saved.jobStatus.call(fake, ref, type)
      const done = ++polls > 2
      order.push(done ? 'restored' : 'restoring')
      return done ? { status: 'succeeded', exitCode: 0, tail: ROTATED_TAIL } : { status: 'running', exitCode: null, tail: '' }
    }
    try {
      const res = await postForm(owner.token, form({ ...importFields({ name: 'rot-window' }), env_file: envBlob(v1Env().text), rotate_keys: 'true' }))
      expect(res.status).toBe(202)
      const out = await res.json()
      workers()
      expect((await finished(out.job_id)).status).toBe('succeeded')
      const p = (await pool.query('select * from control.projects where ref = $1', [out.project.ref])).rows[0]
      const stored = tag((await getSecrets(pool, p)).JWT_SECRET)
      // the empty project comes up with the stored keys, the restore job deletes the sessions, then the plain start
      expect(order).toEqual([stored, 'job:restore:1', 'restoring', 'restoring', 'restored', 'start'])
      expect(adminSeen.filter((r) => r.url === '/admin/sql')).toEqual([])
    } finally {
      Object.assign(fake, saved)
    }
  })

  test('I1: a rotating restore that could not delete the sessions (exit 5) never starts the project', async () => {
    fake.jobResult = () => ({ status: 'failed', exitCode: 5, tail: 'restore: FAILED: the DATABASE WAS RESTORED' })
    const out = await (await postForm(owner.token, form({ ...importFields({ name: 'rot-kept' }), env_file: envBlob(v1Env().text),
      rotate_keys: 'true' }))).json()
    workers()
    const job = await finished(out.job_id)
    expect(job).toMatchObject({ status: 'failed', error: expect.stringMatching(/sessions .*could not be deleted.*delete this project, then import again/) })
    expect(fake.callsOf('start')).toEqual([])
  })

  test('I1: a rotating restore whose job does not confirm the deletes (an older job image) never starts the project', async () => {
    const out = await (await postForm(owner.token, form({ ...importFields({ name: 'rot-old-image' }), env_file: envBlob(v1Env().text),
      rotate_keys: 'true' }))).json()
    workers()
    const job = await finished(out.job_id)
    expect(job).toMatchObject({ status: 'failed', error: expect.stringMatching(/did not confirm .*sessions.*delete this project, then import again/) })
    expect(fake.callsOf('start')).toEqual([])
  })

  test('I1: an import an earlier control left in flight after its restore (the old rekey steps) fails instead of starting', async () => {
    const p = await project(acme.id, { name: 'rot-inflight', status: 'RESTORING' })
    // the old job had 16 steps: at index 8 it had started core on the throwaway secret and was waiting for it ('started')
    const id = (await pool.query(`insert into control.jobs (type, lane, project_id, step, status, payload)
      values ('project.import', 'heavy', $1, '8', 'running', $2) returning id`, [p.id, { backup_dir: 'import/acme/v1-dump', rotate_keys: true }])).rows[0].id
    workers()
    expect(await finished(id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/earlier version of control.*delete this project, then import again/) })
    expect(fake.calls.filter((c) => ['ensure', 'start'].includes(c.method))).toEqual([])
    expect((await row(p.id)).status).toBe('INIT_FAILED')
  })

  // review Important 1: the job record, not the job's error message, decides whether a rotating import may start
  const pauseRestore = async (ref: string) => {
    const paused = await finished((await (await withToken(owner.token, 'POST', `/platform/projects/${ref}/pause`)).json()).job_id)
    expect(paused.status).toBe('succeeded')
    const r = await withToken(owner.token, 'POST', `/platform/projects/${ref}/restore`)
    expect(r.status).toBe(202)
    return finished((await r.json()).job_id)
  }

  test('R1: a rotating import that failed before its sessions were confirmed deleted: pause then restore is refused and starts nothing', async () => {
    fake.jobResult = () => ({ status: 'failed', exitCode: 5, tail: 'restore: FAILED: the DATABASE WAS RESTORED' })
    const out = await (await postForm(owner.token, form({ ...importFields({ name: 'rot-reopen' }), env_file: envBlob(v1Env().text),
      rotate_keys: 'true' }))).json()
    workers()
    expect((await finished(out.job_id)).status).toBe('failed')
    const p = (await pool.query('select * from control.projects where ref = $1', [out.project.ref])).rows[0]
    expect(p.status).toBe('INIT_FAILED')
    const ensures = fake.callsOf('ensure').length
    expect(await pauseRestore(p.ref)).toMatchObject({ status: 'failed',
      error: expect.stringMatching(/rotate_keys.*sessions.*delete this project, then import again/) })
    expect(fake.callsOf('ensure').length).toBe(ensures)
    expect(fake.callsOf('start')).toEqual([])
    expect((await row(p.id)).status).toBe('RESTORE_FAILED')
  })

  test('R1: a rotating import that failed after its sessions were confirmed deleted may be paused and restored', async () => {
    fake.jobResult = () => ({ status: 'succeeded', exitCode: 0, tail: ROTATED_TAIL })
    fake.fail('start', 3)
    const out = await (await postForm(owner.token, form({ ...importFields({ name: 'rot-reopen-ok' }), env_file: envBlob(v1Env().text),
      rotate_keys: 'true' }))).json()
    workers()
    expect(await finished(out.job_id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/fake start failure/) })
    const ensures = fake.callsOf('ensure').length
    expect((await pauseRestore(out.project.ref)).status).toBe('succeeded')
    expect(fake.callsOf('ensure').length).toBe(ensures + 1)
  })

  test('FR2: a plain import whose env file carries no JWT secret gets new keys, so its restore deletes the sessions too', async () => {
    const text = v1Env().text.split('\n').filter((l) => !/^(JWT_SECRET|ANON_KEY|SERVICE_ROLE_KEY)=/.test(l)).join('\n')
    fake.jobResult = () => ({ status: 'succeeded', exitCode: 0, tail: ROTATED_TAIL })
    const res = await postForm(owner.token, form({ ...importFields({ name: 'fresh-keys' }), env_file: envBlob(text) }))
    expect(res.status).toBe(202)
    const out = await res.json()
    workers()
    expect((await finished(out.job_id)).status).toBe('succeeded')
    expect(fake.callsOf('runJob').find((c) => c.args[1] === 'restore')?.args[3].ROTATE_KEYS).toBe('1')
    expect((await pool.query('select payload from control.jobs where id = $1', [out.job_id])).rows[0].payload.rotate_keys).toBe(true)
  })

  test('FR2: a plain import that carries its keys stays plain (no ROTATE_KEYS)', async () => {
    const out = await (await postForm(owner.token, form({ ...importFields({ name: 'kept-keys' }), env_file: envBlob(v1Env().text) }))).json()
    workers()
    expect((await finished(out.job_id)).status).toBe('succeeded')
    expect(fake.callsOf('runJob').find((c) => c.args[1] === 'restore')?.args[3].ROTATE_KEYS).toBeUndefined()
  })

  test('R1: an import an earlier control left in flight fails with core, rest, fn and pooler stopped (it may have started core on the throwaway secret)', async () => {
    const p = await project(acme.id, { name: 'rot-inflight-stop', status: 'RESTORING' })
    const id = (await pool.query(`insert into control.jobs (type, lane, project_id, step, status, payload)
      values ('project.import', 'heavy', $1, '8', 'running', $2) returning id`, [p.id, { backup_dir: 'import/acme/v1-dump', rotate_keys: true }])).rows[0].id
    workers()
    expect((await finished(id)).status).toBe('failed')
    expect(fake.callsOf('stop').map((c) => c.args)).toEqual([[p.ref, ['core', 'rest', 'fn', 'pooler']]])
    expect(fake.calls.filter((c) => ['ensure', 'start'].includes(c.method))).toEqual([])
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

describe('I2: backups are sized in the job, from what the dump reads', () => {
  const GiB = 2 ** 30
  afterEach(() => {
    vi.restoreAllMocks()
    hung.on = false
    for (const r of hung.held.splice(0)) r.destroy()
  })
  const lastSize = (projectId: string, bytes: number) => pool.query(`insert into control.backups (project_id, kind, status, started_at,
    finished_at, size_bytes, location) values ($1, 'logical', 'succeeded', now(), now(), $2, 'x/20261122-031500')`, [projectId, bytes])

  test('zeroed, negative or missing storage metadata never lowers the size below the database', async () => {
    const c = await pool.connect()
    try {
      await c.query('begin')
      await c.query(`insert into storage.buckets (id, name) values ('i2', 'i2')`)
      await c.query(`insert into storage.objects (bucket_id, name, metadata) values ('i2', 'neg', '{"size": -1000000000000000}'),
        ('i2', 'zero', '{"size": 0}'), ('i2', 'none', '{}'), ('i2', 'real', '{"size": 5}')`)
      const [size, db] = (await c.query(`select (${SIZE_SQL})::bigint as size, pg_database_size(current_database()) as db`)).rows.map((r) => [Number(r.size), Number(r.db)])[0]
      expect(size).toBe(db + 5)
    } finally {
      await c.query('rollback')
      c.release()
    }
  })

  test('D: the size query pins search_path to pg_catalog: a shadowed pg_database_size cannot zero it', async () => {
    const p = await project(acme.id, { name: 'd-shadow' })
    adminSeen.length = 0
    await disk.projectBytes(p)
    const q = JSON.parse(adminSeen.at(-1)!.body).query as string
    const c = await pool.connect()
    try {
      await c.query('begin')
      await c.query(`create function public.pg_database_size(name) returns bigint language sql as 'select 0::bigint'`)
      // as a role or database setting would: public first, pg_catalog named after it
      await c.query(`set local search_path = public, pg_catalog`)
      const res = await c.query(q)
      const last = Array.isArray(res) ? res.at(-1)! : res
      const real = Number((await c.query('select pg_catalog.pg_database_size(pg_catalog.current_database()) as n')).rows[0].n)
      expect(Number(Object.values(last.rows[0])[0])).toBeGreaterThanOrEqual(real)
    } finally {
      await c.query('rollback')
      c.release()
    }
  })

  test('D: a size answer that is not 1 to 18 digits is an error, never a size', async () => {
    const p = await project(acme.id, { name: 'd-digits' })
    try {
      for (const bad of ['1' + '0'.repeat(24), '-5000000000', '1e3', '']) {
        sizeAnswer = bad
        await expect(disk.projectBytes(p)).rejects.toThrow(/size could not be read/)
      }
      sizeAnswer = '999999999999999999'
      expect(await disk.projectBytes(p)).toBe(999999999999999999)
    } finally {
      sizeAnswer = '1000'
    }
  })

  test('a project whose core is down is admitted with its last known size; refused only when no size is known', async () => {
    const p = await project(acme.id, { name: 'i2-down', status: 'ACTIVE_UNHEALTHY' })
    vi.spyOn(disk, 'space').mockResolvedValue({ free: 20 * GiB, total: 100 * GiB })
    vi.spyOn(disk, 'projectBytes').mockRejectedValue(new Error('core down'))
    const none = await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)
    expect(none.status).toBe(503)
    expect(await none.json()).toMatchObject({ error: 'project_size_unknown' })
    // the newest succeeded backup's size stands in: too big for the headroom, then small enough
    await lastSize(p.id, 12 * GiB)
    expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).status).toBe(507)
    await lastSize(p.id, 1 * GiB)
    expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).status).toBe(202)
  })

  test('the nightly run sizes each project with a short timeout; a hung core neither stalls the others nor loses its backup', async () => {
    await pool.query(`delete from control.jobs where type in ('project.backup', 'control.backup')`)
    await pool.query(`update control.projects set status = 'REMOVED' where status = any($1)`, [['ACTIVE_HEALTHY', 'ACTIVE_UNHEALTHY', 'COMING_UP']])
    const known = await project(acme.id, { name: 'i2-night-known' })
    const unknown = await project(acme.id, { name: 'i2-night-unknown' })
    await lastSize(known.id, 1 * GiB)
    vi.spyOn(disk, 'space').mockResolvedValue({ free: 20 * GiB, total: 100 * GiB })
    hung.on = true
    const ms = disk.sizeMs
    disk.sizeMs = 200
    try {
      const t = Date.now()
      await enqueueDailyBackups(pool)
      expect(Date.now() - t).toBeLessThan(5000)
    } finally {
      disk.sizeMs = ms
    }
    const jobOf = async (id: string) => (await pool.query(`select status, error from control.jobs where project_id = $1 and type = 'project.backup'`, [id])).rows
    expect(await jobOf(known.id)).toEqual([{ status: 'pending', error: null }])
    expect(await jobOf(unknown.id)).toEqual([{ status: 'failed', error: expect.stringMatching(/size could not be read/) }])
  })

  test('the job refusing for space (exit 4) fails as backup_volume_full with the numbers', async () => {
    const p = await project(acme.id, { name: 'i2-refused' })
    fake.jobResult = () => ({ status: 'failed', exitCode: 4,
      tail: 'backup: REFUSED: 900 MiB free on the backup volume, at least 100 MiB (BACKUP_MIN_FREE_MIB) needed after this backup of up to 850 MiB; free space first\n' })
    const { job_id } = await (await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).json()
    workers()
    const job = await finished(job_id)
    expect(job).toMatchObject({ status: 'failed', attempts: 1 })
    expect(job.error).toBe('backup_volume_full: the backup volume has 900 MiB free; this backup needs up to 850 MiB and 100 MiB '
      + '(BACKUP_MIN_FREE_MIB) must stay free. Remove old backups or exports, or grow the volume, then try again.')
    expect((await row(p.id)).status).toBe('ACTIVE_HEALTHY')
  })

  test("BACKUP_MIN_FREE_MIB, the jobs' floor, is control's floor too", async () => {
    const p = await project(acme.id, { name: 'i2-floor' })
    vi.spyOn(disk, 'space').mockResolvedValue({ free: 1 * GiB, total: 4 * GiB })
    vi.spyOn(disk, 'projectBytes').mockResolvedValue(0.5 * GiB)
    expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).status).toBe(507)
    const saved = config.backupMinFreeMib
    config.backupMinFreeMib = 100
    try {
      expect((await withToken(owner.token, 'POST', `/platform/projects/${p.ref}/backups`)).status).toBe(202)
    } finally {
      config.backupMinFreeMib = saved
    }
  })
})

describe("I3: exports past their window leave the disk, a deleted project's too", () => {
  const stamp = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const exportDir = (ref: string, ts: string) => mkdirSync(joinPath(dir, `export-${ref}`, ts), { recursive: true })
  afterEach(async () => { await pool.query(`delete from control.jobs where type = 'project.prune'`) })

  test('the nightly prune queues a prune-only job for each project with an expired export, any status', async () => {
    const gone = await project(acme.id, { name: 'prune-gone', status: 'REMOVED' })
    const stale = await project(acme.id, { name: 'prune-stale' })
    const fresh = await project(acme.id, { name: 'prune-fresh' })
    const none = await project(acme.id, { name: 'prune-none', status: 'REMOVED' })
    exportDir(gone.ref, stamp(30))
    exportDir(gone.ref, stamp(1))
    exportDir(stale.ref, stamp(config.exportRetentionDays + 1))
    exportDir(fresh.ref, stamp(1))
    await enqueueExportPrunes(pool)
    // a second night while they are queued: nothing twice
    await enqueueExportPrunes(pool)
    const jobs = (await pool.query(`select project_id from control.jobs where type = 'project.prune'`)).rows.map((r) => r.project_id)
    expect(jobs.sort()).toEqual([gone.id, stale.id].sort())
    expect(jobs).not.toContain(fresh.id)
    expect(jobs).not.toContain(none.id)
  })

  test('the job prunes export-<ref> only, with the retention settings, and drops the rows of what it deleted', async () => {
    const gone = await project(acme.id, { name: 'prune-run', status: 'REMOVED' })
    const old = `export-${gone.ref}/${stamp(30)}`
    const kept = `export-${gone.ref}/${stamp(1)}`
    for (const location of [old, kept]) {
      await pool.query(`insert into control.backups (project_id, kind, status, started_at, finished_at, location)
        values ($1, 'logical', 'succeeded', now(), now(), $2)`, [gone.id, location])
    }
    fake.jobResult = (ref) => ({ status: 'succeeded', exitCode: 0, tail: `backup: deleted ${old} (older than 7 days)\nbackup: pruned export-${ref}\n` })
    const id = await enqueue(pool, { type: 'project.prune', projectId: gone.id, payload: {}, createdBy: null })
    workers()
    expect((await finished(id)).status).toBe('succeeded')
    // no database password: the job reaches no database
    expect(fake.callsOf('runJob')[0].args).toEqual([gone.ref, 'backup', {}, { BACKUP_SUBDIR: `export-${gone.ref}`, BACKUP_PRUNE_ONLY: '1',
      BACKUP_RETENTION_DAYS: String(config.backupRetentionDays), EXPORT_RETENTION_DAYS: String(config.exportRetentionDays),
      BACKUP_MAX_COUNT: String(config.backupMaxCount) }])
    expect((await pool.query('select location from control.backups where project_id = $1', [gone.id])).rows).toEqual([{ location: kept }])
  })

  test("another job's result is never taken for the prune's", async () => {
    const gone = await project(acme.id, { name: 'prune-crossed', status: 'REMOVED' })
    fake.jobResult = (ref) => ({ status: 'succeeded', exitCode: 0, tail: `backup: size 7 bytes\nbackup: wrote ${ref}/20261122-031500\n` })
    const id = await enqueue(pool, { type: 'project.prune', projectId: gone.id, payload: {}, createdBy: null })
    workers()
    const job = await finished(id)
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/did not confirm/)
  })
})
