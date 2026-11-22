import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { app } from '../src/app.ts'
import { config } from '../src/config.ts'
import { resetRateLimits } from '../src/core.ts'
import { pool } from '../src/db.ts'
import { forwardTarget } from '../src/forward.ts'
import { setProvisioner } from '../src/provisioner.ts'
import { FakeProvisioner } from './fake-provisioner.ts'
import { ORIGIN, as, join, login, org, PASSWORD, project, resetDashboard, user, withToken } from './helpers.ts'
import { stubCore } from './stub-core.ts'

let core: Awaited<ReturnType<typeof stubCore>>
let p: Awaited<ReturnType<typeof project>>
let reader: Awaited<ReturnType<typeof user>>
let dev: Awaited<ReturnType<typeof user>>
const A = () => `/platform/projects/${p.ref}/admin`

beforeAll(async () => {
  await resetDashboard()
  setProvisioner(new FakeProvisioner())
  core = await stubCore()
  forwardTarget.url = () => core.url
  const acme = await org('acme')
  reader = await user('reader@example.test')
  dev = await user('dev@example.test')
  await join(acme.id, reader.id, 'read_only')
  await join(acme.id, dev.id, 'developer')
  p = await project(acme.id)
})
afterAll(() => core.close())
beforeEach(() => resetRateLimits())

const last = () => core.seen.at(-1)!

describe('admin forwarding', () => {
  test('the project gets its admin token and the actor, never the caller\'s cookie or authorization', async () => {
    const cookie = await login('dev@example.test', PASSWORD)
    const res = await app.request(`${A()}/tables?schema=public`, { headers: { cookie, origin: ORIGIN, 'x-selfbase-actor': 'forged@example.test' } })
    expect(res.status).toBe(200)
    expect(last().url).toBe('/admin/tables?schema=public')
    expect(last().headers.authorization).toBe(`Bearer ${p.secrets.ADMIN_TOKEN}`)
    expect(last().headers['x-selfbase-actor']).toBe('dev@example.test')
    expect(last().headers.cookie).toBeUndefined()
    await withToken(dev.token, 'GET', `${A()}/schemas`)
    expect(last().headers.authorization).toBe(`Bearer ${p.secrets.ADMIN_TOKEN}`)
  })

  test('read_only can GET and gets 403 on POST', async () => {
    expect((await withToken(reader.token, 'GET', `${A()}/schemas`)).status).toBe(200)
    const n = core.seen.length
    expect((await withToken(reader.token, 'POST', `${A()}/rows/public/notes`, { values: {} })).status).toBe(403)
    expect(core.seen.length).toBe(n)
  })

  test('developer reaches /admin/sql, read_only does not, however the path is spelled', async () => {
    const res = await withToken(dev.token, 'POST', `${A()}/sql`, { query: 'select 1 as a' })
    expect(await res.json()).toMatchObject({ columns: ['a'], rows: [[1]] })
    const n = core.seen.length
    // GET of sql is not a read either: read_only may GET anything else, so GET shows the sql check itself
    for (const path of ['/sql', '//sql', '/./sql', '/%73ql', '/SQL', '/sql/', '/x/../sql', '/%2Fsql'])
      for (const method of ['POST', 'GET'])
        expect((await withToken(reader.token, method, `${A()}${path}`, method === 'POST' ? { query: 'select 1 as a' } : undefined)).status, `${method} ${path}`).toBe(403)
    expect(core.seen.length).toBe(n)
  })

  test('rows of the auth schema (password hashes) need developer, however the path is spelled', async () => {
    const n = core.seen.length
    for (const path of ['/rows/auth/users', '/rows/AUTH/users', '/rows/%61uth/users', '//rows//auth/identities'])
      expect((await withToken(reader.token, 'GET', `${A()}${path}`)).status, path).toBe(403)
    expect(core.seen.length).toBe(n)
    expect((await withToken(dev.token, 'GET', `${A()}/rows/auth/users`)).status).toBe(200)
    // the Users screen's own route stays open to read_only; other schemas too
    expect((await withToken(reader.token, 'GET', `${A()}/users?search=`)).status).toBe(200)
    expect((await withToken(reader.token, 'GET', `${A()}/rows/public/authors`)).status).toBe(200)
  })

  test('a member of another organization gets 404 on the admin API', async () => {
    const other = await org('other-org')
    const stranger = await user('stranger@example.test')
    await join(other.id, stranger.id, 'owner')
    const n = core.seen.length
    const real = await withToken(stranger.token, 'GET', `${A()}/schemas`)
    const missing = await withToken(stranger.token, 'GET', '/platform/projects/zzzzzzzzzzzzzzzzzzzz/admin/schemas')
    expect([real.status, missing.status]).toEqual([404, 404])
    expect(await real.json()).toEqual(await missing.json())
    expect(core.seen.length).toBe(n)
  })

  test('core\'s location header is not passed on', async () => {
    const res = await withToken(dev.token, 'GET', `${A()}/moved`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBeNull()
  })

  test('a path cannot leave /admin', async () => {
    const res = await withToken(dev.token, 'GET', `${A()}/%2e%2e/rest/v1/`)
    expect(res.status).toBe(404)
  })

  test('a 30 MiB upload passes through unbuffered, and the download headers come back', async () => {
    const chunk = new Uint8Array(1 << 20)
    let sent = 0
    let reached: Promise<void> | undefined
    const body = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        if (sent === 1) await reached // the rest is only sent once the stub has the first chunk: a buffering proxy would hang here
        if (sent === 30) return ctl.close()
        sent++
        ctl.enqueue(chunk)
      },
    })
    reached = core.onFirstChunk()
    const res = await app.request(`${A()}/files/media/big.bin`, {
      method: 'POST', body, duplex: 'half', headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/octet-stream' },
    } as RequestInit)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, bytes: 30 << 20 })
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="x.bin"')
  }, 30000)

  test('JSON bodies are still capped at 256 KiB', async () => {
    const res = await withToken(dev.token, 'POST', `${A()}/rows/public/notes`, { values: { note: 'x'.repeat(300 * 1024) } })
    expect(res.status).toBe(413)
  })

  test('a project that is not running is 409; an unreachable core is 502', async () => {
    await pool.query(`update control.projects set status = 'INACTIVE' where id = $1`, [p.id])
    try {
      expect((await withToken(dev.token, 'GET', `${A()}/schemas`)).status).toBe(409)
    } finally {
      await pool.query(`update control.projects set status = 'ACTIVE_HEALTHY' where id = $1`, [p.id])
    }
    forwardTarget.url = () => 'http://127.0.0.1:1'
    try {
      const res = await withToken(dev.token, 'GET', `${A()}/schemas`)
      expect(res.status).toBe(502)
      expect(await res.json()).toMatchObject({ message: 'project is not reachable' })
    } finally {
      forwardTarget.url = () => core.url
    }
  })
})

