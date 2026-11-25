// ensure against a stand-in engine that turns IPv6 on for every network it makes, whatever the body says: the loop
// guard trips once, and from then on a network that reads back with IPv6 on is refused, never rebuilt or adopted.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { validateTemplate } from '../src/template.ts'
import { buildProject, type Sizes } from '../src/spec.ts'
import type { NodeSettings } from '../src/settings.ts'

const tpl = validateTemplate(parse(readFileSync(fileURLToPath(new URL('./fixtures/template.yml', import.meta.url)), 'utf8')))
const row = { mem_mb: 128, cpus: 0.5, pids: 512 }
const SIZES = { micro: { db: { ...row, shm_mb: 64, shared_buffers: '128MB', max_connections: 60 }, rest: row, core: row, fn: row,
  pooler: { mem_mb: 32, cpus: 0.25, pids: 64, pool_size: 15 } } } as unknown as Sizes
const NODE: NodeSettings = {
  registry: 'ghcr.io/acme/selfbase', templateVersion: '2.1.0', proxyNetwork: 'coolify', entrypointHttp: 'http',
  entrypointHttps: 'https', certResolver: '', logSyslogAddr: 'udp://127.0.0.1:5514', cgroupParent: '',
  backupHostDir: '/opt/selfbase/backups', subnetPool: '10.207.0.0/16', controlContainer: 'selfbase-control',
  controlNetwork: 'selfbase', proxyContainer: 'coolify-proxy',
}
const ENV = { POSTGRES_PASSWORD: 'pw', AUTHENTICATOR_PASSWORD: 'apw', JWT_SECRET: 'j', ADMIN_TOKEN: 't', ANON_KEY: 'a',
  SERVICE_ROLE_KEY: 's', PUBLIC_URL: 'https://x', SITE_URL: 'https://y' }
const body = (ref: string, subnet: string) => ({ templateVersion: '2.1.0', size: 'micro', subnet, hosts: [`${ref}.example.com`], env: ENV })

const nets = new Map<string, any>()
const calls: string[] = []
let forget = false // the stand-in makes a network but cannot read it back (404), as a racing removal would
const engine = createServer(async (req, res) => {
  let text = ''
  for await (const c of req) text += c
  const path = new URL(req.url!, 'http://x').pathname.replace(/^\/v1\.45/, '')
  calls.push(`${req.method} ${path}`)
  const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
  const net = path.match(/^\/networks\/([^/]+)$/)
  if (path === '/version') return send(200, { Version: '29.0.0' })
  if (path === `/containers/${NODE.proxyContainer}/json`) {
    return send(200, { Name: `/${NODE.proxyContainer}`, State: { Running: true }, NetworkSettings: { Networks: { coolify: { IPAddress: '10.0.9.2' } } } })
  }
  if (req.method === 'GET' && path.startsWith('/containers/')) return send(404, { message: 'no such container' })
  if (req.method === 'GET' && path.startsWith('/images/')) return send(200, {})
  // the stand-in: IPv6 on, whatever the body asked for
  if (req.method === 'POST' && path === '/networks/create') {
    const b = JSON.parse(text)
    if (!forget) nets.set(b.Name, { ...b, EnableIPv6: true, Containers: {} })
    return send(201, { Id: b.Name })
  }
  if (req.method === 'GET' && net) return nets.has(net[1]) ? send(200, nets.get(net[1])) : send(404, { message: 'no such network' })
  send(500, { message: `the stand-in engine does not answer ${req.method} ${path}` })
})
await new Promise<void>((r) => engine.listen(0, '127.0.0.1', r))
process.env.DOCKER_HOST = `http://127.0.0.1:${(engine.address() as { port: number }).port}`
const { ensure } = await import('../src/ops.ts')
const ctx = { tpl, sizes: SIZES, node: NODE }
after(() => engine.close())

const refusedV6 = (e: any) => e?.status === 503 && e?.code === 'network_ipv6' && /IPv6/.test(e.message)
const changes = (from: number) => calls.slice(from).filter((c) => !c.startsWith('GET '))

test('a network the engine makes with IPv6 on trips the guard and the ensure is refused before any container', async () => {
  await assert.rejects(ensure(ctx, 'aaaaaaaaaaaaaaaaaaaa', body('aaaaaaaaaaaaaaaaaaaa', '10.207.0.32/27')), refusedV6)
  assert.ok(!calls.some((c) => c.startsWith('POST /containers') || c.startsWith('POST /volumes')), calls.join('\n'))
})

test('after the guard tripped, the same project is refused again and its networks are not rebuilt', async () => {
  const from = calls.length
  await assert.rejects(ensure(ctx, 'aaaaaaaaaaaaaaaaaaaa', body('aaaaaaaaaaaaaaaaaaaa', '10.207.0.32/27')), refusedV6)
  assert.deepEqual(changes(from), [])
})

test('after the guard tripped, a second project whose networks have IPv6 on is refused, not adopted', async () => {
  const ref = 'bbbbbbbbbbbbbbbbbbbb'
  for (const n of buildProject({ ref, ...body(ref, '10.207.0.64/27') }, tpl, SIZES, NODE, [], true).networks) {
    nets.set(n.name, { ...n.body, EnableIPv6: true, Containers: {} })
  }
  const from = calls.length
  await assert.rejects(ensure(ctx, ref, body(ref, '10.207.0.64/27')), refusedV6)
  assert.deepEqual(changes(from), [])
})

test('a network that cannot be read back right after it was made is a clear refusal, not a TypeError', async () => {
  forget = true
  try {
    await assert.rejects(ensure(ctx, 'cccccccccccccccccccc', body('cccccccccccccccccccc', '10.207.0.96/27')),
      (e: any) => e?.status === 502 && e?.code === 'docker_refused' && /cannot be read back/.test(e.message))
  } finally {
    forget = false
  }
})
