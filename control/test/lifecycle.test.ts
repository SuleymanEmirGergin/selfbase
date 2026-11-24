import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { config } from '../src/config.ts'
import { pool } from '../src/db.ts'
import { newRef } from '../src/ids.ts'
import { addDomain, removeDomain } from '../src/hosts.ts'
import { createProject, enqueue, evictStaleLegacyNames, startWorkers } from '../src/jobs/index.ts'
import { probeCertificate } from '../src/cert.ts'
import { AdmissionError } from '../src/admission.ts'
import { getSecrets } from '../src/secrets.ts'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FakeProvisioner, SERVICES } from './fake-provisioner.ts'

// template/sizes.json is Task 5's; the global constraints' table stands in for it
vi.mock('../src/sizes.ts', async (orig) => {
  const SIZES = {
    micro: { db: { mem_mb: 512 }, rest: { mem_mb: 128 }, core: { mem_mb: 256 }, fn: { mem_mb: 256 }, pooler: { mem_mb: 32 } },
    small: { db: { mem_mb: 1024 }, rest: { mem_mb: 256 }, core: { mem_mb: 512 }, fn: { mem_mb: 512 }, pooler: { mem_mb: 32 } },
    medium: { db: { mem_mb: 2048 }, rest: { mem_mb: 256 }, core: { mem_mb: 512 }, fn: { mem_mb: 1024 }, pooler: { mem_mb: 32 } },
  }
  const real = await orig<typeof import('../src/sizes.ts')>()
  return { projectCapMb: (size: string, sizes: any = SIZES) => real.projectCapMb(size, sizes) }
})

// the names Task 5's template reads from a project's env (REGISTRY, TEMPLATE_VERSION and the size values are the
// provisioner's)
const TASK5_KEYS = ['POSTGRES_PASSWORD', 'AUTHENTICATOR_PASSWORD', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'ADMIN_TOKEN',
  'PROJECT_REF', 'PUBLIC_URL', 'SITE_URL', 'PGRST_DB_SCHEMAS', 'PGRST_DB_MAX_ROWS', 'AUTH_REDIRECT_ALLOWLIST', 'AUTH_CONFIRM_EMAIL',
  'AUTH_SECURE_EMAIL_CHANGE', 'AUTH_REFRESH_REUSE_INTERVAL', 'AUTH_SET_PASSWORD_URL', 'AUTH_RATE_LIMIT_SIGN_IN',
  'AUTH_RATE_LIMIT_VERIFY', 'AUTH_RATE_LIMIT_REFRESH', 'AUTH_RATE_LIMIT_EMAIL', 'AUTH_PHONE_ENABLED', 'AUTH_MIN_PASSWORD',
  'AUTH_OTP_EXPIRY', 'AUTH_EMAIL_INTERVAL', 'AUTH_SMS_HOOK_SECRET', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL', 'GOOGLE_USERINFO_URL',
  'STORAGE_MAX_UPLOAD_BYTES', 'FN_IMPORT_TIMEOUT_MS']

let fake: FakeProvisioner
let cert: 'ok' | 'pending'
let orgId: string
let orgSlug: string
const running: { stop(): Promise<void> }[] = []
// stands in for every project's core: records the warm-up requests, answers restStatus
let restStatus = 200
const warmed: { url: string; apikey: string; authorization: string }[] = []
const stub = createServer((req, res) => {
  warmed.push({ url: req.url ?? '', apikey: String(req.headers.apikey), authorization: String(req.headers.authorization) })
  res.writeHead(restStatus).end('{}')
})
const workers = () => {
  const port = (stub.address() as AddressInfo).port
  const w = startWorkers({ db: pool, provisioner: fake, backoffMs: 1, idleMs: 20, probe: async () => cert,
    coreUrl: (ref) => `http://127.0.0.1:${port}/${ref}`, waits: { pollMs: 10, healthyMs: 2000, certificateMs: 300, warmMs: 200 } })
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
const project = async (id: string) => (await pool.query('select * from control.projects where id = $1', [id])).rows[0]
const create = (name = 'p') => createProject(pool, { orgId, name, size: 'micro', pool: 'project', createdBy: null })
const fill = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await pool.query(`insert into control.projects (ref, org_id, name, status, size, subnet) values ($1, $2, 'filler', 'ACTIVE_HEALTHY', 'micro', $3)`,
      [newRef(), orgId, `10.207.${200 + i}.0/27`])
  }
}
const cap = config.maxNewHostsPerWeek

