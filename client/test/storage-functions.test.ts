import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FunctionsFetchError, FunctionsHttpError, StorageApiError, createClient } from '../src/index.ts'
import { startFakeServer, type FakeServer } from './fake-server.ts'
import { ANON_KEY } from './helpers.ts'

let fake: FakeServer
const opts = { auth: { persistSession: false, autoRefreshToken: false } }

beforeAll(async () => {
  fake = await startFakeServer()
})
afterAll(() => fake.close())

async function signedIn() {
  const sb = createClient(fake.url, ANON_KEY, opts)
  const { data } = await sb.auth.signUp({ email: `s-${Math.random()}@example.test`, password: 'secret123' })
  return { sb, token: data.session!.access_token }
}

describe('storage', () => {
  it('upload → getPublicUrl serves the file (200) with its content type', async () => {
    const { sb, token } = await signedIn()
    const file = new Blob(['png-bytes'], { type: 'image/png' })
    const { data, error } = await sb.storage.from('public-bucket').upload('u1/avatar.png', file, { upsert: false })
    expect(error).toBeNull()
    expect(data).toMatchObject({ path: 'u1/avatar.png', fullPath: 'public-bucket/u1/avatar.png' })
    const req = fake.requests.at(-1)!
    expect(req.path).toBe('/storage/v1/object/public-bucket/u1/avatar.png')
    expect(req.headers).toMatchObject({ 'x-upsert': 'false', 'content-type': 'image/png', authorization: `Bearer ${token}`, apikey: ANON_KEY })

    const { publicUrl } = sb.storage.from('public-bucket').getPublicUrl('u1/avatar.png').data
    expect(publicUrl).toBe(`${fake.url}/storage/v1/object/public/public-bucket/u1/avatar.png`)
    const res = await fetch(publicUrl)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('png-bytes')
  })

  it('second upload without upsert is a StorageApiError; with upsert it overwrites', async () => {
    const { sb } = await signedIn()
    const api = sb.storage.from('docs')
    await api.upload('a.txt', 'one', { contentType: 'text/plain' })
    const dup = await api.upload('a.txt', 'two')
    expect(dup.data).toBeNull()
    expect(dup.error).toBeInstanceOf(StorageApiError)
    expect(dup.error).toMatchObject({ status: 409, statusCode: '409', message: 'The resource already exists' })
    expect((await api.upload('a.txt', 'two', { upsert: true })).error).toBeNull()
    const dl = await api.download('a.txt')
    expect(await dl.data!.text()).toBe('two')
  })

  it('createSignedUrl returns an absolute URL that serves the file', async () => {
    const { sb } = await signedIn()
    await sb.storage.from('docs').upload('signed/x.pdf', new Blob(['pdf'], { type: 'application/pdf' }))
    const { data, error } = await sb.storage.from('docs').createSignedUrl('signed/x.pdf', 300)
    expect(error).toBeNull()
    expect(data!.signedUrl.startsWith(`${fake.url}/storage/v1/object/sign/docs/signed/x.pdf?token=`)).toBe(true)
    expect(JSON.parse(fake.requests.at(-1)!.body)).toEqual({ expiresIn: 300 })
    expect((await fetch(data!.signedUrl)).status).toBe(200)
  })

  it('createSignedUrl keeps a key with a space and Turkish characters intact (no double encoding)', async () => {
    const { sb } = await signedIn()
    const key = 'belgeler/öğrenci kartı & ş.pdf'
    expect((await sb.storage.from('docs').upload(key, new Blob(['tr'], { type: 'application/pdf' }))).error).toBeNull()
    expect(fake.objects.has(`docs/${key}`)).toBe(true)
    const { data, error } = await sb.storage.from('docs').createSignedUrl(key, 60)
    expect(error).toBeNull()
    expect(data!.signedUrl).toContain('/object/sign/docs/belgeler/%C3%B6%C4%9Frenci%20kart%C4%B1%20%26%20%C5%9F.pdf?token=')
    expect(data!.signedUrl).not.toContain('%25')
    const res = await fetch(data!.signedUrl)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('tr')
  })

  it('list and remove', async () => {
    const { sb } = await signedIn()
    const api = sb.storage.from('lst')
    await api.upload('f/1.txt', 'a')
    await api.upload('f/2.txt', 'b')
    const listed = await api.list('f', { limit: 100 })
    expect(listed.data!.map((o) => o.name).sort()).toEqual(['1.txt', '2.txt'])
    expect(JSON.parse(fake.requests.at(-1)!.body)).toMatchObject({ prefix: 'f', limit: 100, offset: 0 })
    const removed = await api.remove(['f/1.txt', 'f/2.txt'])
    expect(removed.error).toBeNull()
    expect(removed.data).toHaveLength(2)
    expect(fake.requests.at(-1)!).toMatchObject({ method: 'DELETE', path: '/storage/v1/object/lst' })
    expect(fake.objects.has('lst/f/1.txt')).toBe(false)
  })

  it('missing object: download error, not a throw', async () => {
    const { sb } = await signedIn()
    const { data, error } = await sb.storage.from('docs').download('nope.txt')
    expect(data).toBeNull()
    expect(error).toBeInstanceOf(StorageApiError)
  })
})

describe('functions', () => {
  it('invoke posts JSON with the session token and parses the JSON reply', async () => {
    const { sb, token } = await signedIn()
    const { data, error } = await sb.functions.invoke('echo', { body: { question: 'hi' } })
    expect(error).toBeNull()
    expect(data).toMatchObject({ method: 'POST', authorization: `Bearer ${token}`, apikey: ANON_KEY, contentType: 'application/json', body: '{"question":"hi"}' })
  })

  it('GET without body and text replies', async () => {
    const sb = createClient(fake.url, ANON_KEY, opts)
    expect((await sb.functions.invoke('echo', { method: 'GET' })).data).toMatchObject({ method: 'GET', authorization: `Bearer ${ANON_KEY}` })
    expect((await sb.functions.invoke('text')).data).toBe('hello')
  })

  it('headers option overrides Authorization', async () => {
    const sb = createClient(fake.url, ANON_KEY, opts)
    const { data } = await sb.functions.invoke('echo', { headers: { Authorization: 'Bearer custom' } })
    expect(data.authorization).toBe('Bearer custom')
  })

  it('500 → FunctionsHttpError whose context is the Response', async () => {
    const sb = createClient(fake.url, ANON_KEY, opts)
    const { data, error } = await sb.functions.invoke('fail', { body: {} })
    expect(data).toBeNull()
    expect(error).toBeInstanceOf(FunctionsHttpError)
    expect(error!.context.status).toBe(500)
    expect(await error!.context.json()).toEqual({ error: 'boom' })
  })

  it('network failure → FunctionsFetchError', async () => {
    const sb = createClient('http://127.0.0.1:1', ANON_KEY, opts)
    expect((await sb.functions.invoke('x')).error).toBeInstanceOf(FunctionsFetchError)
  })
})
