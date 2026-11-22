import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { config } from '../src/config.ts'
import { pool } from '../src/db.ts'
import { resetRateLimits } from '../src/core.ts'
import { setProvisioner } from '../src/provisioner.ts'
import { projectCapMb } from '../src/sizes.ts'
import { FakeProvisioner } from './fake-provisioner.ts'
import { as, join, login, org, PASSWORD, project, resetDashboard, user, withToken } from './helpers.ts'

const fake = new FakeProvisioner()
let acme: { id: string; slug: string }
let owner: Awaited<ReturnType<typeof user>>
let dev: Awaited<ReturnType<typeof user>>
let p: Awaited<ReturnType<typeof project>>
const P = () => `/platform/projects/${p.ref}`

beforeAll(async () => {
  await resetDashboard()
  setProvisioner(fake)
  acme = await org('acme')
  owner = await user('owner@example.test')
  dev = await user('dev@example.test')
  await join(acme.id, owner.id, 'owner')
  await join(acme.id, dev.id, 'developer')
  p = await project(acme.id, { name: 'corteqs', size: 'small' })
  fake.running(p.ref, 'test')
})
beforeEach(() => resetRateLimits())

describe('projects', () => {
  test('create refuses size large, answers 201 {project, job_id} otherwise', async () => {
    const bad = await withToken(owner.token, 'POST', '/platform/projects', { organization_slug: 'acme', name: 'x', size: 'large' })
    expect(bad.status).toBe(400)
    const res = await withToken(owner.token, 'POST', '/platform/projects', { organization_slug: 'acme', name: 'demo', size: 'micro' })
    expect(res.status).toBe(201)
    const { project: created, job_id } = await res.json()
    expect(created).toMatchObject({ name: 'demo', status: 'COMING_UP', organization_id: acme.id })
    expect((await pool.query(`select type, payload from control.jobs where id = $1`, [job_id])).rows[0])
      .toEqual({ type: 'project.create', payload: { pool: 'project' } })
    expect((await withToken(dev.token, 'POST', '/platform/projects', { organization_slug: 'acme', name: 'd', size: 'micro' })).status).toBe(403)
  })

  test('an admission refusal carries its numbers', async () => {
    const budget = (await pool.query(`select memory_budget_mb from control.nodes`)).rows[0].memory_budget_mb
    await pool.query(`update control.nodes set memory_budget_mb = 4000`)
    try {
      const res = await withToken(owner.token, 'POST', '/platform/projects', { organization_slug: 'acme', name: 'big', size: 'medium' })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'insufficient_memory', details: { neededMb: projectCapMb('medium'), freeMb: expect.any(Number) } })
    } finally {
      await pool.query(`update control.nodes set memory_budget_mb = $1`, [budget])
    }
  })

  test('the list carries size and certificate', async () => {
    const list = await (await withToken(dev.token, 'GET', '/platform/projects?organization_slug=acme')).json()
    expect(list.find((x: any) => x.ref === p.ref)).toMatchObject({ ref: p.ref, organization_id: acme.id, size: 'small', certificate: 'ok' })
    expect((await withToken(dev.token, 'GET', '/platform/projects?organization_slug=nope')).status).toBe(404)
  })

  test('detail: urls, versions, services with memory, last job', async () => {
    await pool.query(`insert into control.project_domains (project_id, hostname, kind) values ($1, 'old.example.com', 'legacy')`, [p.id])
    const d = await (await withToken(dev.token, 'GET', P())).json()
    expect(d).toMatchObject({
      ref: p.ref, size: 'small', template_version: 'test', current_template_version: 'test', certificate: 'ok', smtp_configured: false,
      urls: { api: `https://${p.ref}.${config.baseDomain}`, legacy: ['https://old.example.com'] }, last_job: null,
    })
    expect(d.services.map((s: any) => [s.service, s.state, s.memUsageMb])).toEqual(
      ['db', 'rest', 'core', 'fn', 'pooler'].map((s) => [s, 'running', 0]))
  })

  test('delete needs the project name', async () => {
    const q = await project(acme.id, { name: 'scratch' })
    const wrong = await withToken(owner.token, 'DELETE', `/platform/projects/${q.ref}`, { confirm_name: 'scrat' })
    expect(wrong.status).toBe(400)
    const ok = await withToken(owner.token, 'DELETE', `/platform/projects/${q.ref}`, { confirm_name: 'scratch' })
    expect(ok.status).toBe(202)
    const { job_id } = await ok.json()
    expect((await pool.query(`select type from control.jobs where id = $1`, [job_id])).rows[0].type).toBe('project.delete')
  })

  test('pause, restore and upgrade answer {job_id}; a developer gets 403; a busy project 409', async () => {
    const q = await project(acme.id)
    expect((await withToken(dev.token, 'POST', `/platform/projects/${q.ref}/pause`)).status).toBe(403)
    const res = await withToken(owner.token, 'POST', `/platform/projects/${q.ref}/pause`)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ job_id: expect.any(String) })
    expect((await withToken(owner.token, 'POST', `/platform/projects/${q.ref}/upgrade`)).status).toBe(409)
    const paused = await project(acme.id, { status: 'INACTIVE' })
    expect((await withToken(owner.token, 'POST', `/platform/projects/${paused.ref}/pause`)).status).toBe(409)
    expect((await withToken(owner.token, 'POST', `/platform/projects/${paused.ref}/restore`)).status).toBe(202)
  })

  test('a job: steps and events', async () => {
    const q = await project(acme.id)
    const { job_id } = await (await withToken(owner.token, 'POST', `/platform/projects/${q.ref}/pause`)).json()
    await pool.query(`insert into control.job_events (job_id, status, step) values ($1, 'succeeded', 'stop')`, [job_id])
    await pool.query(`update control.jobs set step = '1', status = 'running' where id = $1`, [job_id])
    const job = await (await withToken(dev.token, 'GET', `/platform/jobs/${job_id}`)).json()
    expect(job).toEqual({ id: job_id, type: 'project.pause', status: 'running', step: 1, steps: ['stop', 'inactive'], error: null,
      events: [{ at: expect.any(String), event: 'stop' }] })
    const list = await (await withToken(dev.token, 'GET', `/platform/projects/${q.ref}/jobs`)).json()
    expect(list.map((j: any) => j.id)).toEqual([job_id])
    const stranger = await user('stranger@example.test')
    expect((await withToken(stranger.token, 'GET', `/platform/jobs/${job_id}`)).status).toBe(404)
  })
})

