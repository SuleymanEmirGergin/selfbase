import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// config and the storage module read env at import, so set it before loading app (dynamic imports below)
const base = mkdtempSync(join(tmpdir(), 'sb-storage-'))
const storageDir = join(base, 'storage')
process.env.STORAGE_DIR = storageDir
process.env.STORAGE_MAX_UPLOAD_BYTES = '4096'

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
const POLICY = `t4_${randomUUID().slice(0, 8)}`
const OPS = ['select', 'insert', 'update', 'delete']
let tokA: string, tokB: string, tokService: string

/** A fresh object name owned by user A, so no test depends on another. */
const fresh = (file: string) => `${A}/${randomUUID().slice(0, 8)}/${file}`
const enc = (name: string) => name.split('/').map(encodeURIComponent).join('/')
const req = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers)
  if (init.token) headers.set('authorization', `Bearer ${init.token}`)
  return app.request('/storage/v1' + path, { ...init, headers })
}
const upload = (bucket: string, name: string, body: BodyInit, token?: string, headers: Record<string, string> = {}) =>
  req(`/object/${bucket}/${enc(name)}`, { method: 'POST', body, token, headers: { 'content-type': 'text/plain', ...headers } })
const json = (method: string, path: string, token: string, payload: object) =>
  req(path, { method, token, body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } })
const onDisk = (bucket: string, name: string) => join(storageDir, bucket, name)

beforeAll(async () => {
  await pool.query(`delete from storage.objects where bucket_id like 't4-%'`)
  await pool.query(`delete from storage.buckets where id like 't4-%'`)
  await pool.query(
    `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
     ($1, $1, false, 1024, '{text/plain,text/html,image/*}'), ($2, $2, true, null, null), ($3, $3, false, null, null)`,
    [PRIV, PUB, NOPOL],
  )
  for (const op of OPS) {
    const clause = op === 'insert' ? 'with check' : 'using'
    await pool.query(
      `create policy ${POLICY}_${op} on storage.objects for ${op} to authenticated
       ${clause} (bucket_id = '${PRIV}' and owner = auth.uid())`,
    )
  }
  await pool.query(
    `insert into auth.users (id, email, role, aud) values ($1, $2, 'authenticated', 'authenticated'), ($3, $4, 'authenticated', 'authenticated')`,
    [A, `${A}@example.test`, B, `${B}@example.test`],
  )
  tokA = await sign({ sub: A, role: 'authenticated' }, 3600)
  tokB = await sign({ sub: B, role: 'authenticated' }, 3600)
  tokService = await sign({ role: 'service_role' }, 3600)
})

afterAll(async () => {
  await pool.query(`delete from storage.objects where bucket_id like 't4-%'`)
  await pool.query(`delete from storage.buckets where id like 't4-%'`)
  for (const op of OPS) await pool.query(`drop policy if exists ${POLICY}_${op} on storage.objects`)
  await pool.query('delete from auth.users where id = any($1)', [[A, B]])
  rmSync(base, { recursive: true, force: true })
})

