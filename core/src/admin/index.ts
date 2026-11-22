import pg from 'pg'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { StorageError } from '../storage/paths.ts'
import session, { panelRoutes, requirePanel, sameOrigin } from './session.ts'
import tables from './tables.ts'
import policies from './policies.ts'
import sql from './sql.ts'
import users from './users.ts'
import files from './files.ts'

// Admin panel API, mounted at /admin in app.ts. It runs on the superuser pool on purpose (the operator owns the
// database), so everything except POST /login sits behind requirePanel; Authorization/apikey are never consulted.
const router = new Hono()

router.onError((err) => {
  if (err instanceof HTTPException) return err.getResponse()
  if (err instanceof StorageError) return Response.json({ error: err.message }, { status: err.status })
  const e = err as { code?: string; message: string }
  if (e.code === '23505') return Response.json({ error: e.message, code: e.code }, { status: 409 })
  // any other Postgres error (bad value, constraint, invalid policy expression) is the request's fault
  if (err instanceof pg.DatabaseError) return Response.json({ error: e.message, code: e.code }, { status: 400 })
  console.error(err)
  return Response.json({ error: 'internal error' }, { status: 500 })
})

router.use('*', sameOrigin)
router.route('/', session) // POST /login, the only public route
router.use('*', requirePanel)
router.route('/', panelRoutes)
router.route('/', tables)
router.route('/', policies)
router.route('/', sql)
router.route('/', users)
router.route('/', files)

export default router
