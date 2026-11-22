// Throwaway values matching compose.test.yml. Never real secrets.
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const TEST_JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long'
export const REST_URL = `http://localhost:${process.env.TEST_REST_PORT ?? '54432'}`
const COMPOSE_PROJECT = process.env.TEST_COMPOSE_PROJECT ?? 'sb-t8'

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url')

export function signJwt(claims: Record<string, unknown>, expiresInSec = 3600): string {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iat: now, exp: now + expiresInSec, ...claims }))
  const sig = createHmac('sha256', TEST_JWT_SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

export const ANON_KEY = signJwt({ role: 'anon', iss: 'selfbase' }, 365 * 24 * 3600)
export const SERVICE_KEY = signJwt({ role: 'service_role', iss: 'selfbase' }, 365 * 24 * 3600)

/** Runs SQL in the test stack's db container as postgres. */
export function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['compose', '-p', COMPOSE_PROJECT, '-f', process.env.TEST_COMPOSE_FILE ?? '../compose.test.yml', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'],
    { input: `set client_min_messages to warning;\n${sql}`, encoding: 'utf8' },
  )
}

// captured before any test installs fake timers, so waiting keeps working under vi.useFakeTimers
const realSetTimeout = globalThis.setTimeout
const realNow = performance.now.bind(performance)

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = realNow()
  while (!(await check())) {
    if (realNow() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => realSetTimeout(r, 10))
  }
}

/** Minimal browser globals so the client takes its browser paths (localStorage, URL hash, storage events). */
export function installBrowser(href = 'http://localhost:5173/') {
  const store = new Map<string, string>()
  const listeners: ((e: any) => void)[] = []
  const url = new URL(href)
  const location = {
    get href() {
      return url.href
    },
    get hash() {
      return url.hash
    },
    get pathname() {
      return url.pathname
    },
    get search() {
      return url.search
    },
    origin: url.origin,
    assigned: [] as string[],
    assign(to: string) {
      this.assigned.push(to)
    },
  }
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  const window = {
    location,
    localStorage,
    history: { state: null, replaceState: (_s: unknown, _t: string, to: string) => (url.href = new URL(to, url).href) },
    addEventListener: (type: string, fn: (e: any) => void) => type === 'storage' && listeners.push(fn),
  }
  Object.assign(globalThis, { window, document: {} })
  return {
    window,
    store,
    location,
    /** Simulates another tab writing the session key. */
    fireStorage: (key: string, newValue: string | null) => listeners.forEach((fn) => fn({ key, newValue })),
    uninstall: () => {
      delete (globalThis as any).window
      delete (globalThis as any).document
    },
  }
}
