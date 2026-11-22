import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { asUser, pool } from '../db.ts'
import type { JwtClaims } from '../jwt.ts'
import { StorageError, resolveObjectPath } from './paths.ts'
import { logLine } from '../log.ts'

export type Bucket = { id: string; public: boolean; file_size_limit: number | null; allowed_mime_types: string[] | null }
type Meta = { mimetype?: string; cacheControl?: string; size?: number } | null

export const notFound = () => new StorageError(404, 'not_found', 'Object not found')

/** Bucket settings, read as core itself: limits and the public flag are not an RLS decision. */
export async function getBucket(id: string): Promise<Bucket> {
  const { rows } = await pool.query(
    'select id, public, file_size_limit::float8 as file_size_limit, allowed_mime_types from storage.buckets where id = $1',
    [id],
  )
  if (!rows[0]) throw new StorageError(404, 'not_found', 'Bucket not found')
  return rows[0]
}

const mimeAllowed = (allowed: string[], mime: string) => {
  const m = mime.split(';')[0].trim().toLowerCase()
  return allowed.some((a) => a === m || (a.endsWith('/*') && m.startsWith(a.slice(0, -1))))
}

/** Inserts the row as the caller (RLS decides), then writes the file; a failed write rolls the row back. */
export async function uploadObject(
  claims: JwtClaims | null,
  bucket: Bucket,
  name: string,
  data: Buffer,
  mimetype: string,
  cacheControl: string,
  upsert: boolean,
): Promise<{ Key: string; Id: string }> {
  const file = resolveObjectPath(bucket.id, name)
  if (bucket.file_size_limit != null && data.length > bucket.file_size_limit)
    throw new StorageError(413, 'Payload too large', 'The object exceeded the maximum allowed size')
  if (bucket.allowed_mime_types?.length && !mimeAllowed(bucket.allowed_mime_types, mimetype))
    throw new StorageError(415, 'invalid_mime_type', `mime type ${mimetype} is not supported`)

  const metadata = { size: data.length, mimetype, cacheControl }
  const params = [randomUUID(), bucket.id, name, claims?.sub ?? null, claims?.sub ?? null, metadata]
  return asUser(claims, async (c) => {
    // RETURNING needs a select policy, so only upsert (which needs one anyway) reads the id back
    const id = upsert
      ? (await c.query(
          `insert into storage.objects (id, bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5, $6)
           on conflict (bucket_id, name) do update
           set owner = excluded.owner, owner_id = excluded.owner_id, metadata = excluded.metadata, updated_at = now()
           returning id`,
          params,
        )).rows[0].id
      : (await c.query(
          'insert into storage.objects (id, bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5, $6)',
          params,
        ), params[0])
    await mkdir(dirname(file), { recursive: true })
    // write then rename so a failed upsert never leaves a half-written file in place.
    // shortcut: the rename happens after the row write but before commit, so a failed commit can leave
    // the new file without its row (or an upsert's old file replaced); add a reconciler if that shows up

    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, data)
      await rename(tmp, file)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
    return { Key: `${bucket.id}/${name}`, Id: id }
  })
}

/** Object metadata as the caller sees it through RLS; 404 when the row is not visible. */
export async function readMeta(claims: JwtClaims | null, bucket: string, name: string): Promise<Meta> {
  resolveObjectPath(bucket, name)
  const { rows } = await asUser(claims, (c) =>
    c.query('select metadata from storage.objects where bucket_id = $1 and name = $2', [bucket, name]))
  if (!rows[0]) throw notFound()
  return rows[0].metadata
}

/** Object metadata bypassing RLS: only for public buckets and verified signed URLs. */
// The bucket's public flag, or the RLS check done when the URL was signed, is the authorization (as in Supabase Storage).
export async function readMetaUnchecked(bucket: string, name: string): Promise<Meta> {
  resolveObjectPath(bucket, name)
  const { rows } = await pool.query('select metadata from storage.objects where bucket_id = $1 and name = $2', [bucket, name])
  if (!rows[0]) throw notFound()
  return rows[0].metadata
}

