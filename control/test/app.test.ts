import { afterAll, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// STUDIO_DIR is read once with the config, so it is set before app.ts is first imported in this file
const dir = mkdtempSync(join(tmpdir(), 'studio-'))
mkdirSync(join(dir, 'assets'))
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>studio</title>')
writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
process.env.STUDIO_DIR = dir
const { app } = await import('../src/app.ts')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('GET /health', async () => {
  const res = await app.request('/health')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})

test('Studio files and the index.html fallback for client routes', async () => {
  expect(await (await app.request('/')).text()).toContain('<title>studio</title>')
  const js = await app.request('/assets/app.js')
  expect(js.headers.get('content-type')).toMatch(/javascript/)
  expect(await js.text()).toBe('console.log(1)')
  const route = await app.request('/org/abc/projects')
  expect(route.status).toBe(200)
  expect(await route.text()).toContain('<title>studio</title>')
})

test('/platform, /v1 and /health are never answered with index.html', async () => {
  // without a caller, /platform and /v1 fail closed (401) before any 404 (accounts.test: 404 after sign-in)
  for (const [path, status, error] of [['/platform/nope', 401, 'unauthorized'], ['/v1', 401, 'unauthorized'],
    ['/v1/projects/nope', 401, 'unauthorized'], ['/health/x', 404, 'not_found']] as const) {
    const res = await app.request(path)
    expect(res.status, path).toBe(status)
    expect(res.headers.get('content-type'), path).toMatch(/application\/json/)
    expect(await res.json(), path).toEqual({ error, message: expect.any(String) })
  }
})

// framing would turn Studio's click-only actions (pause, remove member, role) into clickjacking targets
test('every answer carries the anti-framing, nosniff and referrer headers', async () => {
  for (const path of ['/', '/assets/app.js', '/platform/nope', '/v1/projects', '/health']) {
    const res = await app.request(path)
    expect(res.headers.get('x-frame-options'), path).toBe('DENY')
    expect(res.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'")
    expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
    expect(res.headers.get('referrer-policy'), path).toBe('no-referrer')
    // no includeSubDomains: a paused custom domain's answer must not force HTTPS on that domain's other hosts
    expect(res.headers.get('strict-transport-security'), path).toBe('max-age=15552000')
  }
})

test('errors have the shape {error, message}', async () => {
  const { ApiError } = await import('../src/errors.ts')
  const { Hono } = await import('hono')
  const { onError } = await import('../src/errors.ts')
  const h = new Hono().onError(onError)
  h.get('/a', () => { throw new ApiError(409, 'conflict', 'already there') })
  h.get('/b', () => { throw new Error('secret detail') })
  const a = await h.request('/a')
  expect(a.status).toBe(409)
  expect(await a.json()).toEqual({ error: 'conflict', message: 'already there' })
  const b = await h.request('/b')
  expect(b.status).toBe(500)
  expect(await b.json()).toEqual({ error: 'internal', message: 'internal error' })
})
