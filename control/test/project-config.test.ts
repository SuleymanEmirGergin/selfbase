// GET / PATCH /projects/:ref/config/auth on /v1 and /platform (wave 2 Task 13a): the field table, write-only
// secrets, the core recreate, per-field merges.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { app } from '../src/app.ts'
import { config } from '../src/config.ts'
import { resetRateLimits } from '../src/core.ts'
import { pool } from '../src/db.ts'
import { startWorkers } from '../src/jobs/index.ts'
import { loadProjectEnv, setConfig } from '../src/project-env.ts'
import { setProvisioner } from '../src/provisioner.ts'
import { getSecrets } from '../src/secrets.ts'
import { FakeProvisioner } from './fake-provisioner.ts'
import { join, org, project, resetDashboard, user, withToken } from './helpers.ts'

const doc = JSON.parse(readFileSync(new URL('../../docs/reference/management-api.json', import.meta.url), 'utf8'))
const SCHEMA_FIELDS = Object.keys(doc.components.schemas.AuthConfigResponse_Output.properties)
const OURS = ['site_url', 'uri_allow_list', 'disable_signup', 'mailer_autoconfirm', 'mailer_secure_email_change_enabled',
  'password_min_length', 'mailer_otp_exp', 'smtp_max_frequency', 'refresh_token_rotation_enabled',
  'security_refresh_token_reuse_interval', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_admin_email', 'smtp_pass',
  'external_google_enabled', 'external_google_client_id', 'external_google_secret', 'external_phone_enabled']
// the response schema has no null for these: neutral values instead (spec 7.8)
const NEUTRAL: Record<string, unknown> = { passkey_enabled: false, mfa_phone_otp_length: 0, sms_otp_length: 0, oauth_server_enabled: false,
  oauth_server_allow_dynamic_registration: false, custom_oauth_enabled: false, custom_oauth_max_providers: 0 }
const MOUNTS = ['/v1', '/platform'] as const

const fake = new FakeProvisioner()
let acme: { id: string; slug: string }
let owner: Awaited<ReturnType<typeof user>>
let admin: Awaited<ReturnType<typeof user>>
let dev: Awaited<ReturnType<typeof user>>
let reader: Awaited<ReturnType<typeof user>>
let scoped: Awaited<ReturnType<typeof user>>
let scopedDev: Awaited<ReturnType<typeof user>>
let stranger: Awaited<ReturnType<typeof user>>
let a: Awaited<ReturnType<typeof project>>
let b: Awaited<ReturnType<typeof project>>

const url = (mount: string, ref: string) => `${mount}/projects/${ref}/config/auth`
const get = (token: string, mount: string, ref: string) => withToken(token, 'GET', url(mount, ref))
const patch = (token: string, mount: string, ref: string, body: unknown) => withToken(token, 'PATCH', url(mount, ref), body)
const applies = async (projectId: string) =>
  (await pool.query(`select id, status, payload from control.jobs where project_id = $1 and type = 'project.apply' order by created_at`, [projectId])).rows
const finishJobs = (projectId: string) =>
  pool.query(`update control.jobs set status = 'succeeded' where project_id = $1 and status in ('pending', 'running')`, [projectId])

// every line written to the console or the process streams during a test
let logged: string[] = []
const spies: { mockRestore(): void }[] = []
beforeEach(() => {
  resetRateLimits()
  logged = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    spies.push(vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) }))
  for (const s of [process.stdout, process.stderr]) {
    const write = s.write.bind(s)
    spies.push(vi.spyOn(s, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      logged.push(String(chunk))
      return (write as (...x: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof s.write))
  }
})
afterEach(() => { while (spies.length) spies.pop()!.mockRestore() })

beforeAll(async () => {
  await resetDashboard()
  setProvisioner(fake)
  acme = await org('acme')
  const other = await org('other')
  owner = await user('owner@example.test')
  admin = await user('admin@example.test')
  dev = await user('dev@example.test')
  reader = await user('reader@example.test')
  scoped = await user('scoped@example.test')
  scopedDev = await user('scoped-dev@example.test')
  stranger = await user('stranger@example.test')
  a = await project(acme.id, { name: 'a' })
  b = await project(acme.id, { name: 'b' })
  await join(acme.id, owner.id, 'owner')
  await join(acme.id, admin.id, 'administrator')
  await join(acme.id, dev.id, 'developer')
  await join(acme.id, reader.id, 'read_only')
  // memberships on project a only
  await join(acme.id, scoped.id, 'administrator', a.id)
  await join(acme.id, scopedDev.id, 'developer', a.id)
  await join(other.id, stranger.id, 'owner')
  fake.running(a.ref, 'test')
  fake.running(b.ref, 'test')
})
afterAll(async () => {
  await pool.query(`delete from control.project_config where project_id in ($1, $2)`, [a.id, b.id])
})