beforeAll(async () => {
  config.maxNewHostsPerWeek = 1000
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
})
afterAll(async () => {
  config.maxNewHostsPerWeek = cap
  await new Promise((r) => stub.close(r))
})
beforeEach(async () => {
  restStatus = 200
  warmed.length = 0
  await pool.query('delete from control.projects')
  await pool.query('delete from control.host_slots')
  // a custom name keeps the org that claimed it (S2): every test starts with none
  await pool.query('delete from control.issued_hosts')
  // jobs without a project (other files) are not removed by the cascade
  await pool.query('delete from control.jobs')
  fake = new FakeProvisioner()
  cert = 'ok'
  orgSlug = `o-${newRef()}`
  orgId = (await pool.query(`insert into control.organizations (slug, name) values ($1, 'o') returning id`, [orgSlug])).rows[0].id
})
afterEach(async () => { await Promise.all(running.splice(0).map((w) => w.stop())) })

test('create ends ACTIVE_HEALTHY with a subnet, a default domain, six secrets and one ensure with the full env', async () => {
  const { project: p, jobId } = await create()
  expect(p.status).toBe('COMING_UP')
  workers()
  expect((await finished(jobId)).status).toBe('succeeded')
  const row = await project(p.id)
  expect(row.status).toBe('ACTIVE_HEALTHY')
  expect(row.subnet).toBe('10.207.0.0/27')
  expect((await pool.query('select hostname, kind from control.project_domains where project_id = $1', [p.id])).rows)
    .toEqual([{ hostname: `${p.ref}.example.test`, kind: 'default' }])
  expect((await pool.query('select name from control.project_secrets where project_id = $1 order by name', [p.id])).rows.map((r) => r.name))
    .toEqual(['ADMIN_TOKEN', 'ANON_KEY', 'AUTHENTICATOR_PASSWORD', 'JWT_SECRET', 'POSTGRES_PASSWORD', 'SERVICE_ROLE_KEY'])
  const ensures = fake.callsOf('ensure')
  expect(ensures).toHaveLength(1)
  const input = ensures[0].args[0]
  for (const k of TASK5_KEYS) expect(input.env, k).toHaveProperty(k)
  expect(input).toMatchObject({ ref: p.ref, size: 'micro', subnet: '10.207.0.0/27', templateVersion: 'test', hosts: [`${p.ref}.example.test`] })
  // payloads never carry a secret value
  const payload = JSON.stringify((await pool.query('select payload from control.jobs where id = $1', [jobId])).rows[0])
  for (const k of ['JWT_SECRET', 'POSTGRES_PASSWORD', 'ANON_KEY']) expect(payload).not.toContain(input.env[k])
})

test('a create killed after ensure returned resumes; the network and each container are created once', async () => {
  const { project: p, jobId } = await create()
  // the worker's own connection dies before the ensure step is recorded as done, as if the process was killed
  fake.once('ensure', async () => {
    await pool.query(`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'selfbase-jobs' and pid <> pg_backend_pid()`)
    // pg_terminate_backend only signals: wait until the backend is gone, so the step cannot be recorded first
    await until(async () => (await pool.query(`select 1 from pg_stat_activity where application_name = 'selfbase-jobs'`)).rowCount ? undefined : true)
  })
  workers()
  expect((await finished(jobId)).status).toBe('succeeded')
  expect(fake.callsOf('ensure').length).toBe(2)
  expect(fake.created.networks).toEqual([`sb-${p.ref}`])
  expect(fake.created.containers.sort()).toEqual(SERVICES.map((s) => `sb-${p.ref}-${s}`).sort())
  expect((await project(p.id)).status).toBe('ACTIVE_HEALTHY')
  // allocate and secrets ran before the kill and were not repeated
  const steps = (await pool.query(`select step from control.job_events where job_id = $1 and status = 'succeeded' order by id`, [jobId])).rows
  expect(steps.map((r) => r.step)).toEqual(['allocate', 'secrets', 'ensure', 'healthy', 'warm', 'certificate', 'activate'])
})

