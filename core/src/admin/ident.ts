import pg from 'pg'
import type { PoolClient } from 'pg'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { pool } from '../db.ts'

/** Admin API error body: {error}. */
export const adminError = (status: ContentfulStatusCode, error: string) =>
  new HTTPException(status, { res: Response.json({ error }, { status }) })

export type Column = { name: string; type: string; nullable: boolean; default: string | null; is_pk: boolean }
/** relkind: r table, p partitioned table, v view, m materialized view, f foreign table (pg_class.relkind). */
export type Relation = { schema: string; name: string; relkind: string; rls_enabled: boolean; row_estimate: number; columns: Column[] }

const RELATIONS = `
  select n.nspname as schema, c.relname as name, c.relkind::text as relkind, c.relrowsecurity as rls_enabled,
    greatest(c.reltuples, 0)::float8 as row_estimate,
    coalesce((select json_agg(json_build_object(
        'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'nullable', not a.attnotnull,
        'default', pg_get_expr(d.adbin, d.adrelid), 'is_pk', coalesce(a.attnum = any(i.indkey), false)) order by a.attnum)
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      left join pg_index i on i.indrelid = c.oid and i.indisprimary
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]') as columns
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f') and ($2::text is null or c.relname = $2)
  order by c.relname`

/** Tables, views and their columns in a schema, from the catalog. */
export async function listRelations(schema: string): Promise<Relation[]> {
  return (await pool.query(RELATIONS, [schema, null])).rows
}

/** The catalog entry for schema.table; 404 when it does not exist. */
export async function getRelation(schema: string, table: string): Promise<Relation> {
  const rel = (await pool.query(RELATIONS, [schema, table])).rows[0]
  if (!rel) throw adminError(404, 'relation not found')
  return rel
}

export async function assertRelation(schema: string, table: string): Promise<void> {
  await getRelation(schema, table)
}

/** The relation's column by name; 400 when the name is not one of its columns. */
export function column(rel: Relation, name: string): Column {
  const col = rel.columns.find((c) => c.name === name)
  if (!col) throw adminError(400, `unknown column: ${name}`)
  return col
}

/** Writes one selfbase.admin_audit row; pass the write's transaction client so both commit together. */
export const audit = (db: Pick<PoolClient, 'query'>, action: string, target: string | null, detail: object) =>
  db.query('insert into selfbase.admin_audit (action, target, detail) values ($1, $2, $3)', [action, target, detail])

/** Admin request body as an object ({} when missing or not JSON). */
export const readBody = async (c: Context): Promise<Record<string, any>> => {
  const b = await c.req.json().catch(() => null)
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {}
}

export const q = pg.escapeIdentifier
/** Quoted schema.table, for names already checked with getRelation/assertRelation. */
export const qrel = (rel: { schema: string; name: string }) => `${q(rel.schema)}.${q(rel.name)}`