describe.each(MOUNTS)('%s/projects/:ref/config/auth', (mount) => {
  let p: Awaited<ReturnType<typeof project>>
  beforeAll(async () => {
    p = await project(acme.id)
    fake.running(p.ref, 'test')
  })

  test('GET has every field of the response schema: ours from the stored config, the rest null, the secrets null', async () => {
    const res = await get(admin.token, mount, p.ref)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual([...SCHEMA_FIELDS].sort())
    for (const k of SCHEMA_FIELDS) if (!OURS.includes(k)) expect(body[k], k).toBe(k in NEUTRAL ? NEUTRAL[k] : null)
    expect(body).toMatchObject({
      site_url: `https://${p.ref}.${config.baseDomain}`, uri_allow_list: '', disable_signup: false, mailer_autoconfirm: false,
      mailer_secure_email_change_enabled: true, password_min_length: 6, mailer_otp_exp: 3600, smtp_max_frequency: 60,
      refresh_token_rotation_enabled: true, security_refresh_token_reuse_interval: 10, smtp_host: '', smtp_port: '', smtp_user: '',
      smtp_admin_email: '', smtp_pass: null, external_google_enabled: false, external_google_client_id: '', external_google_secret: null,
      external_phone_enabled: false,
    })
  })

  test('a Google client id and secret: the id in project_config, the secret encrypted, the raw secret nowhere else', async () => {
    const secret = `test-google-secret-${randomUUID()}`
    const id = `${randomUUID()}.apps.example.test`
    const res = await patch(owner.token, mount, p.ref, { external_google_client_id: id, external_google_secret: secret })
    const text = await res.text()
    expect(res.status, text).toBe(200)
    expect(text).not.toContain(secret)
    expect(JSON.parse(text)).toMatchObject({ external_google_client_id: id, external_google_enabled: true, external_google_secret: null })

    const cfg = (await pool.query(`select section, data from control.project_config where project_id = $1`, [p.id])).rows
    expect(cfg).toEqual([{ section: 'auth', data: { GOOGLE_CLIENT_ID: id } }])
    const raw = (await pool.query(`select ciphertext from control.project_secrets where project_id = $1 and name = 'GOOGLE_CLIENT_SECRET'`, [p.id])).rows
    expect(raw).toHaveLength(1)
    expect(raw[0].ciphertext.includes(Buffer.from(secret))).toBe(false)
    expect((await getSecrets(pool, p)).GOOGLE_CLIENT_SECRET).toBe(secret)

    const everywhere = [
      (await pool.query(`select coalesce(string_agg(row_to_json(c)::text, ''), '') as t from control.project_config c`)).rows[0].t,
      (await pool.query(`select coalesce(string_agg(row_to_json(a)::text, ''), '') as t from control.audit_log a`)).rows[0].t,
      (await pool.query(`select coalesce(string_agg(row_to_json(j)::text, ''), '') as t from control.jobs j`)).rows[0].t,
      (await pool.query(`select coalesce(string_agg(row_to_json(e)::text, ''), '') as t from control.job_events e`)).rows[0].t,
      logged.join('\n'),
    ]
    for (const t of everywhere) expect(t).not.toContain(secret)
    // the audit row names the fields, never the values
    const row = (await pool.query(`select action, target, details from control.audit_log where project_id = $1 order by at desc limit 1`, [p.id])).rows[0]
    expect(row).toMatchObject({ action: `PATCH ${mount}/projects/:ref/config/auth`, target: p.ref })
    expect(row.details.body_keys.sort()).toEqual(['external_google_client_id', 'external_google_secret'])
    expect(JSON.stringify(row)).not.toContain(id)

    const after = await (await get(reader.token, mount, p.ref)).json()
    expect(after).toMatchObject({ external_google_client_id: id, external_google_enabled: true, external_google_secret: null })

    // what the containers get
    const { env } = await loadProjectEnv(pool, p)
    expect(env.GOOGLE_CLIENT_ID).toBe(id)
    expect(env.GOOGLE_CLIENT_SECRET).toBe(secret)
  })

  test('an empty secret clears it; GET still says null', async () => {
    expect((await patch(owner.token, mount, p.ref, { smtp_pass: 'test-smtp-pass-1' })).status).toBe(200)
    expect((await getSecrets(pool, p)).SMTP_PASS).toBe('test-smtp-pass-1')
    expect((await patch(owner.token, mount, p.ref, { smtp_pass: '', external_google_secret: '' })).status).toBe(200)
    const s = await getSecrets(pool, p)
    expect(s).not.toHaveProperty('SMTP_PASS')
    expect(s).not.toHaveProperty('GOOGLE_CLIENT_SECRET')
    expect((await loadProjectEnv(pool, p)).env.SMTP_PASS).toBe('')
    expect((await (await get(owner.token, mount, p.ref)).json()).smtp_pass).toBeNull()
  })

  test('the other fields map to their env names, typed back on GET', async () => {
    const res = await patch(admin.token, mount, p.ref, {
      site_url: 'https://app.example.test', uri_allow_list: 'https://app.example.test/**,http://localhost:5173/**', disable_signup: true,
      mailer_autoconfirm: true, mailer_secure_email_change_enabled: false, password_min_length: 10, mailer_otp_exp: 600,
      smtp_max_frequency: 30, refresh_token_rotation_enabled: true, security_refresh_token_reuse_interval: 0, smtp_host: 'smtp.example.test',
      smtp_port: '465', smtp_user: 'mailer', smtp_admin_email: 'no-reply@example.test', external_phone_enabled: true,
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const data = (await pool.query(`select data from control.project_config where project_id = $1 and section = 'auth'`, [p.id])).rows[0].data
    expect(data).toMatchObject({
      SITE_URL: 'https://app.example.test', AUTH_REDIRECT_ALLOWLIST: 'https://app.example.test/**,http://localhost:5173/**',
      AUTH_DISABLE_SIGNUP: 'true', AUTH_CONFIRM_EMAIL: 'false', AUTH_SECURE_EMAIL_CHANGE: 'false', AUTH_MIN_PASSWORD: '10',
      AUTH_OTP_EXPIRY: '600', AUTH_EMAIL_INTERVAL: '30', AUTH_REFRESH_REUSE_INTERVAL: '0', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465',
      SMTP_USER: 'mailer', SMTP_FROM: 'no-reply@example.test', AUTH_PHONE_ENABLED: 'true',
    })
    expect(await (await get(admin.token, mount, p.ref)).json()).toMatchObject({
      site_url: 'https://app.example.test', disable_signup: true, mailer_autoconfirm: true, mailer_secure_email_change_enabled: false,
      password_min_length: 10, mailer_otp_exp: 600, smtp_max_frequency: 30, security_refresh_token_reuse_interval: 0, smtp_port: '465',
      smtp_admin_email: 'no-reply@example.test', external_phone_enabled: true,
    })
    // null puts a field back to its default
    expect((await patch(admin.token, mount, p.ref, { password_min_length: null, site_url: null })).status).toBe(200)
    expect(await (await get(reader.token, mount, p.ref)).json())
      .toMatchObject({ password_min_length: 6, site_url: `https://${p.ref}.${config.baseDomain}`, disable_signup: true })
  })

  test('I-1: with a stored smtp_pass, a new smtp_host or smtp_user needs smtp_pass in the same body; the port alone does not', async () => {
    const q = await project(acme.id)
    const cfg = async () => (await pool.query(`select data from control.project_config where project_id = $1 and section = 'auth'`, [q.id])).rows[0]?.data
    expect((await patch(owner.token, mount, q.ref, { smtp_host: 'smtp.one.example.test', smtp_user: 'u1', smtp_pass: 'test-pass-1' })).status).toBe(200)
    const stored = await cfg()
    for (const change of [{ smtp_host: 'smtp.other.example.test' }, { smtp_user: 'u2' }, { smtp_host: 'smtp.other.example.test', smtp_user: 'u1' }]) {
      const res = await patch(owner.token, mount, q.ref, { ...change, smtp_port: '2525' })
      expect(res.status, JSON.stringify(change)).toBe(400)
      expect((await res.json()).error).toBe('smtp_pass_required')
      expect(await cfg()).toEqual(stored)
    }
    expect((await getSecrets(pool, q)).SMTP_PASS).toBe('test-pass-1')
    // the same host and user, or the port alone: no password needed
    expect((await patch(owner.token, mount, q.ref, { smtp_host: 'smtp.one.example.test', smtp_user: 'u1' })).status).toBe(200)
    expect((await patch(owner.token, mount, q.ref, { smtp_port: '2525' })).status).toBe(200)
    // a new host with its password
    expect((await patch(owner.token, mount, q.ref, { smtp_host: 'smtp.two.example.test', smtp_pass: 'test-pass-2' })).status).toBe(200)
    expect((await getSecrets(pool, q)).SMTP_PASS).toBe('test-pass-2')
    // or with the stored password cleared: nothing is left to send anywhere
    expect((await patch(owner.token, mount, q.ref, { smtp_host: 'smtp.three.example.test', smtp_pass: '' })).status).toBe(200)
    expect(await getSecrets(pool, q)).not.toHaveProperty('SMTP_PASS')
  })

  test('I-3: during a delete a PATCH is 409 project_busy and leaves no secret or config on the removed project', async () => {
    for (const status of ['pending', 'running']) {
      const q = await project(acme.id)
      await pool.query(`insert into control.jobs (type, project_id, lane, step, payload, status) values ('project.delete', $1, 'light', '2', '{}', $2)`,
        [q.id, status])
      // the delete's secrets step has run
      await pool.query(`delete from control.project_secrets where project_id = $1`, [q.id])
      const res = await patch(owner.token, mount, q.ref, { smtp_host: 'smtp.example.test', smtp_pass: 'test-pass-delete' })
      expect(res.status, status).toBe(409)
      expect((await res.json()).error).toBe('project_busy')
      await pool.query(`update control.projects set status = 'REMOVED' where id = $1`, [q.id])
      await pool.query(`update control.jobs set status = 'succeeded' where project_id = $1`, [q.id])
      expect((await pool.query(`select name from control.project_secrets where project_id = $1`, [q.id])).rows).toEqual([])
      expect((await pool.query(`select section from control.project_config where project_id = $1`, [q.id])).rows).toEqual([])
      expect(await applies(q.id)).toEqual([])
    }
  })

  test('m-4: smtp_user and smtp_admin_email are shown to project.manage only', async () => {
    const q = await project(acme.id)
    expect((await patch(owner.token, mount, q.ref, { smtp_user: 'mailer-m4', smtp_admin_email: 'm4@example.test', smtp_host: 'smtp.example.test' })).status)
      .toBe(200)
    for (const u of [reader, dev]) {
      expect(await (await get(u.token, mount, q.ref)).json()).toMatchObject({ smtp_user: null, smtp_admin_email: null, smtp_host: 'smtp.example.test' })
    }
    expect(await (await get(admin.token, mount, q.ref)).json()).toMatchObject({ smtp_user: 'mailer-m4', smtp_admin_email: 'm4@example.test' })
    // project-scoped: an administrator of a sees them on a, a developer of a does not
    expect((await patch(owner.token, mount, a.ref, { smtp_user: 'mailer-m4-a' })).status).toBe(200)
    expect((await (await get(scoped.token, mount, a.ref)).json()).smtp_user).toBe('mailer-m4-a')
    expect((await (await get(scopedDev.token, mount, a.ref)).json()).smtp_user).toBeNull()
  })

  test('m-3: smtp_host as a loopback, private, link-local or metadata address is refused; a public one is not', async () => {
    const q = await project(acme.id)
    for (const ip of ['127.0.0.1', '::1', '169.254.169.254', '10.0.0.5', '172.16.0.1', '192.168.1.10', '100.64.0.1', '0.0.0.0',
      '::ffff:127.0.0.1', 'fe80::1', 'fc00::1']) {
      const res = await patch(owner.token, mount, q.ref, { smtp_host: ip })
      const text = await res.text()
      expect(res.status, ip).toBe(400)
      expect(JSON.parse(text).error).toBe('validation_failed')
      expect(text).toContain('smtp_host')
      expect(text).not.toContain(ip)
    }
    expect((await pool.query(`select 1 from control.project_config where project_id = $1`, [q.id])).rowCount).toBe(0)
    expect((await patch(owner.token, mount, q.ref, { smtp_host: '203.0.113.10' })).status).toBe(200)
  })

  test('m-2: a PATCH body that is not application/json is 415 and changes nothing', async () => {
    const q = await project(acme.id)
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const res = await app.request(url(mount, q.ref), { method: 'PATCH', body: JSON.stringify({ smtp_user: 'via-text' }),
        headers: { authorization: `Bearer ${owner.token}`, ...(type ? { 'content-type': type } : {}) } })
      expect(res.status, String(type)).toBe(415)
    }
    expect((await pool.query(`select 1 from control.project_config where project_id = $1`, [q.id])).rowCount).toBe(0)
    expect(await applies(q.id)).toEqual([])
  })

  test('a field we do not store: 400 not_supported naming it, nothing stored', async () => {
    // prototype names as own keys, the way JSON.parse makes them
    const protoKeys = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map((k) => JSON.parse(`{"${k}":"x"}`))
    for (const extra of [{ mfa_max_enrolled_factors: 3 }, { external_github_enabled: true }, { refresh_token_rotation_enabled: false }, ...protoKeys]) {
      const res = await patch(owner.token, mount, p.ref, { smtp_user: 'not-stored', ...extra })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('not_supported')
      expect(body.message).toContain(Object.keys(extra)[0])
    }
    expect((await (await get(owner.token, mount, p.ref)).json()).smtp_user).not.toBe('not-stored')
  })

  test('bad types and values: 400 naming the field, never the value; nothing stored', async () => {
    const before = (await pool.query(`select data from control.project_config where project_id = $1 and section = 'auth'`, [p.id])).rows[0]?.data
    const cases: Record<string, unknown>[] = [
      { disable_signup: 'BADVALUE-yes' }, { external_phone_enabled: 1 }, { password_min_length: 5 }, { password_min_length: '10' },
      { mailer_otp_exp: 1.5 }, { mailer_otp_exp: 0 }, { smtp_max_frequency: -1 }, { security_refresh_token_reuse_interval: 'BADVALUE-10' },
      { smtp_port: 'BADVALUE-x' }, { smtp_port: '70000' }, { smtp_port: 587 }, { site_url: 'BADVALUE-not-a-url' },
      { site_url: 'ftp://BADVALUE.example.test' }, { smtp_admin_email: 'BADVALUE-no-at' }, { smtp_host: 'BADVALUE host' },
      { smtp_user: 'BADVALUE\nline' }, { uri_allow_list: 42 }, { external_google_client_id: ['BADVALUE'] },
      { external_google_secret: 1234567 }, { smtp_pass: 'BADVALUE\u0000' }, { external_google_secret: 'BADVALUE'.repeat(1000) },
    ]
    for (const c of cases) {
      const field = Object.keys(c)[0]
      const res = await patch(owner.token, mount, p.ref, { smtp_user: 'not-stored-either', ...c })
      const text = await res.text()
      expect(res.status, `${field}: ${text}`).toBe(400)
      expect(JSON.parse(text).error, field).toBe('validation_failed')
      expect(text, field).toContain(field)
      expect(text, field).not.toContain('BADVALUE')
    }
    expect((await pool.query(`select data from control.project_config where project_id = $1 and section = 'auth'`, [p.id])).rows[0]?.data)
      .toEqual(before)
  })

  test('external_google_enabled follows the client id: true needs one, false forgets it', async () => {
    const q = await project(acme.id)
    expect((await patch(owner.token, mount, q.ref, { external_google_enabled: true })).status).toBe(400)
    expect((await patch(owner.token, mount, q.ref,
      { external_google_enabled: true, external_google_client_id: 'cid.example.test', external_google_secret: 'test-google-m7' })).status).toBe(200)
    expect((await patch(owner.token, mount, q.ref, { external_google_enabled: false, external_google_client_id: 'cid.example.test' })).status).toBe(400)
    expect((await patch(owner.token, mount, q.ref, { external_google_enabled: false, external_google_secret: 'test-google-m7b' })).status).toBe(400)
    expect((await getSecrets(pool, q)).GOOGLE_CLIENT_SECRET).toBe('test-google-m7')
    expect((await patch(owner.token, mount, q.ref, { external_google_enabled: false })).status).toBe(200)
    // m-7: the secret goes with the id, so a later id is never paired with the old secret
    expect(await getSecrets(pool, q)).not.toHaveProperty('GOOGLE_CLIENT_SECRET')
    expect(await (await get(owner.token, mount, q.ref)).json()).toMatchObject({ external_google_enabled: false, external_google_client_id: '' })
  })

  test('roles: read_only and developer may read, not write; a project-scoped member only reaches its own project', async () => {
    expect((await get(reader.token, mount, a.ref)).status).toBe(200)
    expect((await patch(reader.token, mount, a.ref, { disable_signup: true })).status).toBe(403)
    expect((await patch(dev.token, mount, a.ref, { disable_signup: true })).status).toBe(403)
    // scoped to a: an administrator there may write a, and sees nothing of b
    expect((await patch(scoped.token, mount, a.ref, { smtp_user: 'scoped-wrote-this' })).status).toBe(200)
    for (const u of [scoped, scopedDev]) {
      expect([403, 404]).toContain((await get(u.token, mount, b.ref)).status)
      expect([403, 404]).toContain((await patch(u.token, mount, b.ref, { disable_signup: true })).status)
    }
    expect((await patch(scopedDev.token, mount, a.ref, { disable_signup: true })).status).toBe(403)
    expect((await get(stranger.token, mount, a.ref)).status).toBe(404)
    expect((await patch(stranger.token, mount, a.ref, { disable_signup: true })).status).toBe(404)
    const bCfg = (await pool.query(`select data from control.project_config where project_id = $1 and section = 'auth'`, [b.id])).rows[0]?.data
    expect(bCfg?.AUTH_DISABLE_SIGNUP).toBeUndefined()
  })

  test('each PATCH requests one core recreate, through project.apply; the job hands core the new env', async () => {
    const q = await project(acme.id)
    fake.running(q.ref, 'test')
    // its default host holds a slot, as after a create: ensure routes counted hosts only
    await pool.query(`insert into control.host_slots (hostname, pool, project_id) values ($1, 'project', $2)`, [`${q.ref}.${config.baseDomain}`, q.id])
    expect((await patch(owner.token, mount, q.ref, { external_google_client_id: 'cid-1.example.test', external_google_secret: 'test-secret-1' })).status).toBe(200)
    let jobs = await applies(q.id)
    expect(jobs.map((j) => [j.status, j.payload])).toEqual([['pending', { recreate: ['core'] }]])
    // run it the way the worker does
    const ensures = fake.callsOf('ensure').length
    const w = startWorkers({ db: pool, provisioner: fake, backoffMs: 1, idleMs: 10 })
    try {
      for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20)))
        if ((await applies(q.id))[0].status === 'succeeded') break
    } finally {
      await w.stop()
    }
    expect((await applies(q.id))[0].status).toBe('succeeded')
    const calls = fake.callsOf('ensure').slice(ensures).filter((c) => c.args[0].ref === q.ref)
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0].recreate).toEqual(['core'])
    expect(calls[0].args[0].env).toMatchObject({ GOOGLE_CLIENT_ID: 'cid-1.example.test', GOOGLE_CLIENT_SECRET: 'test-secret-1' })

    expect((await patch(owner.token, mount, q.ref, { disable_signup: true })).status).toBe(200)
    jobs = await applies(q.id)
    expect(jobs.map((j) => j.status)).toEqual(['succeeded', 'pending'])
    // a GET requests nothing
    await get(owner.token, mount, q.ref)
    expect(await applies(q.id)).toHaveLength(2)
    await finishJobs(q.id)
  })

  test('two concurrent PATCHes on different fields both survive', async () => {
    const q = await project(acme.id)
    const results = await Promise.all([
      patch(owner.token, mount, q.ref, { site_url: 'https://one.example.test', external_google_secret: 'test-secret-three' }),
      patch(admin.token, mount, q.ref, { disable_signup: true, external_google_client_id: 'cid-two.example.test' }),
      patch(owner.token, mount, q.ref, { smtp_host: 'smtp.three.example.test', smtp_pass: 'test-pass-one' }),
    ])
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(await (await get(owner.token, mount, q.ref)).json()).toMatchObject({
      site_url: 'https://one.example.test', disable_signup: true, external_google_client_id: 'cid-two.example.test',
      smtp_host: 'smtp.three.example.test', external_google_enabled: true,
    })
    const s = await getSecrets(pool, q)
    expect([s.SMTP_PASS, s.GOOGLE_CLIENT_SECRET]).toEqual(['test-pass-one', 'test-secret-three'])
    expect((await applies(q.id)).filter((j) => j.status === 'pending')).toHaveLength(1)
    await finishJobs(q.id)
  })
})