test('create over budget throws before any row exists', async () => {
  await fill(11)
  await expect(create('over')).rejects.toBeInstanceOf(AdmissionError)
  expect((await pool.query(`select count(*)::int as n from control.projects where name = 'over'`)).rows[0].n).toBe(0)
  expect((await pool.query(`select count(*)::int as n from control.jobs`)).rows[0].n).toBe(0)
})

test('concurrent creates never pass admission together', async () => {
  await fill(9)
  const results = await Promise.allSettled([create('a'), create('b'), create('c'), create('d')])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
  const subnets = (await pool.query(`select subnet from control.projects where name <> 'filler'`)).rows.map((r) => r.subnet)
  expect(new Set(subnets).size).toBe(2)
})

test('pause then restore', async () => {
  const { project: p, jobId } = await create()
  workers()
  await finished(jobId)
  const pause = await enqueue(pool, { type: 'project.pause', projectId: p.id, payload: {}, createdBy: null })
  expect((await finished(pause)).status).toBe('succeeded')
  let row = await project(p.id)
  expect(row.status).toBe('INACTIVE')
  expect(row.paused_at).toBeInstanceOf(Date)
  expect(fake.state(p.ref).services.every((s) => s.state === 'exited')).toBe(true)
  const restore = await enqueue(pool, { type: 'project.restore', projectId: p.id, payload: {}, createdBy: null })
  expect((await finished(restore)).status).toBe('succeeded')
  row = await project(p.id)
  expect(row.status).toBe('ACTIVE_HEALTHY')
  expect(row.paused_at).toBeNull()
  // restore goes through ensure (which starts stopped containers), so changes made while paused apply
  expect(fake.callsOf('ensure')).toHaveLength(2)
  expect(fake.state(p.ref).services.every((s) => s.state === 'running')).toBe(true)
})

test('a domain removed while paused is gone from the router after restore', async () => {
  const { project: p, jobId } = await create()
  workers()
  await finished(jobId)
  await addDomain(pool, p.id, 'api.example.com', 'custom')
  await finished(await enqueue(pool, { type: 'project.apply', projectId: p.id, payload: { recreate: ['core'] }, createdBy: null }))
  expect(fake.callsOf('ensure').at(-1)!.args[0].hosts).toEqual([`${p.ref}.example.test`, 'api.example.com'])
  expect((await finished(await enqueue(pool, { type: 'project.pause', projectId: p.id, payload: {}, createdBy: null }))).status).toBe('succeeded')
  await removeDomain(pool, p.id, 'api.example.com')
  const before = fake.callsOf('ensure').length
  expect((await finished(await enqueue(pool, { type: 'project.restore', projectId: p.id, payload: {}, createdBy: null }))).status).toBe('succeeded')
  expect(fake.callsOf('ensure')).toHaveLength(before + 1)
  expect(fake.callsOf('ensure').at(-1)!.args[0].hosts).toEqual([`${p.ref}.example.test`])
})

test('restore over budget is refused and the project stays INACTIVE', async () => {
  const { project: p, jobId } = await create()
  workers()
  await finished(jobId)
  await finished(await enqueue(pool, { type: 'project.pause', projectId: p.id, payload: {}, createdBy: null }))
  await fill(11)
  const restore = await enqueue(pool, { type: 'project.restore', projectId: p.id, payload: {}, createdBy: null })
  const j = await finished(restore)
  expect(j.status).toBe('failed')
  expect(j.error).toMatch(/MiB/)
  expect((await project(p.id)).status).toBe('INACTIVE')
  expect(fake.callsOf('start')).toHaveLength(0)
})

