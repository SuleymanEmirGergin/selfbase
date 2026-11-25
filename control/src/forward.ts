// A project's admin API (spec 7.6): Studio calls /platform/projects/<ref>/admin/*, control authorizes the role and
// forwards to core:8081 over the project network with the project's ADMIN_TOKEN. Bodies are streamed both ways.
import type { Context } from 'hono'
import { isUpload } from './audit.ts'
import { authorize } from './authz.ts'
import type { Action } from './authz.ts'
import { pool } from './db.ts'
import { coreIp, forgetCoreIp } from './core-addr.ts'
import { ApiError } from './errors.ts'
import { provisioner } from './provisioner.ts'
import { DESIRED_RUNNING } from './jobs/index.ts'
import { CONFIG_DEFAULTS, projectConfig } from './project-env.ts'
import { getSecrets } from './secrets.ts'
import type { Env } from './session.ts'

/** core's admin listener, by its address on sb-<ref>-ctl (core-addr.ts). Mutable so tests can point it at a stub. */
export const forwardTarget: { url: (ref: string) => string | Promise<string> } = {
  url: async (ref) => `http://${await coreIp(provisioner(), ref)}:8081`,
}

type Target = { id: string; ref: string; org_id: string; status: string }

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']
// the caller's credentials and identity never reach the project; content-length is recomputed by fetch
const DROP_REQUEST = new Set([...HOP, 'authorization', 'proxy-authorization', 'cookie', 'host', 'origin', 'referer', 'x-selfbase-actor',
  'content-length', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'])
// location would name core's internal address
const DROP_RESPONSE = new Set([...HOP, 'set-cookie', 'location'])
const HEADERS_MS = 120_000
const DEFAULT_UPLOAD = 50 * 1024 * 1024

const unreachable = () => new ApiError(502, 'project_unreachable', 'project is not reachable')

/** Sends one request (`path`: /admin/..., with its query) to the project's core admin listener with its token, acting for `actor`. */
export async function adminFetch(p: Target, actor: string, path: string, init: { method: string; headers?: Headers; body?: BodyInit | null }) {
  if (!DESIRED_RUNNING.includes(p.status)) throw new ApiError(409, 'project_not_running', `the project is ${p.status}`)
  return adminRequest(p, actor, path, init)
}

/** adminFetch without the status check: for a job whose project is not running yet (an import's RESTORING). */
export async function adminRequest(p: Omit<Target, 'status'>, actor: string, path: string,
  init: { method: string; headers?: Headers; body?: BodyInit | null }, headersMs = HEADERS_MS) {
  const url = new URL(path, await forwardTarget.url(p.ref))
  const headers = init.headers ?? new Headers()
  headers.set('authorization', `Bearer ${(await getSecrets(pool, p)).ADMIN_TOKEN}`)
  headers.set('x-selfbase-actor', actor)
  // the timer covers the wait for response headers only: a long download or upload is not cut off
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), headersMs)
  try {
    return await fetch(url, { method: init.method, headers, body: init.body, redirect: 'manual', signal: ctl.signal, duplex: 'half' } as RequestInit)
  } catch (e) {
    forgetCoreIp(p.ref) // a recreated core has a new address
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// System, platform and extension schemas hold password verifiers (pg_authid), live query text (pg_stat_activity), job
// commands with keys (cron.job), migration SQL, tokens and decrypted secrets: reading them is as much as running SQL.
// Core reads them as the superuser, so the line is drawn here. read_only reads only user schemas: an allowlist
// (public plus the project's PGRST_DB_SCHEMAS), minus these even when listed. /admin/users (no secrets) stays a read.
const SYSTEM_SCHEMAS = new Set(['information_schema', 'auth', 'storage', 'realtime', 'vault', 'cron', 'net', 'pgmq', 'graphql',
  'extensions', 'supabase_migrations', 'supabase_functions', 'selfbase', 'pgsodium', 'pgbouncer'])
// case folded: refusing a user schema named like a system one (Pg_x, AUTH) only over-blocks
const isSystem = (schema: string) => {
  const s = schema.toLowerCase()
  return s.startsWith('pg_') || SYSTEM_SCHEMAS.has(s)
}

/** The schemas read_only may browse, as written: Postgres and PostgREST names are case-sensitive ("Public" is not public). */
async function userSchemas(projectId: string): Promise<Set<string>> {
  const exposed = String((await projectConfig(pool, projectId)).PGRST_DB_SCHEMAS ?? CONFIG_DEFAULTS.PGRST_DB_SCHEMAS)
  return new Set(['public', ...exposed.split(',').map((s) => s.trim())].filter((s) => s && !isSystem(s)))
}

/** The admin path the way core will route it (decoded, slashes collapsed, case folded): for the permission check only. */
async function actionFor(method: string, url: URL, projectId: string): Promise<Action> {
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    throw new ApiError(400, 'invalid_path', 'the path is not valid')
  }
  const canon = path.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  // the schema as core will look it up: exactly as written
  const rowSchema = /^\/admin\/rows\/([^/]+)\//i.exec(path.replace(/\/{2,}/g, '/'))?.[1]
  if (canon === '/admin/sql' || (rowSchema !== undefined && isSystem(rowSchema))) return 'project.sql'
  // writes need developer, which has project.sql as well: only reads have a schema line to draw
  if (method !== 'GET' && method !== 'HEAD') return 'project.write'
  // every read that names a schema: the rows, a schema's relations (with their columns), its policies
  const query = url.searchParams.getAll('schema')
  let schemas: string[] = []
  if (rowSchema !== undefined) schemas = [rowSchema]
  // core lists `public` for no schema or an empty one
  else if (canon === '/admin/tables') schemas = query.length ? query.map((s) => s || 'public') : ['public']
  // no schema (or an empty one) lists every schema's policies
  else if (canon === '/admin/policies') schemas = query.length ? query : ['']
  if (schemas.length) {
    const allowed = await userSchemas(projectId)
    if (!schemas.every((s) => allowed.has(s))) return 'project.sql'
  }
  return 'project.read'
}

export async function forwardAdmin(c: Context<Env>, p: Target): Promise<Response> {
  const prefix = `/platform/projects/${p.ref}/admin`
  const incoming = new URL(c.req.url)
  if (!incoming.pathname.startsWith(`${prefix}/`)) throw new ApiError(404, 'not_found', 'not found')
  // resolved against a placeholder: the checks need the path only, and core's address is looked up once authorized
  const url = new URL(`http://core/admin${incoming.pathname.slice(prefix.length)}${incoming.search}`)
  // `..` (also as %2e%2e) is resolved by URL: whatever is left must still be under /admin
  if (!url.pathname.startsWith('/admin/')) throw new ApiError(404, 'not_found', 'not found')
  const method = c.req.method
  await authorize(c, await actionFor(method, url, p.id), { orgId: p.org_id, projectId: p.id })
  // which admin call it was, without the query
  c.set('audit', { ...c.get('audit'), path: url.pathname })

  const headers = new Headers()
  for (const [k, v] of c.req.raw.headers) if (!DROP_REQUEST.has(k)) headers.set(k, v)
  let body: BodyInit | null = null
  let over = false
  if (method !== 'GET' && method !== 'HEAD' && c.req.raw.body) {
    if (!isUpload(c)) {
      body = await c.req.arrayBuffer() // capped at 256 KiB by bodyCap and already read by wholeBody (Hono caches it)
    } else {
      // uploads: streamed, under the project's own upload limit (core enforces it too)
      const max = Number((await projectConfig(pool, p.id)).STORAGE_MAX_UPLOAD_BYTES) || DEFAULT_UPLOAD
      if (Number(c.req.header('content-length')) > max) throw new ApiError(413, 'payload_too_large', `request body larger than ${max} bytes`)
      let seen = 0
      body = c.req.raw.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          seen += chunk.byteLength
          if (seen > max) {
            over = true
            out.error(new Error('too large'))
          } else out.enqueue(chunk)
        },
      }))
    }
  }

  let res: Response
  try {
    res = await adminFetch(p, c.get('user').email, url.pathname + url.search, { method, headers, body })
  } catch (e) {
    if (over) throw new ApiError(413, 'payload_too_large', 'request body too large')
    if (e instanceof ApiError) throw e
    throw unreachable()
  }
  const out = new Headers()
  for (const [k, v] of res.headers) if (!DROP_RESPONSE.has(k)) out.set(k, v)
  // fetch has already decoded a compressed body: its encoding and length no longer apply
  if (out.has('content-encoding')) {
    out.delete('content-encoding')
    out.delete('content-length')
  }
  return new Response(res.body, { status: res.status, headers: out })
}

/** POST /admin/sql for /v1's database/query: the result as core gives it. */
export async function adminSql(p: Target, actor: string, query: string): Promise<{ columns?: string[]; rows?: unknown[][]; error?: { message: string } }> {
  let res: Response
  try {
    res = await adminFetch(p, actor, '/admin/sql', {
      method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify({ query }),
    })
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw unreachable()
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status >= 500 ? 502 : 400, 'query_failed', String(data?.error?.message ?? data?.error ?? `the project answered ${res.status}`))
  return data
}
