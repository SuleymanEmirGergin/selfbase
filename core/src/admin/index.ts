import pg from 'pg'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { contextStorage } from 'hono/context-storage'
import { StorageError } from '../storage/paths.ts'
import { logLine } from '../log.ts'
import { requireAdminToken } from './auth.ts'
import tables from './tables.ts'
import policies from './policies.ts'
import sql from './sql.ts'
import users from './users.ts'
import files from './files.ts'

// Admin API, mounted at /admin on the private admin listener (app.ts adminApp), never on the public port. It runs
// on the superuser pool on purpose (the project owner owns the database), so every route sits behind the admin token.
const router = new Hono()

router.onError((err) => {
  if (err instanceof HTTPException) return err.getResponse()
  if (err instanceof StorageError) return Response.json({ error: err.message }, { status: err.status })
  const e = err as { code?: string; message: string }
  if (e.code === '23505') return Response.json({ error: e.message, code: e.code }, { status: 409 })
  // any other Postgres error (bad value, constraint, invalid policy expression) is the request's fault
  if (err instanceof pg.DatabaseError) return Response.json({ error: e.message, code: e.code }, { status: 400 })
  logLine('error', 'admin: unhandled error', { error: String(err.stack ?? err) })
  return Response.json({ error: 'internal error' }, { status: 500 })
})

router.use('*', requireAdminToken)
router.use('*', contextStorage()) // audit() reads the request's actor from it
router.get('/ready', (c) => c.json({ ok: true }))
router.route('/', tables)
router.route('/', policies)
router.route('/', sql)
router.route('/', users)
router.route('/', files)

export default router
