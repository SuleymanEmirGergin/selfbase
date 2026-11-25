import { Hono } from 'hono'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { asUser } from '../db.ts'
import { auth } from '../jwt.ts'
import type { AppEnv } from '../jwt.ts'
import { StorageError, resolveObjectPath } from './paths.ts'
import { signObjectUrl, verifyObjectUrl } from './sign.ts'
import {
  fileResponse, getBucket, listObjects, readMeta, readMetaUnchecked, removeObjects, uploadObject,
} from './objects.ts'
import type { Bucket } from './objects.ts'
import { logLine } from '../log.ts'

// Supabase Storage API paths, mounted at /storage/v1 in app.ts.
type Env = { Variables: AppEnv['Variables'] & { bucket: Bucket } }
const router = new Hono<Env>()

const fail = (status: number, error: string, message: string) =>
  Response.json({ statusCode: String(status), error, message }, { status })

router.onError((err) => {
  if (err instanceof StorageError) return fail(err.status, err.error, err.message)
  // auth() answers bad tokens GoTrue-style; storage clients expect the storage shape
  if (err instanceof HTTPException && err.status === 401) return fail(401, 'InvalidJWT', 'invalid JWT')
  const code = (err as { code?: string }).code
  if (code === '23505') return fail(409, 'Duplicate', 'The resource already exists')
  if (code === '42501') return fail(403, 'Unauthorized', 'new row violates row-level security policy')
  logLine('error', 'storage: unhandled error', { error: String((err as Error).stack ?? err) })
  return fail(500, 'internal', 'Internal server error')
})

router.use('*', auth())

const OBJ = '/:bucket/:name{.+}'
const params = (c: Context) => ({ bucket: c.req.param('bucket')!, name: c.req.param('name')! })
const body = (c: Context): Promise<Record<string, unknown>> => c.req.json().catch(() => ({}))
const tooLarge = () => new StorageError(413, 'Payload too large', 'The object exceeded the maximum allowed size')
// the JSON routes read whole bodies; uploads have their own STORAGE_MAX_UPLOAD_BYTES limit
const jsonLimit = bodyLimit({ maxSize: 1024 * 1024, onError: () => { throw tooLarge() } })
const BUCKET_COLS = 'id, name, owner, public, file_size_limit::float8 as file_size_limit, allowed_mime_types, created_at, updated_at'

router.get('/bucket', async (c) => {
  const { rows } = await asUser(c.get('claims'), (db) => db.query(`select ${BUCKET_COLS} from storage.buckets order by name`))
  return c.json(rows)
})

router.get('/bucket/:id', async (c) => {
  const { rows } = await asUser(c.get('claims'), (db) =>
    db.query(`select ${BUCKET_COLS} from storage.buckets where id = $1`, [c.req.param('id')]))
  if (!rows[0]) throw new StorageError(404, 'not_found', 'Bucket not found')
  return c.json(rows[0])
})

router.post('/object/sign' + OBJ, jsonLimit, async (c) => {
  const { bucket, name } = params(c)
  const { expiresIn } = await body(c)
  if (!Number.isInteger(expiresIn) || (expiresIn as number) <= 0)
    throw new StorageError(400, 'InvalidRequest', 'expiresIn must be a positive integer')
  await readMeta(c.get('claims'), bucket, name) // only objects the caller can read may be signed
  const token = await signObjectUrl(bucket, name, expiresIn as number)
  return c.json({ signedURL: `/object/sign/${[bucket, ...name.split('/')].map(encodeURIComponent).join('/')}?token=${token}` })
})

router.get('/object/sign' + OBJ, async (c) => {
  const { bucket, name } = params(c)
  await verifyObjectUrl(c.req.query('token') ?? '', bucket, name)
  return fileResponse(bucket, name, await readMetaUnchecked(bucket, name), c.req.header('range'))
})

router.post('/object/list/:bucket', jsonLimit, async (c) => {
  const { prefix, limit, offset } = await body(c)
  const int = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : d)
  return c.json(await listObjects(c.get('claims'), c.req.param('bucket'), typeof prefix === 'string' ? prefix : '', int(limit, 100), int(offset, 0)))
})

router.get('/object/public' + OBJ, async (c) => {
  const { bucket, name } = params(c)
  if (!(await getBucket(bucket)).public) throw new StorageError(400, 'InvalidRequest', 'Bucket is not public')
  return fileResponse(bucket, name, await readMetaUnchecked(bucket, name), c.req.header('range'))
})

const download = async (c: Context<Env>) => {
  const { bucket, name } = params(c)
  return fileResponse(bucket, name, await readMeta(c.get('claims'), bucket, name), c.req.header('range'))
}
router.get('/object/authenticated' + OBJ, download)
router.get('/object' + OBJ, download)

const MAX_UPLOAD = Number(process.env.STORAGE_MAX_UPLOAD_BYTES) || 50 * 1024 * 1024
// values that would make the Response headers throw on download
const badHeader = (v: string) => /[\0-\x1f\x7f]/.test(v)

// Cheap checks before any body byte is read: key, caller, bucket, declared size.
const uploadPrecheck = createMiddleware<Env>(async (c, next) => {
  const { bucket, name } = params(c)
  resolveObjectPath(bucket, name)
  if (!c.get('claims')) throw new StorageError(401, 'InvalidJWT', 'apikey or authorization header required')
  const b = await getBucket(bucket)
  // multipart framing adds bytes, so only a raw body's declared length is the object size
  const multipart = (c.req.header('content-type') ?? '').startsWith('multipart/form-data')
  if (!multipart && b.file_size_limit != null && Number(c.req.header('content-length')) > b.file_size_limit) throw tooLarge()
  c.set('bucket', b)
  return next()
})
const uploadLimit = bodyLimit({ maxSize: MAX_UPLOAD, onError: () => { throw tooLarge() } })

// PUT is supabase-js update(); treated as upsert
router.on(['POST', 'PUT'], '/object' + OBJ, uploadPrecheck, uploadLimit, async (c) => {
  const { name } = params(c)
  const type = c.req.header('content-type') ?? ''
  let data: Buffer, mimetype: string, cacheControl: string
  // shortcut: body (capped at STORAGE_MAX_UPLOAD_BYTES) buffered in memory; stream to disk if uploads get large
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.formData()
    const file = [...form.values()].find((v): v is File => v instanceof File)
    if (!file) throw new StorageError(400, 'InvalidRequest', 'No file in form data')
    data = Buffer.from(await file.arrayBuffer())
    mimetype = file.type || 'application/octet-stream'
    const cc = form.get('cacheControl')
    cacheControl = typeof cc === 'string' && cc ? `max-age=${cc}` : 'no-cache'
  } else {
    data = Buffer.from(await c.req.arrayBuffer())
    mimetype = type || 'application/octet-stream'
    cacheControl = c.req.header('cache-control') ?? 'no-cache'
  }
  if (badHeader(cacheControl) || badHeader(mimetype)) throw new StorageError(400, 'InvalidRequest', 'Invalid cacheControl or content type')
  const upsert = c.req.method === 'PUT' || c.req.header('x-upsert') === 'true'
  return c.json(await uploadObject(c.get('claims'), c.get('bucket'), name, data, mimetype, cacheControl, upsert))
})

router.delete('/object/:bucket', jsonLimit, async (c) => {
  const { prefixes } = await body(c)
  if (!Array.isArray(prefixes) || !prefixes.every((p) => typeof p === 'string'))
    throw new StorageError(400, 'InvalidRequest', 'prefixes must be an array of strings')
  return c.json(await removeObjects(c.get('claims'), c.req.param('bucket'), prefixes))
})

export default router
