// HTTP surface: management API at /v1, Studio-only endpoints at /platform, Studio's static build at /.
import './core-env.ts'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { config } from './config.ts'
import { notFound, onError } from './errors.ts'
import { audit, bodyCap } from './audit.ts'
import { authenticate } from './session.ts'
import { platformAuth } from './routes/platform-auth.ts'
import { platformOrgs, v1Orgs } from './routes/platform-orgs.ts'
import { platformProjects } from './routes/platform-projects.ts'
import { platformTransfer } from './routes/platform-transfer.ts'
import { v1 } from './routes/v1.ts'

export const app = new Hono()
app.onError(onError)
app.notFound(notFound)

app.get('/health', (c) => c.json({ ok: true }))

// size cap before anything parses a JSON body; then audit, so refused writes are recorded too
app.use('/platform/*', bodyCap, audit, authenticate('platform'))
app.use('/v1/*', bodyCap, audit, authenticate('v1'))

app.route('/platform', platformAuth)
app.route('/platform', platformOrgs)
app.route('/platform', platformProjects)
app.route('/platform', platformTransfer)
app.route('/v1', v1Orgs)
app.route('/v1', v1)

// Studio: a file if one exists, else index.html for client routes. API paths never get either: an unknown one is a
// JSON 404, so a client never mistakes the Studio page for an API answer.
if (config.studioDir) {
  const api = /^\/(platform|v1|health)(\/|$)/
  const files = serveStatic({ root: config.studioDir })
  const index = serveStatic({ root: config.studioDir, path: 'index.html' })
  app.use('*', (c, next) => (api.test(c.req.path) ? next() : files(c, next)))
  app.get('*', (c, next) => (api.test(c.req.path) ? next() : index(c, next)))
}
