// Run in a container with FUNCTIONS_DIR pointing at test/fixtures/supabase/functions,
// JWT_SECRET set and the client stub mounted at /client (see docs/functions-status.md).
import { handle } from '../main.ts'

const secret = Deno.env.get('JWT_SECRET')!

function eq(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

async function sign(payload: Record<string, unknown>, key = secret) {
  const enc = new TextEncoder()
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = b64url(enc.encode(JSON.stringify(payload)))
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(`${head}.${body}`)))
  return `${head}.${body}.${b64url(sig)}`
}

const exp = () => Math.floor(Date.now() / 1000) + 3600

async function call(path: string, init: RequestInit = {}) {
  const res = await handle(new Request(`http://fn:8000${path}`, init))
  return { status: res.status, text: await res.text() }
}

Deno.test('hello answers 200 under /<name> and /<name>/*', async () => {
  const a = await call('/hello')
  eq(a.status, 200)
  eq(JSON.parse(a.text).path, '/hello')
  const b = await call('/hello/sub/path?x=1', { method: 'POST', body: '{}' })
  eq(b.status, 200)
  eq(JSON.parse(b.text).path, '/hello/sub/path')
})

Deno.test('a /functions/v1 prefix is stripped', async () => {
  const r = await call('/functions/v1/hello/x')
  eq(r.status, 200)
  eq(JSON.parse(r.text).path, '/hello/x')
})

Deno.test('verify_jwt=true: no token 401, valid token 200', async () => {
  eq((await call('/private')).status, 401)
  const token = await sign({ role: 'authenticated', sub: 'u1', exp: exp() })
  const r = await call('/private', { headers: { Authorization: `Bearer ${token}` } })
  eq(r.status, 200)
  eq(r.text, 'private ok')
})

Deno.test('verify_jwt defaults to true for a function missing from config.toml', async () => {
  eq((await call('/unlisted')).status, 401)
})

Deno.test('verify_jwt=true rejects bad signature, missing exp, expired, foreign role', async () => {
  const bad = [
    await sign({ role: 'anon', exp: exp() }, 'another-secret-another-secret-123'),
    await sign({ role: 'anon' }),
    await sign({ role: 'anon', exp: Math.floor(Date.now() / 1000) - 10 }),
    await sign({ role: 'postgres', exp: exp() }),
    'not.a.jwt',
  ]
  for (const t of bad) eq((await call('/private', { headers: { Authorization: `Bearer ${t}` } })).status, 401)
})

Deno.test('verify_jwt=true still lets CORS preflight through', async () => {
  eq((await call('/private', { method: 'OPTIONS' })).status, 200)
})

Deno.test('verify_jwt=false: no token 200', async () => {
  const r = await call('/public')
  eq(r.status, 200)
  eq(r.text, 'public ok')
})

Deno.test('std@0.168.0 serve() is captured like Deno.serve', async () => {
  const r = await call('/std-serve', { headers: { Authorization: `Bearer ${await sign({ role: 'anon', exp: exp() })}` } })
  eq(r.status, 200)
  eq(r.text, 'std ok')
})

Deno.test('function that throws at import gives 500 {error}, others keep working', async () => {
  const log = console.error
  console.error = () => {} // the host logs the failure; keep test output clean
  const r = await call('/broken').finally(() => (console.error = log))
  eq(r.status, 500)
  eq(JSON.parse(r.text).error.includes('boom at import'), true)
  eq((await call('/hello')).status, 200)
})

Deno.test('supabase-js import resolves to the selfbase client', async () => {
  const r = await call('/uses-client')
  eq(r.status, 200)
  eq(JSON.parse(r.text).selfbase, true)
})

Deno.test('unknown or invalid names are 404', async () => {
  eq((await call('/nope')).status, 404)
  eq((await call('/_shared')).status, 404)
  eq((await call('/..%2Fetc')).status, 404)
  eq((await call('/')).status, 404)
})