test('delete frees the host slot, removes the secrets, removes with volumes; the next project reuses the hostname', async () => {
  const { project: p, jobId } = await create()
  workers()
  await finished(jobId)
  const del = await enqueue(pool, { type: 'project.delete', projectId: p.id, payload: {}, createdBy: null })
  expect((await finished(del)).status).toBe('succeeded')
  expect((await project(p.id)).status).toBe('REMOVED')
  expect(fake.callsOf('remove').map((c) => c.args)).toEqual([[p.ref, true]])
  expect((await pool.query('select count(*)::int as n from control.project_secrets where project_id = $1', [p.id])).rows[0].n).toBe(0)
  expect((await pool.query('select project_id from control.host_slots where hostname = $1', [`${p.ref}.example.test`])).rows)
    .toEqual([{ project_id: null }])
  const next = await create('next')
  await finished(next.jobId)
  expect(fake.callsOf('ensure').at(-1)!.args[0].hosts).toEqual([`${p.ref}.example.test`])
  expect((await pool.query('select count(*)::int as n from control.host_slots')).rows[0].n).toBe(1)
})

test('a certificate stuck on pending keeps the project COMING_UP', async () => {
  cert = 'pending'
  const { project: p, jobId } = await create()
  workers()
  const j = await finished(jobId)
  expect(j.status).toBe('failed')
  expect(j.error).toMatch(/certificate/)
  expect((await project(p.id)).status).toBe('COMING_UP')
})

test('project.apply after addDomain passes both hosts and the recreate list', async () => {
  const { project: p, jobId } = await create()
  workers()
  await finished(jobId)
  await addDomain(pool, p.id, 'api.example.com', 'custom')
  const apply = await enqueue(pool, { type: 'project.apply', projectId: p.id, payload: { recreate: ['core'] }, createdBy: null })
  expect((await finished(apply)).status).toBe('succeeded')
  expect(fake.callsOf('ensure').at(-1)!.args[0]).toMatchObject({ hosts: [`${p.ref}.example.test`, 'api.example.com'], recreate: ['core'] })
})

test('H: at start a legacy name LEGACY_HOSTNAMES now gives another org is removed, applied, and free for that org', async () => {
  const kept = { hostnames: config.legacyHostnames, orgs: config.legacyOrgs }
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    config.legacyHostnames = ['old.example.test', 'mine.example.test']
    config.legacyOrgs = { 'old.example.test': orgSlug, 'mine.example.test': orgSlug }
    const { project: p, jobId } = await create()
    workers()
    await finished(jobId)
    await addDomain(pool, p.id, 'old.example.test', 'legacy')
    await addDomain(pool, p.id, 'mine.example.test', 'legacy')
    await finished(await enqueue(pool, { type: 'project.apply', projectId: p.id, payload: { recreate: ['core'] }, createdBy: null }))
    expect(fake.callsOf('ensure').at(-1)!.args[0].hosts).toContain('old.example.test')
    // the operator rebinds the name to another org and restarts control
    const otherSlug = `o-${newRef()}`
    const other = (await pool.query(`insert into control.organizations (slug, name) values ($1, 'o2') returning id`, [otherSlug])).rows[0].id
    config.legacyOrgs = { 'old.example.test': otherSlug, 'mine.example.test': orgSlug }
    const jobs = await evictStaleLegacyNames(pool)
    expect(jobs).toHaveLength(1)
    expect((await pool.query('select hostname from control.project_domains where project_id = $1', [p.id])).rows
      .map((r) => r.hostname).sort()).toEqual(['mine.example.test', `${p.ref}.example.test`].sort())
    expect(log.mock.calls.flat().join('\n')).toMatch(new RegExp(`old\\.example\\.test.*${p.ref}|${p.ref}.*old\\.example\\.test`))
    expect((await finished(jobs[0])).status).toBe('succeeded')
    expect(fake.callsOf('ensure').at(-1)!.args[0].hosts).toEqual([`${p.ref}.example.test`, 'mine.example.test'])
    // a second start finds nothing to do
    expect(await evictStaleLegacyNames(pool)).toEqual([])
    // the rightful org can now claim it
    const q = await createProject(pool, { orgId: other, name: 'q', size: 'micro', pool: 'project', createdBy: null })
    await finished(q.jobId)
    await addDomain(pool, q.project.id, 'old.example.test', 'legacy')
  } finally {
    config.legacyHostnames = kept.hostnames
    config.legacyOrgs = kept.orgs
    log.mockRestore()
  }
})