describe('api keys', () => {
  test('the list has anon in full and service_role masked', async () => {
    const text = await (await withToken(dev.token, 'GET', `${P()}/api-keys`)).text()
    const keys = JSON.parse(text)
    expect(keys).toEqual([
      { name: 'anon', api_key: p.secrets.ANON_KEY, type: 'legacy' },
      { name: 'service_role', api_key: expect.stringMatching(/•+$/), type: 'legacy' },
    ])
    expect(text).not.toContain(p.secrets.SERVICE_ROLE_KEY)
  })

  test('reveal answers the key and writes an audit row without it', async () => {
    const cookie = await login('dev@example.test', PASSWORD)
    const res = await as(cookie, 'POST', `${P()}/api-keys/reveal`, { name: 'service_role' })
    expect(await res.json()).toEqual({ api_key: p.secrets.SERVICE_ROLE_KEY })
    const rows = (await pool.query(`select * from control.audit_log where action like '%/api-keys/reveal'`)).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'dev@example.test', project_id: p.id, target: 'service_role' })
    expect(JSON.stringify(rows)).not.toContain(p.secrets.SERVICE_ROLE_KEY)
    expect((await as(cookie, 'POST', `${P()}/api-keys/reveal`, { name: 'jwt_secret' })).status).toBe(400)
  })
})

