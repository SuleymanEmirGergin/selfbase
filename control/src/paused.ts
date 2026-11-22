// Hosts (spec 7.3): control's low-priority catch-all router sends every host of the base domain here. Only PUBLIC_URL's
// host reaches Studio and the API; the host of a project that is not running gets Supabase's 540, any other 404.
import { createMiddleware } from 'hono/factory'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { config } from './config.ts'
import { pool } from './db.ts'
import { DESIRED_RUNNING } from './jobs/engine.ts'

const bare = (h: string) => h.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export const paused = createMiddleware(async (c, next) => {
  const header = c.req.header('host')
  // @hono/node-server refuses a request without Host, so only an in-process app.request (tests) has none
  if (header === undefined) return next()
  const host = bare(header)
  if (host === bare(new URL(config.publicUrl).hostname)) return next()
  // the container's own health check
  if (LOOPBACK.has(host) && c.req.path === '/health') return next()
  // any project not meant to serve now (paused, pausing, restoring, failed at either), short of removed
  const { rowCount } = await pool.query(
    `select 1 from control.project_domains d join control.projects p on p.id = d.project_id
      where d.hostname = $1 and p.status <> all($2) and p.status <> 'REMOVED'`,
    [host, DESIRED_RUNNING],
  )
  return rowCount ? c.json({ message: 'project paused' }, 540 as ContentfulStatusCode) : c.json({ message: 'not found' }, 404)
})