// H, fix round 1: a project with old.example.test, added while LEGACY_HOSTNAMES gave it to the project's org
const withLegacy = async (fn: (p: { id: string; ref: string }) => Promise<void>) => {
  const kept = { hostnames: config.legacyHostnames, orgs: config.legacyOrgs }
  const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]
  try {
    config.legacyHostnames = ['old.example.test']
    config.legacyOrgs = { 'old.example.test': orgSlug }
    const { project: p, jobId } = await create()
    workers()
    await finished(jobId)
    await addDomain(pool, p.id, 'old.example.test', 'legacy')
    await fn(p)
  } finally {
    config.legacyHostnames = kept.hostnames
    config.legacyOrgs = kept.orgs
    quiet.forEach((s) => s.mockRestore())
  }
}
const domainsOf = async (id: string) =>
  (await pool.query('select hostname from control.project_domains where project_id = $1 order by hostname', [id])).rows.map((r) => r.hostname)
const newOrg = async () => {
  const slug = `o-${newRef()}`
  return { slug, id: (await pool.query(`insert into control.organizations (slug, name) values ($1, 'o2') returning id`, [slug])).rows[0].id }
}

test('H: an empty or misspelt LEGACY_HOSTNAMES deletes nothing: the name stays and a warning names it', () => withLegacy(async (p) => {
  for (const listed of [[], ['old.exmple.test']]) {
    config.legacyHostnames = listed
    config.legacyOrgs = Object.fromEntries(listed.map((h) => [h, orgSlug]))
    const warn = vi.mocked(console.warn)
    warn.mockClear()
    expect(await evictStaleLegacyNames(pool)).toEqual([])
    expect(await domainsOf(p.id)).toContain('old.example.test')
    expect(warn.mock.calls.flat().join('\n')).toMatch(/old\.example\.test.*LEGACY_HOSTNAMES/)
  }
}))

test('H: a listed name bound to a slug no organization has is kept, with a warning naming the slug', () => withLegacy(async (p) => {
  config.legacyOrgs = { 'old.example.test': 'defualt' }
  const warn = vi.mocked(console.warn)
  warn.mockClear()
  expect(await evictStaleLegacyNames(pool)).toEqual([])
  expect(await domainsOf(p.id)).toContain('old.example.test')
  expect(warn.mock.calls.flat().join('\n')).toMatch(/old\.example\.test.*defualt/)
}))

test('H: a listed name that an issued_hosts row gives the wrong org is evicted, and assertRoutable refuses it first', () => withLegacy(async (p) => {
  // as migrations 0003 and 0005 recorded a v1 name attached before them: issued to the project's own org
  await pool.query(`insert into control.issued_hosts (hostname, org_id) values ('old.example.test', $1) on conflict (hostname) do update set org_id = $1`, [orgId])
  config.legacyOrgs = { 'old.example.test': (await newOrg()).slug }
  const apply = await finished(await enqueue(pool, { type: 'project.apply', projectId: p.id, payload: { recreate: ['core'] }, createdBy: null }))
  expect(apply.status).toBe('failed')
  expect(apply.error).toMatch(/legacy hostname of another organization/)
  expect(await evictStaleLegacyNames(pool)).toHaveLength(1)
  expect(await domainsOf(p.id)).not.toContain('old.example.test')
}))

test('H: the delete and the apply commit together: a failing enqueue keeps the name', () => withLegacy(async (p) => {
  config.legacyOrgs = { 'old.example.test': (await newOrg()).slug }
  await pool.query(`create or replace function public.h_refuse() returns trigger language plpgsql as $$
    begin if new.type = 'project.apply' then raise exception 'enqueue refused by the test'; end if; return new; end $$`)
  await pool.query('create trigger h_refuse before insert on control.jobs for each row execute function public.h_refuse()')
  try {
    await expect(evictStaleLegacyNames(pool)).rejects.toThrow(/enqueue refused by the test/)
  } finally {
    await pool.query('drop trigger if exists h_refuse on control.jobs')
    await pool.query('drop function if exists public.h_refuse()')
  }
  expect(await domainsOf(p.id)).toContain('old.example.test')
  // the next start does it
  expect(await evictStaleLegacyNames(pool)).toHaveLength(1)
  expect(await domainsOf(p.id)).not.toContain('old.example.test')
}))

