import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { proxy } from 'hono/proxy'
import { serveStatic } from '@hono/node-server/serve-static'
import { config } from './config.ts'
import authRouter from './auth/index.ts'
import storageRouter from './storage/index.ts'
import realtimeRouter from './realtime/index.ts'
import adminRouter from './admin/index.ts'

export const app = new Hono()

app.use(
  '*',
  cors({
    origin: '*',
    // no allowHeaders: Hono echoes Access-Control-Request-Headers, so every supabase-js header passes
    exposeHeaders: ['content-range'],
  }),
)

app.get('/health', (c) => c.json({ ok: true }))

app.route('/auth/v1', authRouter)
app.route('/storage/v1', storageRouter)
app.route('/realtime/v1', realtimeRouter)
app.route('/admin', adminRouter)

/** Forwards the request to target with the mount prefix stripped from the path. */
const forward = (target: string, prefix: string) => async (c: Context) => {
  const url = new URL(c.req.url)
  try {
    return await proxy(target + (url.pathname.slice(prefix.length) || '/') + url.search, { raw: c.req.raw })
  } catch {
    return c.json({ error: 'upstream_unavailable' }, 502)
  }
}
app.all('/rest/v1/*', forward(config.pgrstUrl, '/rest/v1'))
app.all('/functions/v1/*', forward(config.fnUrl, '/functions/v1'))

app.use('/panel/*', serveStatic({ root: config.panelDir, rewriteRequestPath: (p) => p.slice('/panel'.length) }))
