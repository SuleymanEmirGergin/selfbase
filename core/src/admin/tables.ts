import pg from 'pg'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { pool } from '../db.ts'
import { withTx } from '../auth/users.ts'
import { adminError, audit, column, getRelation, listRelations, q, qrel, readBody } from './ident.ts'
import type { Relation } from './ident.ts'

// Values JSON represents exactly keep pg's parser; everything else (bigint, numeric, bytea, dates, arrays...)
// stays the database's text form, which the write path below casts straight back.
const KEEP = new Set([16, 21, 23, 700, 701, 114, 3802]) // bool, int2, int4, float4, float8, json, jsonb
export const rowTypes = {
  getTypeParser: (oid: number, format?: any) => (KEEP.has(oid) ? pg.types.getTypeParser(oid, format) : (v: string) => v),
}

const OPS: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike', is: 'is' }
const IS_VALUES: Record<string, string> = { null: 'null', true: 'true', false: 'false' }

/** Parameter text for a JSON value, cast by the caller to the column type. */
const asText = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v))

const int = (v: string | undefined, dflt: number, max: number) => {
  const n = v === undefined || v === '' ? dflt : Number(v)
  if (!Number.isInteger(n) || n < 0) throw adminError(400, 'limit and offset must be non-negative integers')
  return Math.min(n, max)
}

/** `col = $n::type and ...` for the full primary key; 400 when the table has none or pk does not match it. */
function pkWhere(rel: Relation, pk: unknown, params: unknown[]): string {
  const pkCols = rel.columns.filter((c) => c.is_pk)
  if (!pkCols.length) throw adminError(400, 'table has no primary key')
  if (!pk || typeof pk !== 'object' || Array.isArray(pk)) throw adminError(400, 'pk must be an object')
  const keys = Object.keys(pk)
  if (keys.length !== pkCols.length || !pkCols.every((c) => keys.includes(c.name)))
    throw adminError(400, `pk must give exactly the primary key columns: ${pkCols.map((c) => c.name).join(', ')}`)
  return pkCols.map((c) => {
    params.push(asText((pk as any)[c.name]))
    return `${q(c.name)} = $${params.length}::${c.type}`
  }).join(' and ')
}

function valuesOf(body: Record<string, any>): Record<string, unknown> {
  const v = body.values
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw adminError(400, 'values must be an object')
  return v
}

const relOf = (c: Context) => getRelation(c.req.param('schema')!, c.req.param('table')!)

const router = new Hono()

router.get('/schemas', async (c) => {
  const { rows } = await pool.query(
    `select nspname from pg_namespace where nspname not like 'pg\\_%' and nspname <> 'information_schema' order by 1`)
  return c.json(rows.map((r) => r.nspname))
})

router.get('/tables', async (c) => c.json(await listRelations(c.req.query('schema') || 'public')))

router.get('/rows/:schema/:table', async (c) => {
  const rel = await relOf(c)
  const limit = int(c.req.query('limit'), 50, 1000)
  const offset = int(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER)
  const params: unknown[] = []
  const where = c.req.queries('filter')?.map((f) => {
    const m = f.match(/^(.+?)\.(eq|neq|gt|gte|lt|lte|like|ilike|is)\.(.*)$/s)
    if (!m) throw adminError(400, `bad filter: expected column.operator.value with one of ${Object.keys(OPS).join(', ')}`)
    const col = column(rel, m[1])
    if (m[2] === 'is') {
      if (!Object.hasOwn(IS_VALUES, m[3])) throw adminError(400, 'is takes null, true or false')
      return `${q(col.name)} is ${IS_VALUES[m[3]]}`
    }
    params.push(m[3])
    // like/ilike compare text; the others cast the value to the column type so the database parses it
    return m[2] === 'like' || m[2] === 'ilike'
      ? `${q(col.name)}::text ${OPS[m[2]]} $${params.length}`
      : `${q(col.name)} ${OPS[m[2]]} $${params.length}::${col.type}`
  })
  const whereSql = where?.length ? ` where ${where.join(' and ')}` : ''
  const order = c.req.query('order')
  let orderSql = ''
  if (order) {
    const m = order.match(/^(.+)\.(asc|desc)$/s)
    if (!m) throw adminError(400, 'bad order: expected column.asc or column.desc')
    orderSql = ` order by ${q(column(rel, m[1]).name)} ${m[2]}`
  } else {
    const pk = rel.columns.filter((col) => col.is_pk)
    if (pk.length) orderSql = ` order by ${pk.map((col) => q(col.name)).join(', ')}` // stable paging
  }
  // shortcut: exact count(*) on every page; switch to row_estimate for very large tables
  const [rows, total] = await Promise.all([
    pool.query({ text: `select * from ${qrel(rel)}${whereSql}${orderSql} limit ${limit} offset ${offset}`, values: params, types: rowTypes }),
    pool.query(`select count(*)::float8 as n from ${qrel(rel)}${whereSql}`, params),
  ])
  return c.json({ rows: rows.rows, total: total.rows[0].n })
})

router.post('/rows/:schema/:table', async (c) => {
  const rel = await relOf(c)
  const values = valuesOf(await readBody(c))
  const cols = Object.keys(values).map((k) => column(rel, k))
  const params = cols.map((col) => asText(values[col.name]))
  const sql = cols.length
    ? `insert into ${qrel(rel)} (${cols.map((col) => q(col.name)).join(', ')}) values (${cols.map((col, i) => `$${i + 1}::${col.type}`).join(', ')}) returning *`
    : `insert into ${qrel(rel)} default values returning *`
  const row = await withTx(async (db) => {
    const r = (await db.query({ text: sql, values: params, types: rowTypes })).rows[0]
    await audit(db, 'rows.insert', `${rel.schema}.${rel.name}`, { columns: cols.map((col) => col.name) })
    return r
  })
  return c.json(row)
})

router.patch('/rows/:schema/:table', async (c) => {
  const rel = await relOf(c)
  const body = await readBody(c)
  const values = valuesOf(body)
  const cols = Object.keys(values).map((k) => column(rel, k))
  if (!cols.length) throw adminError(400, 'values must not be empty')
  const params: unknown[] = cols.map((col) => asText(values[col.name]))
  const set = cols.map((col, i) => `${q(col.name)} = $${i + 1}::${col.type}`).join(', ')
  const where = pkWhere(rel, body.pk, params)
  const row = await withTx(async (db) => {
    const r = (await db.query({ text: `update ${qrel(rel)} set ${set} where ${where} returning *`, values: params, types: rowTypes })).rows[0]
    if (!r) throw adminError(404, 'row not found')
    await audit(db, 'rows.update', `${rel.schema}.${rel.name}`, { pk: body.pk, columns: cols.map((col) => col.name) })
    return r
  })
  return c.json(row)
})

router.delete('/rows/:schema/:table', async (c) => {
  const rel = await relOf(c)
  const body = await readBody(c)
  const params: unknown[] = []
  const where = pkWhere(rel, body.pk, params)
  const row = await withTx(async (db) => {
    const r = (await db.query({ text: `delete from ${qrel(rel)} where ${where} returning *`, values: params, types: rowTypes })).rows[0]
    if (!r) throw adminError(404, 'row not found')
    await audit(db, 'rows.delete', `${rel.schema}.${rel.name}`, { pk: body.pk })
    return r
  })
  return c.json(row)
})

export default router
