import { describe, it, expect, vi, afterEach } from 'vitest'
import { app } from '../src/app.ts'
import { logLine } from '../src/log.ts'

const anonKey = process.env.ANON_KEY!

/** Runs fn with stdout captured; returns what was written. */
async function capture(fn: () => unknown): Promise<string> {
  let out = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  })
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return out
}
const lines = (out: string) => out.split('\n').filter(Boolean).map((l) => JSON.parse(l))

afterEach(() => vi.restoreAllMocks())

describe('request log', () => {
  it('logs one JSON line per request with the path and never the query string', async () => {
    let res!: Response
    const out = await capture(async () => (res = await app.request('/auth/v1/verify?token=SECRETTOKEN&type=signup')))
    expect(out).not.toContain('SECRETTOKEN')
    const logged = lines(out)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ level: 'info', svc: 'core', project: 'testprojectrefaaaaaa', method: 'GET', path: '/auth/v1/verify', status: res.status })
    expect(Object.keys(logged[0]).sort()).toEqual(['latency_ms', 'level', 'method', 'path', 'project', 'request_id', 'status', 'svc', 'ts'])
    expect(typeof logged[0].latency_ms).toBe('number')
    expect(Number.isNaN(Date.parse(logged[0].ts))).toBe(false)
    expect(res.headers.get('x-request-id')).toBe(logged[0].request_id)
  })

  it('never logs header values', async () => {
    const out = await capture(() => app.request('/auth/v1/user', { headers: { apikey: anonKey, authorization: `Bearer ${anonKey}` } }))
    expect(out).not.toContain(anonKey)
    expect(lines(out)).toHaveLength(1)
  })

  it('keeps a well-formed x-request-id and replaces a malformed one', async () => {
    const good = 'req-0123456789abcdef'
    let res!: Response
    let out = await capture(async () => (res = await app.request('/health', { headers: { 'x-request-id': good } })))
    expect(lines(out)[0].request_id).toBe(good)
    expect(res.headers.get('x-request-id')).toBe(good)
    for (const bad of ['abc', 'a'.repeat(65), 'has space 12345', 'semi;colon-1234']) {
      out = await capture(async () => (res = await app.request('/health', { headers: { 'x-request-id': bad } })))
      const id = lines(out)[0].request_id
      expect(id).not.toBe(bad)
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      expect(res.headers.get('x-request-id')).toBe(id)
    }
  })

  it('logLine writes one JSON line with level and message', async () => {
    const out = await capture(async () => logLine('warn', 'something happened', { n: 1 }))
    expect(lines(out)).toEqual([expect.objectContaining({ level: 'warn', msg: 'something happened', n: 1, svc: 'core', project: 'testprojectrefaaaaaa' })])
  })
})
