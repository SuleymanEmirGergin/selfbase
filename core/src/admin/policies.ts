import { Hono } from 'hono'
import { pool } from '../db.ts'
import { withTx } from '../auth/users.ts'
import { adminError, audit, getRelation, q, qrel, readBody } from './ident.ts'

const COMMANDS = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']
const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v) throw adminError(400, `${name} is required`)
  return v
}
const relFrom = (b: Record<string, any>) => getRelation(str(b.schema, 'schema'), str(b.table, 'table'))

const router = new Hono()

router.get('/policies', async (c) => {
  const { rows } = await pool.query(
    `select policyname as name, schemaname as schema, tablename as table, cmd as command, roles::text[] as roles,
       qual as using, with_check as check, permissive = 'PERMISSIVE' as permissive
     from pg_policies where ($1::text is null or schemaname = $1) and ($2::text is null or tablename = $2)
     order by schemaname, tablename, policyname`,
    [c.req.query('schema') || null, c.req.query('table') || null],
  )
  return c.json(rows)
})

router.post('/policies', async (c) => {
  const b = await readBody(c)
  const rel = await relFrom(b)
  const name = str(b.name, 'name')
  const command = String(b.command ?? 'ALL').toUpperCase()
  if (!COMMANDS.includes(command)) throw adminError(400, `command must be one of ${COMMANDS.join(', ')}`)
  const roles: unknown = b.roles ?? ['public']
  if (!Array.isArray(roles) || !roles.length || !roles.every((r) => typeof r === 'string'))
    throw adminError(400, 'roles must be a non-empty array of role names')
  const known = new Set((await pool.query('select rolname from pg_roles where rolname = any($1)', [roles])).rows.map((r) => r.rolname))
  const unknown = roles.filter((r) => r !== 'public' && !known.has(r))
  if (unknown.length) throw adminError(400, `unknown roles: ${unknown.join(', ')}`)
  if (b.using !== undefined && typeof b.using !== 'string') throw adminError(400, 'using must be a string')
  if (b.check !== undefined && typeof b.check !== 'string') throw adminError(400, 'check must be a string')
  // using/check are SQL expressions the panel operator writes, inserted as text by design: the operator is the
  // database owner and already has the SQL runner, so this is the same trust level, not an injection surface.
  const sql = `create policy ${q(name)} on ${qrel(rel)} as ${b.permissive === false ? 'restrictive' : 'permissive'} for ${command}
    to ${roles.map((r) => (r === 'public' ? 'public' : q(r))).join(', ')}`
    + (b.using ? ` using (${b.using})` : '') + (b.check ? ` with check (${b.check})` : '')
  await withTx(async (db) => {
    await db.query(sql)
    await audit(db, 'policies.create', `${rel.schema}.${rel.name}`, { name, command, roles, using: b.using ?? null, check: b.check ?? null })
  })
  return c.json({})
})

router.delete('/policies', async (c) => {
  const b = await readBody(c)
  const rel = await relFrom(b)
  const name = str(b.name, 'name')
  await withTx(async (db) => {
    const exists = await db.query('select 1 from pg_policies where schemaname = $1 and tablename = $2 and policyname = $3', [rel.schema, rel.name, name])
    if (!exists.rowCount) throw adminError(404, 'policy not found')
    await db.query(`drop policy ${q(name)} on ${qrel(rel)}`)
    await audit(db, 'policies.drop', `${rel.schema}.${rel.name}`, { name })
  })
  return c.json({})
})

router.post('/rls', async (c) => {
  const b = await readBody(c)
  const rel = await relFrom(b)
  if (typeof b.enabled !== 'boolean') throw adminError(400, 'enabled must be a boolean')
  await withTx(async (db) => {
    await db.query(`alter table ${qrel(rel)} ${b.enabled ? 'enable' : 'disable'} row level security`)
    await audit(db, 'rls.set', `${rel.schema}.${rel.name}`, { enabled: b.enabled })
  })
  return c.json({})
})

export default router
