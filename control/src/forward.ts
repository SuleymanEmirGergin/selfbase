// A project's admin API (spec 7.6): Studio calls /platform/projects/<ref>/admin/*, control authorizes the role and
// forwards to core:8081 over the project network with the project's ADMIN_TOKEN. Bodies are streamed both ways.
import type { Context } from 'hono'
import { authorize } from './authz.ts'
import type { Action } from './authz.ts'
import { pool } from './db.ts'
import { ApiError } from './errors.ts'
import { DESIRED_RUNNING } from './jobs/index.ts'
import { projectConfig } from './project-env.ts'
import { getSecrets } from './secrets.ts'
import type { Env } from './session.ts'

/** Mutable so tests can point it at a stub. */
export const forwardTarget = { url: (ref: string) => `http://sb-${ref}-core:8081` }

type Target = { id: string; ref: string; org_id: string; status: string }

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']
// the caller's credentials and identity never reach the project; content-length is recomputed by fetch
const DROP_REQUEST = new Set([...HOP, 'authorization', 'proxy-authorization', 'cookie', 'host', 'origin', 'referer', 'x-selfbase-actor',
  'content-length', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'])
const DROP_RESPONSE = new Set([...HOP, 'set-cookie'])
const HEADERS_MS = 120_000
const DEFAULT_UPLOAD = 50 * 1024 * 1024

const unreachable = () => new ApiError(502, 'project_unreachable', 'project is not reachable')

/** Sends one request to the project's core admin listener with its token, acting for `actor`. */
export async function adminFetch(p: Target, actor: string, url: URL, init: { method: string; headers?: Headers; body?: BodyInit | null }) {
  if (!DESIRED_RUNNING.includes(p.status)) throw new ApiError(409, 'project_not_running', `the project is ${p.status}`)
  const headers = init.headers ?? new Headers()
  headers.set('authorization', `Bearer ${(await getSecrets(pool, p)).ADMIN_TOKEN}`)
  headers.set('x-selfbase-actor', actor)
  // the timer covers the wait for response headers only: a long download or upload is not cut off
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), HEADERS_MS)
  try {
    return await fetch(url, { method: init.method, headers, body: init.body, redirect: 'manual', signal: ctl.signal, duplex: 'half' } as RequestInit)
  } finally {
    clearTimeout(timer)
  }
}

/** The admin path the way core will route it (decoded, slashes collapsed, case folded): for the permission check only. */
function actionFor(method: string, pathname: string): Action {
  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    throw new ApiError(400, 'invalid_path', 'the path is not valid')
  }
  if (path.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') === '/admin/sql') return 'project.sql'
  return method === 'GET' || method === 'HEAD' ? 'project.read' : 'project.write'
}

export async function forwardAdmin(c: Context<Env>, p: Target): Promise<Response> {
  const prefix = `/platform/projects/${p.ref}/admin`
  const incoming = new URL(c.req.url)
  if (!incoming.pathname.startsWith(`${prefix}/`)) throw new ApiError(404, 'not_found', 'not found')
  const url = new URL(`${forwardTarget.url(p.ref)}/admin${incoming.pathname.slice(prefix.length)}${incoming.search}`)
  // `..` (also as %2e%2e) is resolved by URL: whatever is left must still be under /admin
  if (!url.pathname.startsWith('/admin/')) throw new ApiError(404, 'not_found', 'not found')
  const method = c.req.method
  await authorize(c, actionFor(method, url.pathname), { orgId: p.org_id, projectId: p.id })

  const headers = new Headers()
  for (const [k, v] of c.req.raw.headers) if (!DROP_REQUEST.has(k)) headers.set(k, v)
  let body: BodyInit | null = null
  let over = false
  if (method !== 'GET' && method !== 'HEAD' && c.req.raw.body) {
    if (c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
      body = await c.req.arrayBuffer() // capped at 256 KiB by bodyCap and already parsed by audit (Hono caches it)
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
    res = await adminFetch(p, c.get('user').email, url, { method, headers, body })
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
    res = await adminFetch(p, actor, new URL(`${forwardTarget.url(p.ref)}/admin/sql`), {
      method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify({ query }),
    })
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw unreachable()
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status >= 500 ? 502 : 400, 'query_failed', String(data?.error ?? `the project answered ${res.status}`))
  return data
}
