// selfbase function host: runs supabase/functions/<name>/index.ts unmodified in one Deno process.
import { pathToFileURL } from 'node:url'
import { functionsDir, jwtSecret, port, verifyJwt } from './config.ts'

type Handler = (req: Request, info?: Deno.ServeHandlerInfo) => Response | Promise<Response>

const ROLES = new Set(['anon', 'authenticated', 'service_role'])
const NAME = /^[a-z0-9][a-z0-9_-]*$/i
const enc = new TextEncoder()
const dec = new TextDecoder()

const realServe = Deno.serve.bind(Deno)
const handlers = new Map<string, Handler>()
let loading: string | null = null
let queue: Promise<unknown> = Promise.resolve()

// Functions call Deno.serve at import time; record the handler under the function being imported instead of listening.
// deno-lint-ignore no-explicit-any
;(Deno as any).serve = (a: unknown, b?: unknown) => {
  // deno-lint-ignore no-explicit-any
  const handler = typeof a === 'function' ? a : typeof b === 'function' ? b : (a as any)?.handler
  if (!loading || typeof handler !== 'function') throw new Error('Deno.serve is only available while a function is loading')
  handlers.set(loading, handler as Handler)
  const addr = { transport: 'tcp', hostname: '0.0.0.0', port }
  return { finished: new Promise<void>(() => {}), shutdown: async () => {}, ref() {}, unref() {}, addr }
}

// A function's stray background error must not take the host (and every other function) down.
addEventListener('unhandledrejection', (e) => {
  console.error('unhandled rejection in a function:', e.reason)
  e.preventDefault()
})
addEventListener('error', (e) => {
  console.error('uncaught error in a function:', e.error)
  e.preventDefault()
})

/** Imports one function at a time so each Deno.serve call is attributed to the right name. */
function load(name: string): Promise<void> {
  // shortcut: one slow import (remote module download) delays other first loads, fine for ~25 functions.
  const run = queue.then(async () => {
    if (handlers.has(name)) return
    loading = name
    try {
      await import(pathToFileURL(`${functionsDir}/${name}/index.ts`).href)
    } finally {
      loading = null
    }
    if (!handlers.has(name)) throw new Error(`function ${name} did not call Deno.serve`)
  })
  queue = run.catch(() => {})
  return run
}

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
let key: Promise<CryptoKey> | null = null

/** HS256 with our JWT_SECRET; exp is required and the role must be one PostgREST knows. */
async function validJwt(header: string | null): Promise<boolean> {
  const parts = header?.match(/^Bearer\s+(\S+)$/i)?.[1].split('.')
  if (!parts || parts.length !== 3) return false
  try {
    if (JSON.parse(dec.decode(b64(parts[0]))).alg !== 'HS256') return false
    key ??= crypto.subtle.importKey('raw', enc.encode(jwtSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    if (!(await crypto.subtle.verify('HMAC', await key, b64(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`)))) return false
    const claims = JSON.parse(dec.decode(b64(parts[1])))
    return typeof claims.exp === 'number' && claims.exp > Date.now() / 1000 && ROLES.has(claims.role)
  } catch {
    return false
  }
}

async function exists(name: string): Promise<boolean> {
  try {
    return (await Deno.stat(`${functionsDir}/${name}/index.ts`)).isFile
  } catch {
    return false
  }
}

export async function handle(req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/functions\/v1(?=\/)/, '')
  const name = path.split('/')[1] ?? ''
  if (!NAME.test(name) || !(await exists(name))) return Response.json({ error: 'function not found' }, { status: 404 })

  // Preflight carries no Authorization header; the function answers it with its own CORS headers.
  if (req.method !== 'OPTIONS' && (verifyJwt[name] ?? true) && !(await validJwt(req.headers.get('authorization')))) {
    return Response.json({ code: 401, message: 'Invalid JWT' }, { status: 401 })
  }

  if (path !== url.pathname) {
    url.pathname = path
    req = new Request(url, req)
  }
  try {
    await load(name)
    return await handlers.get(name)!(req, info)
  } catch (e) {
    console.error(`function ${name} failed:`, e)
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

if (import.meta.main) {
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be set (at least 32 characters)')
  for await (const entry of Deno.readDir(functionsDir)) {
    // shortcut: a function's own deno.json/import_map.json is not merged (CorteQS has none); merge when one appears.
    for (const f of ['deno.json', 'deno.jsonc', 'import_map.json']) {
      if (await Deno.stat(`${functionsDir}/${entry.name}/${f}`).then(() => true, () => false)) {
        console.warn(`${entry.name}/${f} is ignored; add its imports to fn/import_map.json`)
      }
    }
  }
  realServe({ port, hostname: '0.0.0.0' }, handle)
}
