import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pool } from '../src/db.ts'
import { startNetQueue, stopNetQueue } from '../src/netqueue/index.ts'
import { rewriteUrl } from '../src/netqueue/worker.ts'

type Hit = { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }
/** Local stand-in server that records each request and answers with `status`. */
async function fake(status: number, headers: Record<string, string> = {}) {
  const hits: Hit[] = []
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(status, headers).end()
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, hits, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function settled(id: string) {
  for (const end = Date.now() + 5000; Date.now() < end; await sleep(20)) {
    const { rows } = await pool.query('select status, attempts, last_error from selfbase.http_queue where id = $1', [id])
    if (rows[0].status !== 'pending') return rows[0]
  }
  throw new Error('still pending')
}
const post = async (url: string, headers = {}) =>
  (await pool.query(`select net.http_post($1, '{"a":1}', '{}', $2) as id`, [url, headers])).rows[0].id as string

let fn: Awaited<ReturnType<typeof fake>>
let core: Awaited<ReturnType<typeof fake>>
const realFetch = globalThis.fetch
// Guard: anything not aimed at a local stand-in fails instead of leaving the machine.
const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
  const u = new URL(String(input))
  if (u.hostname !== '127.0.0.1') return Promise.reject(new Error(`outbound request blocked in test: ${u.href}`))
  return realFetch(input, init)
})

beforeAll(async () => {
  // Rows left by other tests or earlier runs are not ours to send.
  await pool.query(`update selfbase.http_queue set status = 'skipped' where status = 'pending'`)
  fn = await fake(200)
  core = await fake(200)
  await startNetQueue({ fnUrl: fn.url, coreUrl: core.url, retryDelayMs: 10 })
})

afterAll(async () => {
  await stopNetQueue()
  fetchSpy.mockRestore()
  await Promise.all([fn, core].map((f) => new Promise((r) => f.srv.close(r))))
})

describe('netqueue', () => {
  it('rewriteUrl maps supabase.co origins to internal addresses', () => {
    const bases = { fnUrl: 'http://fn:8000', coreUrl: 'http://core:8080' }
    expect(rewriteUrl('https://abc.supabase.co/functions/v1/x?y=1', bases)).toBe('http://fn:8000/x?y=1')
    expect(rewriteUrl('https://abc.supabase.co/rest/v1/t?select=*', bases)).toBe('http://core:8080/rest/v1/t?select=*')
    expect(rewriteUrl('https://example.com/hook', bases)).toBe('https://example.com/hook')
    expect(() => rewriteUrl('https://abc.supabase.co/other', bases)).toThrow(/blocked/)
    // host normalisation: case, trailing dot, IDNA full stop
    expect(rewriteUrl('https://ABC.Supabase.CO/functions/v1/x', bases)).toBe('http://fn:8000/x')
    expect(rewriteUrl('https://abc.supabase.co./functions/v1/x', bases)).toBe('http://fn:8000/x')
    expect(() => rewriteUrl('https://abc.supabase.co./other', bases)).toThrow(/blocked/)
    expect(() => rewriteUrl('https://abc.supabase.co%E3%80%82/other', bases)).toThrow(/blocked/)
    // userinfo is not the host
    expect(rewriteUrl('https://abc.supabase.co@evil.example/x', bases)).toBe('https://abc.supabase.co@evil.example/x')
    expect(() => rewriteUrl('https://evil.example@abc.supabase.co/other', bases)).toThrow(/blocked/)
    expect(rewriteUrl('https://evil.example@abc.supabase.co/rest/v1/t', bases)).toBe('http://core:8080/rest/v1/t')
    // only http(s)
    expect(() => rewriteUrl('ftp://example.com/x', bases)).toThrow(/blocked/)
    expect(() => rewriteUrl('file:///etc/passwd', bases)).toThrow(/blocked/)
  })

  it('sends a supabase.co function call to FN_URL with headers as stored', async () => {
    const id = await post('https://abc.supabase.co/functions/v1/x', { Authorization: 'Bearer stored-key', 'x-extra': 'y' })
    expect(await settled(id)).toMatchObject({ status: 'done', attempts: 1 })
    expect(fn.hits).toHaveLength(1)
    expect(fn.hits[0]).toMatchObject({ method: 'POST', url: '/x', body: '{"a":1}' })
    expect(fn.hits[0].headers).toMatchObject({ authorization: 'Bearer stored-key', 'x-extra': 'y' })
    expect(fetchSpy.mock.calls.every(([u]) => !String(u).includes('supabase.co'))).toBe(true)
  })

  it('blocks a supabase.co address it cannot rewrite', async () => {
    const id = await post('https://abc.supabase.co/başka')
    expect(await settled(id)).toMatchObject({ status: 'blocked', attempts: 0 })
    expect(fetchSpy.mock.calls.every(([u]) => !String(u).includes('supabase.co'))).toBe(true)
  })

  it('does not follow redirects', async () => {
    const target = await fake(200)
    const redir = await fake(302, { location: `${target.url}/landed` })
    try {
      const id = await post(`${redir.url}/hop`)
      expect(await settled(id)).toEqual({ status: 'failed', attempts: 3, last_error: 'HTTP 302' })
      expect(redir.hits).toHaveLength(3)
      expect(target.hits).toEqual([])
    } finally {
      await Promise.all([target, redir].map((f) => new Promise((r) => f.srv.close(r))))
    }
  })

  it('a row with a bad header does not hold up the next row', async () => {
    const before = fn.hits.length
    const bad = await post('https://abc.supabase.co/functions/v1/bad', { Authorization: null })
    const good = await post('https://abc.supabase.co/functions/v1/good')
    expect((await settled(bad)).status).toMatch(/done|failed/)
    expect(await settled(good)).toMatchObject({ status: 'done' })
    const hits = fn.hits.slice(before)
    expect(hits.map((h) => h.url)).toContain('/good')
    expect(hits.find((h) => h.url === '/bad')?.headers.authorization).toBeUndefined()
  })

  it('marks a request failed after 3 attempts against a 500 target', async () => {
    const bad = await fake(500)
    try {
      const id = await post(`${bad.url}/hook`)
      expect(await settled(id)).toEqual({ status: 'failed', attempts: 3, last_error: 'HTTP 500' })
      expect(bad.hits).toHaveLength(3)
    } finally {
      await new Promise((r) => bad.srv.close(r))
    }
  })
})