test('H: until the apply that drops the name succeeds, the rightful org gets hostname_taken (being released)', () => withLegacy(async (p) => {
  const other = await newOrg()
  config.legacyOrgs = { 'old.example.test': other.slug }
  await Promise.all(running.splice(0).map((w) => w.stop()))
  const [job] = await evictStaleLegacyNames(pool)
  const theirs = await createProject(pool, { orgId: other.id, name: 'q', size: 'micro', pool: 'project', createdBy: null })
  await expect(addDomain(pool, theirs.project.id, 'old.example.test', 'legacy'))
    .rejects.toMatchObject({ code: 'hostname_taken', message: expect.stringMatching(/being released/) })
  workers()
  expect((await finished(job)).status).toBe('succeeded')
  expect(fake.callsOf('ensure').some((c) => c.args[0].ref === p.ref && !c.args[0].hosts.includes('old.example.test'))).toBe(true)
  await addDomain(pool, theirs.project.id, 'old.example.test', 'legacy')
}))

test('reused secrets and the db password are stored in the request and never enter the payload', async () => {
  const { project: p, jobId } = await createProject(pool, { orgId, name: 'r', size: 'micro', pool: 'project', createdBy: null,
    dbPass: 'given-db-password-value', reuseSecrets: { SMTP_PASS: 'given-smtp-pass' } })
  const payload = JSON.stringify((await pool.query('select payload from control.jobs where id = $1', [jobId])).rows[0])
  expect(payload).not.toContain('given-')
  workers()
  await finished(jobId)
  const env = fake.callsOf('ensure')[0].args[0].env
  expect(env).toMatchObject({ POSTGRES_PASSWORD: 'given-db-password-value', SMTP_PASS: 'given-smtp-pass', PROJECT_REF: p.ref })
  await expect(createProject(pool, { orgId, name: 'x', size: 'micro', pool: 'project', createdBy: null, reuseSecrets: { JWT_SECRET: 'j' } }))
    .rejects.toMatchObject({ code: 'invalid_secrets' })
})

test('create, restore and upgrade warm PostgREST through core with the service_role key', async () => {
  const { project: p, jobId } = await create()
  workers()
  await finished(jobId)
  const key = (await getSecrets(pool, p)).SERVICE_ROLE_KEY
  expect(warmed).toEqual([{ url: `/${p.ref}/rest/v1/`, apikey: key, authorization: `Bearer ${key}` }])
  await finished(await enqueue(pool, { type: 'project.pause', projectId: p.id, payload: {}, createdBy: null }))
  await finished(await enqueue(pool, { type: 'project.restore', projectId: p.id, payload: {}, createdBy: null }))
  expect((await finished(await enqueue(pool, { type: 'project.upgrade', projectId: p.id, payload: {}, createdBy: null }))).status).toBe('succeeded')
  expect(warmed).toHaveLength(3)
  const steps = (await pool.query(`select j.type, e.step from control.job_events e join control.jobs j on j.id = e.job_id
    where j.project_id = $1 and e.status = 'succeeded' order by e.id`, [p.id])).rows
  for (const t of ['project.create', 'project.restore', 'project.upgrade']) {
    const s = steps.filter((r) => r.type === t).map((r) => r.step)
    expect(s.indexOf('warm'), t).toBe(s.indexOf('healthy') + 1)
    expect(s.indexOf('warm'), t).toBeLessThan(s.indexOf('activate'))
  }
})

test('a warm-up that never gets 200 is logged and the create still succeeds', async () => {
  restStatus = 503
  const { project: p, jobId } = await create()
  workers()
  expect((await finished(jobId)).status).toBe('succeeded')
  expect((await project(p.id)).status).toBe('ACTIVE_HEALTHY')
  expect(warmed.length).toBeGreaterThan(1)
  const logs = (await pool.query(`select step, message from control.job_events where job_id = $1 and status = 'log'`, [jobId])).rows
  expect(logs).toEqual([{ step: 'warm', message: 'warm_failed {"last":"status 503"}' }])
})

