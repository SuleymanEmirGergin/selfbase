import { Hono } from 'hono'
import { pool } from '../db.ts'
import { checkPassword, findById, hashPassword, SELECT_USER, toUserJson, withTx } from '../auth/users.ts'
import type { UserRow } from '../auth/users.ts'
import { adminError, audit, readBody } from './ident.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const userJson = (row: UserRow) => ({ ...toUserJson(row), banned_until: row.banned_until ?? null })
const userId = (id: string) => {
  if (!UUID_RE.test(id)) throw adminError(404, 'user not found')
  return id
}

const router = new Hono()

router.get('/users', async (c) => {
  const search = c.req.query('search') ?? ''
  const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit')) || 50))
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)
  const like = '%' + search.replace(/[\\%_]/g, '\\$&') + '%'
  const where = `where ($1 = '' or u.email ilike $2 or u.id::text = $1)`
  const [page, count] = await Promise.all([
    // with identities, so the panel's provider column shows google etc.
    pool.query(`${SELECT_USER} ${where} order by u.created_at desc, u.id limit $3 offset $4`, [search, like, limit, offset]),
    pool.query(`select count(*)::int as n from auth.users u ${where}`, [search, like]),
  ])
  return c.json({ users: page.rows.map(userJson), total: count.rows[0].n })
})

router.patch('/users/:id', async (c) => {
  const id = userId(c.req.param('id'))
  const b = await readBody(c)
  // validate everything before writing anything
  const ban = b.banned_until
  if (ban !== undefined && ban !== null && (typeof ban !== 'string' || Number.isNaN(Date.parse(ban))))
    throw adminError(400, 'banned_until must be an ISO date or null')
  if (b.email_confirmed !== undefined && b.email_confirmed !== true) throw adminError(400, 'email_confirmed can only be true')
  if (b.password !== undefined) checkPassword(b.password)
  const hash = b.password === undefined ? null : await hashPassword(b.password)

  await withTx(async (db) => {
    if (!(await db.query('select 1 from auth.users where id = $1 for update', [id])).rowCount) throw adminError(404, 'user not found')
    if (ban !== undefined) {
      await db.query('update auth.users set banned_until = $2, updated_at = now() where id = $1', [id, ban])
      // a ban ends every session at once (refresh fails, /user rejects the access token)
      if (ban !== null)
        await db.query('update auth.refresh_tokens set revoked = true, updated_at = now() where user_id = $1 and not revoked', [id])
    }
    if (b.email_confirmed)
      await db.query('update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = $1', [id])
    if (hash) await db.query('update auth.users set encrypted_password = $2, updated_at = now() where id = $1', [id, hash])
    await audit(db, 'users.update', id, {
      ...(ban !== undefined ? { banned_until: ban } : {}),
      ...(b.email_confirmed ? { email_confirmed: true } : {}),
      ...(hash ? { password: 'changed' } : {}),
    })
  })
  return c.json(userJson((await findById(id))!))
})

router.delete('/users/:id', async (c) => {
  const id = userId(c.req.param('id'))
  await withTx(async (db) => {
    // refresh tokens (sessions) and identities go with the user: on delete cascade
    if (!(await db.query('delete from auth.users where id = $1', [id])).rowCount) throw adminError(404, 'user not found')
    await audit(db, 'users.delete', id, {})
  })
  return c.json({})
})

export default router
