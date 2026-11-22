import { Hono } from 'hono'
import { pool } from '../db.ts'
import { adminError, audit, readBody } from './ident.ts'
import { rowTypes } from './tables.ts'

const MAX_ROWS = 1000

const router = new Hono()

// Runs the operator's SQL as the database superuser, by design: the panel operator owns the database.
router.post('/sql', async (c) => {
  const { query } = await readBody(c)
  if (typeof query !== 'string' || !query.trim()) throw adminError(400, 'query is required')
  const client = await pool.connect()
  const started = performance.now()
  let out: Record<string, unknown>
  try {
    await client.query('begin')
    await client.query(`set local statement_timeout = '30s'`)
    // shortcut: the whole result is read into memory before the 1000-row cap; use a cursor if huge selects hurt
    const res = await client.query({ text: query, rowMode: 'array', types: rowTypes })
    await client.query('commit')
    const last = Array.isArray(res) ? res[res.length - 1] : res // a multi-statement script returns one result per statement
    out = {
      columns: (last.fields ?? []).map((f: { name: string }) => f.name),
      rows: last.rows.slice(0, MAX_ROWS),
      rowCount: last.rowCount,
      durationMs: Math.round(performance.now() - started),
      ...(last.rows.length > MAX_ROWS ? { truncated: true } : {}),
    }
  } catch (err: any) {
    await client.query('rollback').catch(() => {})
    out = { error: { message: err.message, position: err.position ? Number(err.position) : null, hint: err.hint ?? null } }
  } finally {
    // the script may change session state (SET, SET ROLE, temp tables, LISTEN): never hand this connection back
    client.release(true)
  }
  await audit(pool, 'sql', null, { query: query.slice(0, 2000), ...('error' in out ? { error: (out.error as any).message } : {}) })
  return c.json(out)
})

export default router