describe('storage', () => {
  it('owner uploads and reads back; other user gets 404 with no content', async () => {
    const name = fresh('hello.txt')
    const res = await upload(PRIV, name, 'hello', tokA, { 'cache-control': 'max-age=60' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ Key: `${PRIV}/${name}`, Id: expect.any(String) })
    expect(readFileSync(onDisk(PRIV, name), 'utf8')).toBe('hello')

    for (const path of [`/object/authenticated/${PRIV}/${name}`, `/object/${PRIV}/${name}`]) {
      const got = await req(path, { token: tokA })
      expect(got.status).toBe(200)
      expect(got.headers.get('content-type')).toBe('text/plain')
      expect(got.headers.get('cache-control')).toBe('max-age=60')
      expect(await got.text()).toBe('hello')
    }

    const other = await req(`/object/authenticated/${PRIV}/${name}`, { token: tokB })
    expect([400, 404]).toContain(other.status)
    const text = await other.text()
    expect(text).not.toContain('hello')
    expect(JSON.parse(text)).toMatchObject({ statusCode: '404', error: 'not_found' })
  })

  it('serves stored html as inert: nosniff and a sandboxing CSP', async () => {
    const name = fresh('x.html')
    expect((await upload(PRIV, name, '<script>alert(1)</script>', tokA, { 'content-type': 'text/html' })).status).toBe(200)
    const got = await req(`/object/${PRIV}/${name}`, { token: tokA })
    expect(got.headers.get('content-type')).toBe('text/html')
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')
    expect(got.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(got.headers.get('content-disposition')).toBeNull()
  })

  it('serves application/pdf inline and nosniff but without the sandbox (PDF viewers refuse it)', async () => {
    const name = fresh('cv.pdf')
    expect((await upload(PUB, name, '%PDF-1.4', tokService, { 'content-type': 'application/pdf' })).status).toBe(200)
    const got = await req(`/object/public/${PUB}/${name}`)
    expect(got.headers.get('content-type')).toBe('application/pdf')
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')
    expect(got.headers.get('content-disposition')).toBe('inline')
    expect(got.headers.get('content-security-policy')).toBeNull()
  })

  it('serves byte ranges', async () => {
    const name = fresh('r.txt')
    await upload(PRIV, name, 'hello', tokA)
    const res = await req(`/object/${PRIV}/${name}`, { token: tokA, headers: { range: 'bytes=1-3' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 1-3/5')
    expect(await res.text()).toBe('ell')
    const bad = await req(`/object/${PRIV}/${name}`, { token: tokA, headers: { range: 'bytes=9-' } })
    expect(bad.status).toBe(416)
  })

  it('second upload without upsert is 409, x-upsert overwrites', async () => {
    const name = fresh('u.txt')
    await upload(PRIV, name, 'hello', tokA)
    const dup = await upload(PRIV, name, 'again', tokA)
    expect(dup.status).toBe(409)
    expect(await dup.json()).toMatchObject({ statusCode: '409', error: 'Duplicate' })
    expect(readFileSync(onDisk(PRIV, name), 'utf8')).toBe('hello')

    const up = await upload(PRIV, name, 'again', tokA, { 'x-upsert': 'true' })
    expect(up.status).toBe(200)
    expect(readFileSync(onDisk(PRIV, name), 'utf8')).toBe('again')
  })

  it('enforces bucket file_size_limit (413) and allowed_mime_types (415)', async () => {
    const big = fresh('big.txt')
    const res = await upload(PRIV, big, 'x'.repeat(2000), tokA)
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ statusCode: '413' })
    expect(existsSync(onDisk(PRIV, big))).toBe(false)

    expect((await upload(PRIV, fresh('doc.pdf'), 'x', tokA, { 'content-type': 'application/pdf' })).status).toBe(415)
    expect((await upload(PRIV, fresh('pic.png'), 'x', tokA, { 'content-type': 'image/png' })).status).toBe(200)
  })

  it('rejects an over-limit Content-Length before reading the body', async () => {
    const body = new ReadableStream({ pull() { throw new Error('body was read') } })
    const res = await req(`/object/${PRIV}/${enc(fresh('cl.txt'))}`, {
      method: 'POST', token: tokA, body, duplex: 'half', headers: { 'content-type': 'text/plain', 'content-length': '2000' },
    } as RequestInit)
    expect(res.status).toBe(413)
  })

  it('caps every upload body at STORAGE_MAX_UPLOAD_BYTES (413, nothing on disk)', async () => {
    const name = `cap-${randomUUID()}.bin`
    const res = await upload(PUB, name, 'x'.repeat(5000), tokService)
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ statusCode: '413' })
    expect(existsSync(onDisk(PUB, name))).toBe(false)
  })

  it('upload without any token is 401 and writes nothing', async () => {
    const name = `anon-${randomUUID()}.txt`
    const res = await upload(PUB, name, 'x')
    expect(res.status).toBe(401)
    expect(existsSync(onDisk(PUB, name))).toBe(false)
  })

  it('rejects a cacheControl with control characters; bad stored metadata never breaks a download', async () => {
    const form = new FormData()
    form.append('cacheControl', '60\r\nx-evil: 1')
    form.append('', new Blob(['x'], { type: 'text/plain' }), 'f.txt')
    const res = await req(`/object/${PRIV}/${enc(fresh('cc.txt'))}`, { method: 'POST', body: form, token: tokA })
    expect(res.status).toBe(400)

    const name = fresh('meta.txt')
    await upload(PRIV, name, 'ok', tokA)
    await pool.query(`update storage.objects set metadata = '{"mimetype":"text/plain\\r\\nx","cacheControl":"a\\nb"}' where bucket_id = $1 and name = $2`, [PRIV, name])
    const got = await req(`/object/${PRIV}/${name}`, { token: tokA })
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('application/octet-stream')
    expect(got.headers.get('cache-control')).toBeNull()
    expect(await got.text()).toBe('ok')
  })

  it('authenticated upload to a bucket without policies is 403 and writes nothing', async () => {
    const res = await upload(NOPOL, fresh('x.txt'), 'nope', tokA)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ statusCode: '403', error: 'Unauthorized' })
    expect(existsSync(join(storageDir, NOPOL))).toBe(false)
  })

  it('anon reads a public bucket but not a private one; multipart upload keeps mimetype and cacheControl', async () => {
    const logo = `logo-${randomUUID()}.png`
    const form = new FormData()
    form.append('cacheControl', '120')
    form.append('', new Blob(['PNGDATA'], { type: 'image/png' }), 'logo.png')
    expect((await req(`/object/${PUB}/${logo}`, { method: 'POST', body: form, token: tokService })).status).toBe(200)

    const pub = await req(`/object/public/${PUB}/${logo}`)
    expect(pub.status).toBe(200)
    expect(pub.headers.get('content-type')).toBe('image/png')
    expect(pub.headers.get('cache-control')).toBe('max-age=120')
    expect(pub.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await pub.text()).toBe('PNGDATA')

    const secret = fresh('secret.txt')
    await upload(PRIV, secret, 'secret', tokA)
    const notPublic = await req(`/object/public/${PRIV}/${secret}`)
    expect(notPublic.status).toBe(400)
    expect(await notPublic.text()).not.toContain('secret"')
    const anonPriv = await req(`/object/authenticated/${PRIV}/${secret}`)
    expect([400, 404]).toContain(anonPriv.status)
    expect(await anonPriv.text()).not.toContain('secret"')
  })

  it('R4: a symlink placed in storage is not served, and an upload never writes through one', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'sb-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'outside-secret')
    const dir = `link-${randomUUID().slice(0, 8)}`
    const links = [join(storageDir, PUB, dir)]
    mkdirSync(join(storageDir, PUB), { recursive: true })
    // a directory link (a junction on Windows, which needs no privilege), as a restored archive could leave it
    symlinkSync(outside, links[0], 'junction')
    const names = [`${dir}/secret.txt`]
    try {
      symlinkSync(join(outside, 'secret.txt'), join(storageDir, PUB, `${dir}-file`))
      links.push(join(storageDir, PUB, `${dir}-file`))
      names.push(`${dir}-file`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e // a file symlink needs a privilege on Windows
    }
    try {
      // the rows a restored dump would carry, in a public bucket: anyone may read them
      for (const n of names) await pool.query(`insert into storage.objects (bucket_id, name, metadata) values ($1, $2, '{"mimetype":"text/plain"}')`, [PUB, n])
      for (const n of names) {
        const res = await req(`/object/public/${PUB}/${enc(n)}`)
        expect(res.status, n).toBe(404)
        expect(await res.text(), n).not.toContain('outside-secret')
      }
      const up = await upload(PUB, `${dir}/new.txt`, 'evil', tokService)
      expect(up.status).toBe(400)
      expect(readdirSync(outside)).toEqual(['secret.txt'])
    } finally {
      await pool.query('delete from storage.objects where bucket_id = $1 and name like $2', [PUB, `${dir}%`])
      for (const l of links) rmSync(l, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects path traversal names with 400 and writes nothing outside STORAGE_DIR', async () => {
    const before = existsSync(join(storageDir, PUB)) ? readdirSync(join(storageDir, PUB)) : []
    for (const name of ['../../etc/x', 'a/../../b', '/abs', 'a\\b', 'a//b', 'a/./b']) {
      const res = await req(`/object/${PUB}/${encodeURIComponent(name)}`, {
        method: 'POST', body: 'evil', token: tokService, headers: { 'content-type': 'text/plain' },
      })
      expect(res.status, name).toBe(400)
      expect(await res.json()).toMatchObject({ statusCode: '400', error: 'InvalidKey' })
    }
    expect(readdirSync(base).filter((f) => f !== 'storage')).toEqual([])
    expect(existsSync(join(storageDir, PUB)) ? readdirSync(join(storageDir, PUB)) : []).toEqual(before)
  })

  it('resolveObjectPath rejects bad keys and stays under STORAGE_DIR', () => {
    for (const [bucket, name] of [[PUB, '../x'], [PUB, 'a/../../b'], [PUB, '/abs'], [PUB, 'a\\b'], [PUB, 'a//b'], [PUB, 'a\0b'], [PUB, ''], ['..', 'x'], ['', 'x']]) {
      expect(() => resolveObjectPath(bucket, name), `${bucket}/${name}`).toThrow(StorageError)
    }
    expect(resolveObjectPath(PUB, 'a/b.txt')).toBe(join(storageDir, PUB, 'a', 'b.txt'))
  })

  it('signed URLs serve the object until they expire and are not API tokens', async () => {
    const name = fresh('s.txt')
    const otherName = fresh('o.txt')
    await upload(PRIV, name, 'signed', tokA)
    await upload(PRIV, otherName, 'other', tokA)
    const res = await json('POST', `/object/sign/${PRIV}/${enc(name)}`, tokA, { expiresIn: 60 })
    expect(res.status).toBe(200)
    const { signedURL } = await res.json()
    expect(signedURL).toMatch(new RegExp(`^/object/sign/${PRIV}/${name}\\?token=`))
    const got = await req(signedURL)
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('signed')

    // B cannot read the object, so cannot sign it either
    expect((await json('POST', `/object/sign/${PRIV}/${enc(name)}`, tokB, { expiresIn: 60 })).status).toBe(404)

    const token = new URL(signedURL, 'http://x').searchParams.get('token')!
    await expect(verify(token)).rejects.toThrow()
    const asApi = await req(`/object/${PRIV}/${name}`, { token })
    expect(asApi.status).toBe(401)
    expect(await asApi.json()).toMatchObject({ statusCode: '401', error: 'InvalidJWT' })

    expect((await req(`/object/sign/${PRIV}/${otherName}?token=${token}`)).status).toBe(400)

    const expired = await signObjectUrl(PRIV, name, -10)
    const late = await req(`/object/sign/${PRIV}/${name}?token=${expired}`)
    expect(late.status).toBe(400)
    expect(await late.text()).not.toContain('signed"')
  })

  it('signed URLs work for names with ?, # and spaces', async () => {
    // the row alone is enough to sign; '?' cannot be a file name on Windows dev hosts
    const q = fresh('a?b#c d.txt')
    await pool.query('insert into storage.objects (bucket_id, name, owner, owner_id) values ($1, $2, $3, $4)', [PRIV, q, A, A])
    const signed = (await (await json('POST', `/object/sign/${PRIV}/${enc(q)}`, tokA, { expiresIn: 60 })).json()).signedURL as string
    const url = new URL(signed, 'http://x')
    expect([...url.searchParams.keys()]).toEqual(['token'])
    expect(url.pathname.split('/').slice(4).map(decodeURIComponent).join('/')).toBe(q)

    const name = fresh(process.platform === 'win32' ? 'a#b c%.txt' : 'a?b#c d%.txt')
    expect((await upload(PRIV, name, 'odd', tokA)).status).toBe(200)
    const { signedURL } = await (await json('POST', `/object/sign/${PRIV}/${enc(name)}`, tokA, { expiresIn: 60 })).json()
    const got = await req(signedURL)
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('odd')
  })

  it('lists one folder level, including non-BMP prefixes', async () => {
    const dir = `${A}/list-${randomUUID().slice(0, 8)}`
    for (const n of ['b.txt', 'a.txt', 'sub/deep.txt']) await upload(PRIV, `${dir}/${n}`, 'd', tokA)
    const res = await json('POST', `/object/list/${PRIV}`, tokA, { prefix: dir, limit: 100, offset: 0 })
    expect(res.status).toBe(200)
    expect((await res.json()).map((i: { name: string; id: string | null }) => [i.name, i.id === null])).toEqual([
      ['a.txt', false], ['b.txt', false], ['sub', true],
    ])
    expect(await (await json('POST', `/object/list/${PRIV}`, tokB, { prefix: dir })).json()).toEqual([])

    const emoji = `${A}/😀-${randomUUID().slice(0, 8)}`
    await upload(PRIV, `${emoji}/f.txt`, 'e', tokA)
    const items = await (await json('POST', `/object/list/${PRIV}`, tokA, { prefix: emoji })).json()
    expect(items.map((i: { name: string }) => i.name)).toEqual(['f.txt'])
  })

  it('lists buckets visible to the caller', async () => {
    const all = await req('/bucket', { token: tokService })
    expect(all.status).toBe(200)
    expect((await all.json()).map((b: { id: string }) => b.id)).toEqual(expect.arrayContaining([PRIV, PUB, NOPOL]))
    const one = await req(`/bucket/${PRIV}`, { token: tokService })
    expect(await one.json()).toMatchObject({ id: PRIV, public: false, file_size_limit: 1024, allowed_mime_types: ['text/plain', 'text/html', 'image/*'] })
    // no bucket policies: authenticated users see none
    expect((await req(`/bucket/${PRIV}`, { token: tokA })).status).toBe(404)
  })

  it('delete removes both the row and the file; another user cannot delete', async () => {
    const name = fresh('d.txt')
    const keep = fresh('keep.txt')
    await upload(PRIV, name, 'bye', tokA)
    await upload(PRIV, keep, 'stay', tokA)

    const res = await json('DELETE', `/object/${PRIV}`, tokA, { prefixes: [name] })
    expect(res.status).toBe(200)
    expect((await res.json()).map((o: { name: string }) => o.name)).toEqual([name])
    expect(existsSync(onDisk(PRIV, name))).toBe(false)
    const { rowCount } = await pool.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [PRIV, name])
    expect(rowCount).toBe(0)

    expect(await (await json('DELETE', `/object/${PRIV}`, tokB, { prefixes: [keep] })).json()).toEqual([])
    expect(existsSync(onDisk(PRIV, keep))).toBe(true)
  })

  it('a delete removes the folders it leaves empty, up to the first that still holds something', async () => {
    const dir = dirname(fresh('x'))
    await upload(PRIV, `${dir}/sub/x.txt`, 'x', tokA)
    await upload(PRIV, `${dir}/y.txt`, 'y', tokA)
    await json('DELETE', `/object/${PRIV}`, tokA, { prefixes: [`${dir}/sub/x.txt`] })
    expect(existsSync(onDisk(PRIV, `${dir}/sub`))).toBe(false)
    expect(existsSync(onDisk(PRIV, dir))).toBe(true)
    await json('DELETE', `/object/${PRIV}`, tokA, { prefixes: [`${dir}/y.txt`] })
    expect(existsSync(onDisk(PRIV, dir))).toBe(false)
    // a later upload into the same folders recreates them
    expect((await upload(PRIV, `${dir}/sub/x.txt`, 'again', tokA)).status).toBe(200)
  })
})