describe('hosts', () => {
  test('the host of a paused project answers 540 on every path; an unknown host 404', async () => {
    const acme2 = await org('paused-org')
    const paused = await project(acme2.id, { status: 'INACTIVE' })
    const host = `${paused.ref}.${config.baseDomain}`
    for (const path of ['/', '/platform/login', '/v1/projects', '/health', '/index.html', `/platform/projects/${p.ref}/admin/schemas`]) {
      const res = await app.request(path, { method: path === '/platform/login' ? 'POST' : 'GET', headers: { host } })
      expect(res.status, path).toBe(540)
      expect(await res.json()).toEqual({ message: 'project paused' })
    }
    // every status where the project is not meant to serve, not only INACTIVE
    for (const status of ['PAUSING', 'PAUSE_FAILED', 'RESTORING', 'RESTORE_FAILED']) {
      const q = await project(acme2.id, { status })
      expect((await app.request('/', { headers: { host: `${q.ref}.${config.baseDomain}` } })).status, status).toBe(540)
    }
    const removed = await project(acme2.id, { status: 'REMOVED' })
    const coming = await project(acme2.id, { status: 'COMING_UP' })
    // a running project's host, a removed one's and a stranger's are the same 404
    for (const h of [`${p.ref}.${config.baseDomain}`, `${removed.ref}.${config.baseDomain}`, `${coming.ref}.${config.baseDomain}`,
      'evil.example.com', `${paused.ref}.${config.baseDomain}.evil.com`]) {
      const res = await app.request('/platform/login', { method: 'POST', headers: { host: h } })
      expect(res.status, h).toBe(404)
      expect(await res.json()).toEqual({ message: 'not found' })
    }
    // the public host, with or without its port, reaches the routes
    const pub = new URL(config.publicUrl)
    expect((await app.request('/health', { headers: { host: pub.host } })).status).toBe(200)
    expect((await app.request('/health', { headers: { host: `${pub.hostname.toUpperCase()}:443` } })).status).toBe(200)
    // a container health check on loopback reaches /health only
    expect((await app.request('/health', { headers: { host: 'localhost:8080' } })).status).toBe(200)
    expect((await app.request('/platform/me', { headers: { host: 'localhost:8080' } })).status).toBe(404)
  })
})
