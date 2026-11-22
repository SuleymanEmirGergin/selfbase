// Configuration, HTTP helpers, the per-case summary and the checks both modes share. Configured only by env (README.md).
import dns from 'node:dns'
import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createClient } from '../../client/src/index.ts'

const need = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set (see acceptance/README.md)`)
  return v
}
const mode = need('ACCEPTANCE_MODE')
if (mode !== 'full' && mode !== 'live') throw new Error('ACCEPTANCE_MODE must be full or live')

export const env = {
  mode,
  url: need('SELFBASE_URL').replace(/\/+$/, ''),
  anon: need('SELFBASE_ANON_KEY'),
  // only full needs it (it removes the objects it uploaded); live compares the masked key against it when given
  service: process.env.SELFBASE_SERVICE_KEY ?? '',
  apiUrl: need('SELFBASE_API_URL').replace(/\/+$/, ''),
  token: need('SELFBASE_ACCESS_TOKEN'),
  ref: need('SELFBASE_PROJECT_REF'),
  loginEmail: process.env.ACCEPTANCE_LOGIN_EMAIL ?? '',
  loginPassword: process.env.ACCEPTANCE_LOGIN_PASSWORD ?? '',
}

// *.localhost is loopback (RFC 6761), but Node asks the DNS server for it; a local stack (test/e2e, Traefik's
// default certificate) is reached only through such names. Nothing changes for any other host.
const isLocal = (u: string) => /^(.+\.)?localhost$/.test(new URL(u).hostname)
if (isLocal(env.url) && isLocal(env.apiUrl)) {
  const real = dns.lookup
  ;(dns as { lookup: unknown }).lookup = (host: string, opts: any, cb?: any) => {
    if (typeof opts === 'function') [cb, opts] = [opts, {}]
    if (typeof opts === 'number') opts = { family: opts }
    if (!/^(.+\.)?localhost$/.test(host)) return (real as any)(host, opts, cb)
    return opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)
  }
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

export const HEALTH_SERVICES = ['db', 'rest', 'auth', 'realtime', 'storage', 'pooler']
const MASK = '••••••••'

export const client = (key = env.anon) => createClient(env.url, key, { auth: { persistSession: false, autoRefreshToken: false } })

/** A request to the project host. */
export const http = (path: string, init: RequestInit = {}, timeout = 15_000) =>
  fetch(`${env.url}${path}`, { ...init, signal: AbortSignal.timeout(timeout) })

/** A request to the control API with the access token. */
export async function mgmt(method: string, path: string, body?: unknown) {
  const res = await fetch(`${env.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, json, text }
}

/** SQL through the Management API (`/database/query`); rows as objects. */
export async function sql(query: string): Promise<Record<string, any>[]> {
  const r = await mgmt('POST', `/v1/projects/${env.ref}/database/query`, { query })
  if (r.status !== 201) throw new Error(`database/query -> ${r.status}: ${r.text.slice(0, NOTE)}`)
  return r.json
}
/** A SQL string literal. */
export const lit = (s: string) => `'${s.replaceAll("'", "''")}'`

export async function waitFor<T>(what: string, fn: () => Promise<T | false | undefined | null>, timeout = 15_000, every = 500): Promise<T> {
  const until = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = (e as Error).message
    }
    if (Date.now() > until) throw new Error(`timed out after ${timeout} ms waiting for ${what}${last ? ` (last: ${last})` : ''}`)
    await new Promise((r) => setTimeout(r, every))
  }
}

// ---- one summary line per case, and last-run.json ----

/** Failure notes and response excerpts are capped at this many characters. */
export const NOTE = 300
export const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0].slice(0, NOTE)

type Result = { status: 'passed' | 'failed' | 'skipped'; ms: number; note?: string }
const started = Date.now()
const declared: string[] = []
const results = new Map<string, Result>()