describe('logs', () => {
  test('a service outside the enum is refused', async () => {
    for (const q of ['service=core;x', 'service=core&limit=1001', 'service=core&start=yesterday'])
      expect((await withToken(dev.token, 'GET', `${P()}/logs?${q}`)).status, q).toBe(400)
  })

  test('the query names the container only, and lines come back newest first', async () => {
    let got: URLSearchParams | undefined
    const store = createServer((req, res) => {
      let body = ''
      req.on('data', (b) => (body += b))
      req.on('end', () => {
        got = new URLSearchParams(body)
        res.end('{"_time":"2026-11-22T10:15:03Z","_msg":"b"}\n{"_time":"2026-11-22T10:15:01Z","_msg":"a"}\n')
      })
    })
    await new Promise<void>((r) => store.listen(0, '127.0.0.1', r))
    const before = config.logsUrl
    config.logsUrl = `http://127.0.0.1:${(store.address() as AddressInfo).port}`
    try {
      const res = await withToken(dev.token, 'GET', `${P()}/logs?service=core&limit=50&start=2026-11-22T00:00:00Z`)
      expect(res.headers.get('x-selfbase-log-source')).toBeNull()
      expect(await res.json()).toEqual([{ ts: '2026-11-22T10:15:03Z', msg: 'b' }, { ts: '2026-11-22T10:15:01Z', msg: 'a' }])
      expect(got!.get('query')).toBe(`app_name:="sb-${p.ref}-core" | sort by (_time desc) | limit 50`)
      expect(got!.get('start')).toBe('2026-11-22T00:00:00Z')
    } finally {
      config.logsUrl = before
      store.close()
    }
  })

  test('with the store down the lines come from the container tail, with the header', async () => {
    const before = config.logsUrl
    config.logsUrl = 'http://127.0.0.1:1'
    fake.logs = async () => 'first\nsecond\n'
    try {
      const res = await withToken(dev.token, 'GET', `${P()}/logs?service=db`)
      expect(res.headers.get('x-selfbase-log-source')).toBe('container')
      expect(await res.json()).toEqual([{ ts: '', msg: 'second' }, { ts: '', msg: 'first' }])
    } finally {
      config.logsUrl = before
    }
  })
})

test('capacity numbers add up', async () => {
  const c = await (await withToken(dev.token, 'GET', '/platform/capacity')).json()
  const running = c.projects.filter((x: any) => x.status !== 'INACTIVE' && x.status !== 'REMOVED')
  expect(c.used_mb).toBe(running.reduce((s: number, x: any) => s + x.cap_mb, 0))
  expect(c.free_mb).toBe(c.budget_mb - c.reserved_mb - c.job_slot_mb - c.used_mb)
  expect(c.projects.find((x: any) => x.ref === p.ref)).toEqual({ ref: p.ref, name: 'corteqs', size: 'small', cap_mb: projectCapMb('small'),
    status: 'ACTIVE_HEALTHY', mem_usage_mb: 0 })
  expect(c).toMatchObject({ new_hosts_this_week: expect.any(Number), max_new_hosts_per_week: config.maxNewHostsPerWeek })
})

describe('domains', () => {
  test('add enqueues project.apply with core recreated; list and remove', async () => {
    const q = await project(acme.id)
    expect((await withToken(dev.token, 'POST', `/platform/projects/${q.ref}/domains`, { hostname: 'api.example.com', kind: 'custom' })).status).toBe(403)
    const res = await withToken(owner.token, 'POST', `/platform/projects/${q.ref}/domains`, { hostname: 'api.example.com', kind: 'custom' })
    expect(res.status).toBe(202)
    const { job_id } = await res.json()
    expect((await pool.query(`select type, payload from control.jobs where id = $1`, [job_id])).rows[0])
      .toEqual({ type: 'project.apply', payload: { recreate: ['core'] } })
    expect(await (await withToken(owner.token, 'GET', `/platform/projects/${q.ref}/domains`)).json()).toEqual([
      { hostname: `${q.ref}.${config.baseDomain}`, kind: 'default' }, { hostname: 'api.example.com', kind: 'custom' }])
    const del = await withToken(owner.token, 'DELETE', `/platform/projects/${q.ref}/domains`, { hostname: 'api.example.com' })
    expect(del.status).toBe(202)
    expect((await withToken(owner.token, 'DELETE', `/platform/projects/${q.ref}/domains`, { hostname: 'api.example.com' })).status).toBe(404)
    // a refusal keeps its details for the client
    const taken = await withToken(owner.token, 'POST', `/platform/projects/${q.ref}/domains`, { hostname: `x.${config.baseDomain}`, kind: 'custom' })
    expect(taken.status).toBe(409)
    expect(await taken.json()).toMatchObject({ error: 'custom_under_base', message: expect.any(String) })
  })
})

afterAll(() => setProvisioner(new FakeProvisioner()))
