import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { proxy } from 'hono/proxy'
import { bodyLimit } from 'hono/body-limit'
import { config } from './config.ts'
import { pool } from './db.ts'
import { clientIp } from './ip.ts'
import authRouter from './auth/index.ts'
import storageRouter from './storage/index.ts'
import realtimeRouter from './realtime/index.ts'
import adminRouter from './admin/index.ts'
import { requestLog } from './log.ts'

export const app = new Hono()

app.use('*', requestLog('core'))
app.use(
  '*',
  cors({
    origin: '*',
    // no allowHeaders: Hono echoes Access-Control-Request-Headers, so every supabase-js header passes
    exposeHeaders: ['content-range'],
  }),
)

app.get('/health', async (c) => {
  try {
    await pool.query('select 1')
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false, error: 'database unavailable' }, 503)
  }
})

// core's own JSON routes read whole bodies; uploads (storage, admin files) have their own STORAGE_MAX_UPLOAD_BYTES limit
const jsonLimit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'request body too large' }, 413) })
app.use('/auth/v1/*', jsonLimit)

app.route('/auth/v1', authRouter)
app.route('/storage/v1', storageRouter)
app.route('/realtime/v1', realtimeRouter)

// Client-supplied IP headers never reach PostgREST or the functions (SQL and functions read them for rate limits);
// they are replaced by the IP core trusts (ip.ts).
const SPOOFABLE = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'forwarded']
const IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']

/** Forwards the request to target with the mount prefix stripped from the path. */
const forward = (target: () => string, prefix: string) => async (c: Context) => {
  const url = new URL(c.req.url)
  const ip = clientIp(c)
  try {
    return await proxy(target() + (url.pathname.slice(prefix.length) || '/') + url.search, {
      raw: c.req.raw,
      customFetch: (req) => {
        for (const h of SPOOFABLE) req.headers.delete(h)
        for (const h of IP_HEADERS) req.headers.set(h, ip)
        return fetch(req)
      },
    })
  } catch {
    return c.json({ error: 'upstream_unavailable' }, 502)
  }
}
app.all('/rest/v1/*', forward(() => config.pgrstUrl, '/rest/v1'))

// Function responses share the API's origin: no sniffing, and a sandbox unless the function sets its own CSP,
// so an HTML response can never script same-origin calls to the other services.
app.all('/functions/v1/*', async (c, next) => {
  await next()
  c.res.headers.set('x-content-type-options', 'nosniff')
  if (!c.res.headers.has('content-security-policy')) c.res.headers.set('content-security-policy', 'sandbox')
}, forward(() => config.fnUrl, '/functions/v1'))

// Admin API on its own listener (server.ts, ADMIN_PORT): the project network only, never the proxy (AC-5).
export const adminApp = new Hono()
// 403 is only admin_forbidden: a peer outside the /27; a line each would let a neighbour fill the log store
adminApp.use('*', requestLog('core-admin', [403]))
adminApp.use('/admin/*', async (c, next) => (/^\/admin\/files\//.test(c.req.path) ? next() : jsonLimit(c, next)))
adminApp.route('/admin', adminRouter)
