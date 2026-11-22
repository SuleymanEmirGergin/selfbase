import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { pool } from '../db.ts'
import type { JwtClaims } from '../jwt.ts'
import { withTx } from '../auth/users.ts'
import { StorageError, resolveObjectPath } from '../storage/paths.ts'
import { fileResponse, getBucket, listObjects, notFound, readMetaUnchecked, removeObjects, uploadObject } from '../storage/objects.ts'
import { adminError, audit, readBody } from './ident.ts'

// Storage helpers run their row work through asUser(); service_role bypasses RLS, which is what the operator needs.
const SERVICE = { role: 'service_role', exp: 0 } as JwtClaims
const MAX_UPLOAD = Number(process.env.STORAGE_MAX_UPLOAD_BYTES) || 50 * 1024 * 1024
const OBJ = '/files/:bucket/:name{.+}'

const router = new Hono()

router.get('/buckets', async (c) =>
  c.json((await pool.query(
    'select id, name, public, file_size_limit::float8 as file_size_limit, allowed_mime_types, created_at, updated_at from storage.buckets order by id',
  )).rows))

router.post('/buckets', async (c) => {
  const { id, public: isPublic } = await readBody(c)
  if (typeof id !== 'string') throw adminError(400, 'id is required')
  resolveObjectPath(id, 'x') // same key rules as storage: no slashes, dots-only or control characters
  if (isPublic !== undefined && typeof isPublic !== 'boolean') throw adminError(400, 'public must be a boolean')
  await withTx(async (db) => {
    await db.query('insert into storage.buckets (id, name, public) values ($1, $1, $2)', [id, isPublic ?? false])
    await audit(db, 'buckets.create', id, { public: isPublic ?? false })
  })
  return c.json({ id, name: id, public: isPublic ?? false })
})

router.get('/files/:bucket', async (c) => {
  const bucket = (await getBucket(c.req.param('bucket'))).id
  return c.json(await listObjects(SERVICE, bucket, c.req.query('prefix') ?? '', 1000, 0))
})

router.get(OBJ, async (c) => {
  const { bucket, name } = c.req.param()
  return fileResponse(bucket, name, await readMetaUnchecked(bucket, name), c.req.header('range'))
})

/** Audit after a file write; a failed insert is logged and answered 500 instead of vanishing. */
const auditFile = (action: string, target: string, detail: object) =>
  audit(pool, action, target, detail).catch((err) => {
    console.error(`admin: audit failed after ${action} ${target}: ${err.message}`)
    throw adminError(500, 'the change was applied but its audit row could not be written')
  })

const tooLarge = () => new StorageError(413, 'Payload too large', 'The object exceeded the maximum allowed size')

// raw body with the file's content type; always an upsert (the operator overwrites on purpose)
router.post(OBJ, bodyLimit({ maxSize: MAX_UPLOAD, onError: () => { throw tooLarge() } }), async (c) => {
  const { bucket, name } = c.req.param()
  resolveObjectPath(bucket, name)
  const mimetype = c.req.header('content-type') || 'application/octet-stream'
  if (/[\0-\x1f\x7f]/.test(mimetype)) throw adminError(400, 'invalid content type')
  // shortcut: body (capped at STORAGE_MAX_UPLOAD_BYTES) buffered in memory, as in the storage API
  const data = Buffer.from(await c.req.arrayBuffer())
  const res = await uploadObject(SERVICE, await getBucket(bucket), name, data, mimetype, 'no-cache', true)
  await auditFile('files.upload', `${bucket}/${name}`, { size: data.length, mimetype })
  return c.json(res)
})

router.delete(OBJ, async (c) => {
  const { bucket, name } = c.req.param()
  if (!(await removeObjects(SERVICE, bucket, [name])).length) throw notFound()
  await auditFile('files.delete', `${bucket}/${name}`, {})
  return c.json({})
})

export default router