/** Single `bytes=a-b` / `bytes=a-` / `bytes=-n` range; null = whole file. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (!m[1] && !m[2])) return null
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  return start > end || start >= size ? 'invalid' : { start, end }
}

/** Streams the object file with Content-Type / Cache-Control from its metadata and Range support. */
export async function fileResponse(bucket: string, name: string, meta: Meta, range: string | undefined): Promise<Response> {
  const file = resolveObjectPath(bucket, name)
  const size = await stat(file).then((s) => s.size, () => { throw notFound() })
  // objects share the panel's origin: never let a stored text/html run or be sniffed into script
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  })
  // stored metadata is not trusted to be a valid header value; a bad one is skipped, not thrown
  const trySet = (k: string, v: unknown) => {
    try { if (typeof v === 'string' && v) headers.set(k, v) } catch { /* keep default */ }
  }
  trySet('content-type', meta?.mimetype)
  trySet('cache-control', meta?.cacheControl)
  // browser PDF viewers refuse sandboxed documents, and they run no document script in the page origin
  if (meta?.mimetype === 'application/pdf') {
    headers.delete('content-security-policy')
    headers.set('content-disposition', 'inline')
  }
  const r = parseRange(range, size)
  if (r === 'invalid') return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
  const { start, end } = r ?? { start: 0, end: size - 1 }
  headers.set('content-length', String(end - start + 1))
  if (r) headers.set('content-range', `bytes ${start}-${end}/${size}`)
  const body = size === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream)
  return new Response(body, { status: r ? 206 : 200, headers })
}

/** Deletes the rows the caller may delete, then (after commit) their files. */
export async function removeObjects(claims: JwtClaims | null, bucket: string, names: string[]) {
  for (const n of names) resolveObjectPath(bucket, n)
  const rows = await asUser(claims, async (c) =>
    (await c.query('delete from storage.objects where bucket_id = $1 and name = any($2) returning *', [bucket, names])).rows)
  // a failed unlink leaves an orphan file, never a row without its file
  for (const row of rows) {
    await rm(resolveObjectPath(bucket, row.name), { force: true })
      .catch((err: NodeJS.ErrnoException) => logLine('error', `storage: unlink failed for ${bucket}/${row.name}: ${err.code}`))
  }
  return rows
}

/** One folder level under prefix, like Supabase's list: files with their row, sub-folders with id null. */
export async function listObjects(claims: JwtClaims | null, bucket: string, prefix: string, limit: number, offset: number) {
  const dir = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix
  const like = dir.replace(/[\\%_]/g, '\\$&') + '%'
  // shortcut: always sorted by name and no `search` filter; add sortBy/search when a caller needs them
  const { rows } = await asUser(claims, (c) =>
    c.query(
      `select name, id, updated_at, created_at, last_accessed_at, metadata from (
         select distinct on (split_part(rest, '/', 1), strpos(rest, '/') > 0)
           split_part(rest, '/', 1) as name,
           case when strpos(rest, '/') = 0 then id end as id,
           case when strpos(rest, '/') = 0 then updated_at end as updated_at,
           case when strpos(rest, '/') = 0 then created_at end as created_at,
           case when strpos(rest, '/') = 0 then last_accessed_at end as last_accessed_at,
           case when strpos(rest, '/') = 0 then metadata end as metadata,
           strpos(rest, '/') > 0 as folder
         from (select substr(name, $3) as rest, id, updated_at, created_at, last_accessed_at, metadata
               from storage.objects where bucket_id = $1 and name like $2) o
         order by split_part(rest, '/', 1), strpos(rest, '/') > 0
       ) t order by name, folder limit $4 offset $5`,
      // Postgres substr counts code points, not UTF-16 units
      [bucket, like, [...dir].length + 1, limit, offset],
    ))
  return rows
}