test('M6: the config and secrets commit with the apply job: when the job insert fails, neither is stored', async () => {
  const q = await project(acme.id)
  await pool.query(`create or replace function control.test_refuse_job() returns trigger language plpgsql
    as $$ begin raise exception 'job refused by the test'; end $$`)
  // q.id is a uuid this database made
  await pool.query(`create trigger test_refuse_job before insert on control.jobs for each row
    when (new.project_id = '${q.id}'::uuid) execute function control.test_refuse_job()`)
  try {
    const res = await patch(owner.token, '/v1', q.ref, { smtp_user: 'atomic', external_google_secret: 'test-secret-m6' })
    expect(res.status).toBe(500)
  } finally {
    await pool.query('drop trigger test_refuse_job on control.jobs')
    await pool.query('drop function control.test_refuse_job()')
  }
  expect((await pool.query(`select 1 from control.project_config where project_id = $1`, [q.id])).rowCount).toBe(0)
  expect(await getSecrets(pool, q)).not.toHaveProperty('GOOGLE_CLIENT_SECRET')
  expect(logged.join('\n')).not.toContain('test-secret-m6')
})

test('setConfig writes third-party secrets only: a platform secret name throws and changes nothing', async () => {
  const before = await getSecrets(pool, b)
  for (const name of ['JWT_SECRET', 'POSTGRES_PASSWORD', 'SERVICE_ROLE_KEY', 'ANYTHING']) {
    await expect(setConfig(pool, b, 'auth', {}, { [name]: 'test-overwrite' }, owner.id)).rejects.toThrow(name)
  }
  expect(await getSecrets(pool, b)).toEqual(before)
})

