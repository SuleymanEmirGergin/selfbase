import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// config reads STORAGE_DIR at import, so set it before loading app (dynamic imports below)
const base = mkdtempSync(join(tmpdir(), 'sb-storage-'))
const storageDir = join(base, 'storage')
process.env.STORAGE_DIR = storageDir

const { app } = await import('../src/app.ts')
const { pool } = await import('../src/db.ts')
const { sign, verify } = await import('../src/jwt.ts')
const { resolveObjectPath, StorageError } = await import('../src/storage/paths.ts')
const { signObjectUrl } = await import('../src/storage/sign.ts')

const PRIV = 't4-priv'
const PUB = 't4-pub'
const NOPOL = 't4-nopol'
const A = randomUUID()
const B = randomUUID()
let tokA: string, tokB: string, tokService: string

const req = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers)
  if (init.token) headers.set('authorization', `Bearer ${init.token}`)
  return app.request('/storage/v1' + path, { ...init, headers })
}
const upload = (bucket: string, name: string, body: BodyInit, token?: string, headers: Record<string, string> = {}) =>
  req(`/object/${bucket}/${name}`, { method: 'POST', body, token, headers: { 'content-type': 'text/plain', ...headers } })
const onDisk = (bucket: string, name: string) => join(storageDir, bucket, name)

beforeAll(async () => {
  await pool.query(`delete from storage.objects where bucket_id like 't4-%'`)
  await pool.query(`delete from storage.buckets where id like 't4-%'`)
  await pool.query(
    `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
     ($1, $1, false, 1024, '{text/plain,image/*}'), ($2, $2, true, null, null), ($3, $3, false, null, null)`,
    [PRIV, PUB, NOPOL],
  )
  for (const op of ['select', 'insert', 'update', 'delete']) {
    await pool.query(`drop policy if exists t4_owner_${op} on storage.objects`)
    const clause = op === 'insert' ? 'with check' : 'using'
    await pool.query(
      `create policy t4_owner_${op} on storage.objects for ${op} to authenticated
       ${clause} (bucket_id = '${PRIV}' and owner = auth.uid())`,
    )
  }
  await pool.query(`insert into auth.users (id, email, role, aud) values ($1, $2, 'authenticated', 'authenticated'), ($3, $4, 'authenticated', 'authenticated')`, [
    A, `${A}@example.test`, B, `${B}@example.test`,
  ])
  tokA = await sign({ sub: A, role: 'authenticated' }, 3600)
  tokB = await sign({ sub: B, role: 'authenticated' }, 3600)
  tokService = await sign({ role: 'service_role' }, 3600)
})

afterAll(async () => {
  await pool.query(`delete from storage.objects where bucket_id like 't4-%'`)
  await pool.query(`delete from storage.buckets where id like 't4-%'`)
  for (const op of ['select', 'insert', 'update', 'delete']) await pool.query(`drop policy if exists t4_owner_${op} on storage.objects`)
  await pool.query('delete from auth.users where id = any($1)', [[A, B]])
  rmSync(base, { recursive: true, force: true })
})