/** A case: recorded for the summary; `skip(why)` reports it as skipped. */
export function kase(name: string, fn: (skip: (why: string) => never) => Promise<void>) {
  declared.push(name)
  it(name, async (ctx) => {
    const t0 = performance.now()
    let skipped = false
    const skip = (why: string): never => {
      skipped = true
      results.set(name, { status: 'skipped', ms: 0, note: why })
      return ctx.skip(why)
    }
    try {
      await fn(skip)
      results.set(name, { status: 'passed', ms: performance.now() - t0 })
    } catch (e) {
      if (!skipped) results.set(name, { status: 'failed', ms: performance.now() - t0, note: firstLine(e) })
      throw e
    }
  })
}

/** A case that runs in afterAll (after the cleanup): declared now, so it is listed as not run when it never runs. */
export function laterCase(name: string) {
  declared.push(name)
  return async (fn: () => Promise<void>): Promise<string | undefined> => {
    const t0 = performance.now()
    try {
      await fn()
      results.set(name, { status: 'passed', ms: performance.now() - t0 })
    } catch (e) {
      results.set(name, { status: 'failed', ms: performance.now() - t0, note: firstLine(e) })
      return `${name}: ${firstLine(e)}`
    }
  }
}

/** Prints one line per case and writes acceptance/last-run.json (git-ignored). */
export function summary(extra: Record<string, unknown> = {}) {
  const counts = { passed: 0, failed: 0, skipped: 0, not_run: 0 }
  const lines = declared.map((name) => {
    const r = results.get(name)
    const status = r?.status ?? 'not_run'
    counts[status]++
    return `${status.toUpperCase().padEnd(8)}${((r?.ms ?? 0) / 1000).toFixed(1).padStart(6)} s  ${name}${r?.note ? `  (${r.note})` : ''}`
  })
  const duration_ms = Date.now() - started
  // straight to stdout: vitest's default reporter hides console output of passing runs
  process.stdout.write([`acceptance ${env.mode} on ${env.ref}:`, ...(extra.aborted ? [`ABORTED: ${extra.aborted}`] : []), ...lines,
    ...((extra.cleanup_failures as string[] | undefined) ?? []).map((f) => `CLEANUP FAILED: ${f}`),
    `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.not_run} not run in ${(duration_ms / 1000).toFixed(1)} s`].join('\n') + '\n')
  writeFileSync(new URL('../last-run.json', import.meta.url), JSON.stringify({ mode: env.mode, project_ref: env.ref, ...extra, counts, duration_ms,
    cases: declared.map((name) => ({ name, ...(results.get(name) ?? { status: 'not_run', ms: 0 }) })) }, null, 2) + '\n')
}

// ---- checks both modes run ----

export async function hiddenPaths() {
  for (const p of ['/admin/ready', '/admin/users', '/panel/']) expect((await http(p)).status, p).toBe(404)
}

export async function mgmtGet() {
  const p = await mgmt('GET', `/v1/projects/${env.ref}`)
  expect(p.status, p.text.slice(0, NOTE)).toBe(200)
  expect(p.json.ref).toBe(env.ref)
  expect(p.json.status).toBe('ACTIVE_HEALTHY')
}

export async function mgmtHealth() {
  const h = await mgmt('GET', `/v1/projects/${env.ref}/health?services=${HEALTH_SERVICES.join(',')}`)
  expect(h.status, h.text.slice(0, NOTE)).toBe(200)
  expect(h.json.map((s: { name: string; healthy: boolean }) => [s.name, s.healthy])).toEqual(HEALTH_SERVICES.map((n) => [n, true]))
}

/** anon in full (it ships in every app), service_role masked. Booleans only: a failure never prints a key. */
export async function mgmtKeys() {
  const k = await mgmt('GET', `/v1/projects/${env.ref}/api-keys`)
  // status and error code only: this body carries keys
  expect(k.status, `api-keys -> ${k.status} ${k.json?.error ?? ''}`).toBe(200)
  const key = (name: string): string => k.json.find((x: { name: string }) => x.name === name)?.api_key ?? ''
  expect(key('anon') === env.anon, 'anon is the project key, in full').toBe(true)
  const svc = key('service_role')
  expect(svc.endsWith(MASK), 'service_role is masked').toBe(true)
  expect(svc.length < 40, 'service_role is masked').toBe(true)
  if (env.service) expect(svc === env.service, 'service_role is not shown in full').toBe(false)
}