test('healthy and certificate fail on their first timeout, without retries', async () => {
  cert = 'pending'
  const { jobId } = await create()
  workers()
  const j = await finished(jobId)
  expect(j).toMatchObject({ status: 'failed', attempts: 1 })
  expect((await pool.query(`select count(*)::int as n from control.job_events where job_id = $1 and status = 'retry'`, [jobId])).rows[0].n).toBe(0)
  fake.health = 'starting'
  const second = await create('slow')
  const k = await finished(second.jobId)
  expect(k).toMatchObject({ status: 'failed', attempts: 1 })
  expect(k.error).toMatch(/not healthy/)
  expect((await project(second.project.id)).status).toBe('INIT_FAILED')
})

test('delete frees legacy and custom domains: the legacy hostname can be added to a new project of the org', async () => {
  const was = config.legacyHostnames
  config.legacyHostnames = ['legacy.example.test']
  config.legacyOrgs = { 'legacy.example.test': orgSlug }
  try {
    const { project: p, jobId } = await create()
    workers()
    await finished(jobId)
    await addDomain(pool, p.id, 'legacy.example.test', 'legacy')
    await addDomain(pool, p.id, 'api.example.com', 'custom')
    await finished(await enqueue(pool, { type: 'project.delete', projectId: p.id, payload: {}, createdBy: null }))
    expect((await pool.query('select count(*)::int as n from control.project_domains where project_id = $1', [p.id])).rows[0].n).toBe(0)
    const next = await create('next')
    await addDomain(pool, next.project.id, 'legacy.example.test', 'legacy')
    await addDomain(pool, next.project.id, 'api.example.com', 'custom')
    // another org's project: the legacy name is not its, the custom name is held for 30 days
    const otherOrg = (await pool.query(`insert into control.organizations (slug, name) values ($1, 'o') returning id`, [`o-${newRef()}`])).rows[0].id
    const theirs = await createProject(pool, { orgId: otherOrg, name: 'theirs', size: 'micro', pool: 'project', createdBy: null })
    await pool.query(`delete from control.project_domains where hostname in ('legacy.example.test', 'api.example.com')`)
    await expect(addDomain(pool, theirs.project.id, 'legacy.example.test', 'legacy')).rejects.toMatchObject({ code: 'legacy_not_allowed' })
    await expect(addDomain(pool, theirs.project.id, 'api.example.com', 'custom')).rejects.toMatchObject({ code: 'hostname_taken' })
  } finally {
    config.legacyHostnames = was
    config.legacyOrgs = {}
  }
})

test('a failed delete ends REMOVE_FAILED, which admission does not count', async () => {
  const { project: p, jobId } = await create()
  workers()
  await finished(jobId)
  fake.fail('remove', 3)
  const j = await finished(await enqueue(pool, { type: 'project.delete', projectId: p.id, payload: {}, createdBy: null }))
  expect(j).toMatchObject({ status: 'failed', attempts: 3 })
  expect((await project(p.id)).status).toBe('REMOVE_FAILED')
  // 10 running fillers + this create = 11 micro, the most that fit: the REMOVE_FAILED one must not count
  await fill(10)
  await expect(create('fits')).resolves.toBeTruthy()
})

test('upgrade refuses when current_template_version is not set', async () => {
  const { project: p, jobId } = await create()
  workers()
  await finished(jobId)
  const was = (await pool.query(`select value from control.settings where key = 'current_template_version'`)).rows[0].value
  await pool.query(`delete from control.settings where key = 'current_template_version'`)
  try {
    const j = await finished(await enqueue(pool, { type: 'project.upgrade', projectId: p.id, payload: {}, createdBy: null }))
    expect(j).toMatchObject({ status: 'failed', attempts: 1 })
    expect(j.error).toMatch(/current_template_version/)
    expect((await project(p.id)).template_version).toBe('test')
  } finally {
    await pool.query(`insert into control.settings (key, value) values ('current_template_version', $1)`, [was])
  }
})

test('probeCertificate: off is always ok; an unresolvable host is pending', async () => {
  const was = config.certProbe
  try {
    config.certProbe = 'off'
    expect(await probeCertificate('nothing.invalid')).toBe('ok')
    config.certProbe = 'on'
    expect(await probeCertificate('nothing.invalid')).toBe('pending')
  } finally {
    config.certProbe = was
  }
})