describe('storage', () => {
  it('owner uploads and reads back; other user gets 404 with no content', async () => {
    const res = await upload(PRIV, `${A}/hello.txt`, 'hello', tokA, { 'cache-control': 'max-age=60' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ Key: `${PRIV}/${A}/hello.txt`, Id: expect.any(String) })
    expect(readFileSync(onDisk(PRIV, `${A}/hello.txt`), 'utf8')).toBe('hello')

    for (const path of [`/object/authenticated/${PRIV}/${A}/hello.txt`, `/object/${PRIV}/${A}/hello.txt`]) {
      const got = await req(path, { token: tokA })
      expect(got.status).toBe(200)
      expect(got.headers.get('content-type')).toBe('text/plain')
      expect(got.headers.get('cache-control')).toBe('max-age=60')
      expect(await got.text()).toBe('hello')
    }

    const other = await req(`/object/authenticated/${PRIV}/${A}/hello.txt`, { token: tokB })
    expect([400, 404]).toContain(other.status)
    const text = await other.text()
    expect(text).not.toContain('hello')
    expect(JSON.parse(text)).toMatchObject({ statusCode: '404', error: 'not_found' })
  })

  it('serves byte ranges', async () => {
    const res = await req(`/object/${PRIV}/${A}/hello.txt`, { token: tokA, headers: { range: 'bytes=1-3' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 1-3/5')
    expect(await res.text()).toBe('ell')
    const bad = await req(`/object/${PRIV}/${A}/hello.txt`, { token: tokA, headers: { range: 'bytes=9-' } })
    expect(bad.status).toBe(416)
  })

  it('second upload without upsert is 409, x-upsert overwrites', async () => {
    const dup = await upload(PRIV, `${A}/hello.txt`, 'again', tokA)
    expect(dup.status).toBe(409)
    expect(await dup.json()).toMatchObject({ statusCode: '409', error: 'Duplicate' })
    expect(readFileSync(onDisk(PRIV, `${A}/hello.txt`), 'utf8')).toBe('hello')

    const up = await upload(PRIV, `${A}/hello.txt`, 'again', tokA, { 'x-upsert': 'true' })
    expect(up.status).toBe(200)
    expect(readFileSync(onDisk(PRIV, `${A}/hello.txt`), 'utf8')).toBe('again')
  })

  it('enforces bucket file_size_limit (413) and allowed_mime_types (415)', async () => {
    const big = await upload(PRIV, `${A}/big.txt`, 'x'.repeat(2000), tokA)
    expect(big.status).toBe(413)
    expect(await big.json()).toMatchObject({ statusCode: '413' })
    expect(existsSync(onDisk(PRIV, `${A}/big.txt`))).toBe(false)

    const pdf = await upload(PRIV, `${A}/doc.pdf`, 'x', tokA, { 'content-type': 'application/pdf' })
    expect(pdf.status).toBe(415)
    const png = await upload(PRIV, `${A}/pic.png`, 'x', tokA, { 'content-type': 'image/png' })
    expect(png.status).toBe(200)
  })

  it('authenticated upload to a bucket without policies is 403 and writes nothing', async () => {
    const res = await upload(NOPOL, `${A}/x.txt`, 'nope', tokA)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ statusCode: '403', error: 'Unauthorized' })
    expect(existsSync(join(storageDir, NOPOL))).toBe(false)
  })

  it('anon reads a public bucket but not a private one; multipart upload keeps mimetype and cacheControl', async () => {
    const form = new FormData()
    form.append('cacheControl', '120')
    form.append('', new Blob(['PNGDATA'], { type: 'image/png' }), 'logo.png')
    const res = await req(`/object/${PUB}/logo.png`, { method: 'POST', body: form, token: tokService })
    expect(res.status).toBe(200)

    const pub = await req(`/object/public/${PUB}/logo.png`)
    expect(pub.status).toBe(200)
    expect(pub.headers.get('content-type')).toBe('image/png')
    expect(pub.headers.get('cache-control')).toBe('max-age=120')
    expect(await pub.text()).toBe('PNGDATA')

    const notPublic = await req(`/object/public/${PRIV}/${A}/hello.txt`)
    expect(notPublic.status).toBe(400)
    expect(await notPublic.text()).not.toContain('again')
    const anonPriv = await req(`/object/authenticated/${PRIV}/${A}/hello.txt`)
    expect([400, 404]).toContain(anonPriv.status)
    expect(await anonPriv.text()).not.toContain('again')
  })

  it('rejects path traversal names with 400 and writes nothing outside STORAGE_DIR', async () => {
    for (const name of ['../../etc/x', 'a/../../b', '/abs', 'a\\b', 'a//b', 'a/./b']) {
      const res = await upload(PUB, encodeURIComponent(name), 'evil', tokService)
      expect(res.status, name).toBe(400)
      expect(await res.json()).toMatchObject({ statusCode: '400', error: 'InvalidKey' })
    }
    expect(readdirSync(base)).toEqual(['storage'])
    expect(readdirSync(join(storageDir, PUB))).toEqual(['logo.png'])
  })

  it('resolveObjectPath rejects bad keys and stays under STORAGE_DIR', () => {
    for (const [bucket, name] of [[PUB, '../x'], [PUB, 'a/../../b'], [PUB, '/abs'], [PUB, 'a\\b'], [PUB, 'a//b'], [PUB, 'a\0b'], [PUB, ''], ['..', 'x'], ['', 'x']]) {
      expect(() => resolveObjectPath(bucket, name), `${bucket}/${name}`).toThrow(StorageError)
    }
    expect(resolveObjectPath(PUB, 'a/b.txt')).toBe(join(storageDir, PUB, 'a', 'b.txt'))
  })

  it('signed URLs serve the object until they expire and are not API tokens', async () => {
    const res = await req(`/object/sign/${PRIV}/${A}/hello.txt`, {
      method: 'POST', token: tokA, body: JSON.stringify({ expiresIn: 60 }), headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const { signedURL } = await res.json()
    expect(signedURL).toMatch(new RegExp(`^/object/sign/${PRIV}/${A}/hello.txt\\?token=`))
    const got = await req(signedURL)
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('again')

    // B cannot read the object, so cannot sign it either
    const denied = await req(`/object/sign/${PRIV}/${A}/hello.txt`, {
      method: 'POST', token: tokB, body: JSON.stringify({ expiresIn: 60 }), headers: { 'content-type': 'application/json' },
    })
    expect(denied.status).toBe(404)

    const token = new URL(signedURL, 'http://x').searchParams.get('token')!
    await expect(verify(token)).rejects.toThrow()
    const asApi = await req(`/object/${PRIV}/${A}/hello.txt`, { token })
    expect(asApi.status).toBe(401)
    expect(await asApi.json()).toMatchObject({ statusCode: '401', error: 'InvalidJWT' })

    const wrongObject = await req(`/object/sign/${PRIV}/${A}/pic.png?token=${token}`)
    expect(wrongObject.status).toBe(400)

    const expired = await signObjectUrl(PRIV, `${A}/hello.txt`, -10)
    const late = await req(`/object/sign/${PRIV}/${A}/hello.txt?token=${expired}`)
    expect(late.status).toBe(400)
    expect(await late.text()).not.toContain('again')
  })

  it('lists one folder level', async () => {
    await upload(PRIV, `${A}/sub/deep.txt`, 'd', tokA)
    const res = await req(`/object/list/${PRIV}`, {
      method: 'POST', token: tokA, body: JSON.stringify({ prefix: A, limit: 100, offset: 0 }), headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const items = await res.json()
    expect(items.map((i: { name: string; id: string | null }) => [i.name, i.id === null])).toEqual([
      ['hello.txt', false], ['pic.png', false], ['sub', true],
    ])
    const other = await req(`/object/list/${PRIV}`, {
      method: 'POST', token: tokB, body: JSON.stringify({ prefix: A }), headers: { 'content-type': 'application/json' },
    })
    expect(await other.json()).toEqual([])
  })

  it('lists buckets visible to the caller', async () => {
    const all = await req('/bucket', { token: tokService })
    expect(all.status).toBe(200)
    expect((await all.json()).map((b: { id: string }) => b.id)).toEqual(expect.arrayContaining([PRIV, PUB, NOPOL]))
    const one = await req(`/bucket/${PRIV}`, { token: tokService })
    expect(await one.json()).toMatchObject({ id: PRIV, public: false, file_size_limit: 1024, allowed_mime_types: ['text/plain', 'image/*'] })
    // no bucket policies: authenticated users see none
    expect((await req(`/bucket/${PRIV}`, { token: tokA })).status).toBe(404)
  })

  it('delete removes both the row and the file', async () => {
    const res = await req(`/object/${PRIV}`, {
      method: 'DELETE', token: tokA, body: JSON.stringify({ prefixes: [`${A}/hello.txt`] }), headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).map((o: { name: string }) => o.name)).toEqual([`${A}/hello.txt`])
    expect(existsSync(onDisk(PRIV, `${A}/hello.txt`))).toBe(false)
    const { rowCount } = await pool.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [PRIV, `${A}/hello.txt`])
    expect(rowCount).toBe(0)

    // B cannot delete A's file
    const denied = await req(`/object/${PRIV}`, {
      method: 'DELETE', token: tokB, body: JSON.stringify({ prefixes: [`${A}/pic.png`] }), headers: { 'content-type': 'application/json' },
    })
    expect(await denied.json()).toEqual([])
    expect(existsSync(onDisk(PRIV, `${A}/pic.png`))).toBe(true)
  })
})