test('loadProjectEnv reads one snapshot: a new SMTP host and password committed between its reads never pair up with the old ones', async () => {
  const q = await project(acme.id)
  await setConfig(pool, q, 'auth', { SMTP_HOST: 'old-smtp.example.test' }, { SMTP_PASS: 'test-pass-old' }, owner.id)
  // hold loadProjectEnv's config read (its secrets are read by then) until the change below has committed
  let reached!: () => void
  let resume!: () => void
  const atConfigRead = new Promise<void>((r) => { reached = r })
  const resumed = new Promise<void>((r) => { resume = r })
  const query = pg.Client.prototype.query as (...a: unknown[]) => unknown
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : ''
    if (text.startsWith('select data from control.project_config') && (args[1] as unknown[])?.[0] === q.id) {
      spy.mockRestore()
      reached()
      return resumed.then(() => query.apply(this, args))
    }
    return query.apply(this, args)
  } as never)
  try {
    const loading = loadProjectEnv(pool, q)
    await atConfigRead
    const c = await pool.connect()
    try {
      await c.query('begin')
      await setConfig(c, q, 'auth', { SMTP_HOST: 'new-smtp.example.test' }, { SMTP_PASS: 'test-pass-new' }, owner.id)
      await c.query('commit')
    } finally {
      c.release()
    }
    resume()
    const { env } = await loading
    expect({ host: env.SMTP_HOST, pass: env.SMTP_PASS }).toEqual({ host: 'old-smtp.example.test', pass: 'test-pass-old' })
  } finally {
    spy.mockRestore()
    resume()
  }
  const { env } = await loadProjectEnv(pool, q)
  expect({ host: env.SMTP_HOST, pass: env.SMTP_PASS }).toEqual({ host: 'new-smtp.example.test', pass: 'test-pass-new' })
})

test('both mounts are the same handler: a write through one reads back through the other', async () => {
  expect((await patch(owner.token, '/v1', b.ref, { smtp_user: 'via-v1' })).status).toBe(200)
  expect((await (await get(owner.token, '/platform', b.ref)).json()).smtp_user).toBe('via-v1')
  expect((await patch(owner.token, '/platform', b.ref, { smtp_user: 'via-platform' })).status).toBe(200)
  expect((await (await get(owner.token, '/v1', b.ref)).json()).smtp_user).toBe('via-platform')
})
