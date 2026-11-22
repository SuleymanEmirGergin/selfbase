// The provisioner client forgets a project's cached core address after every call that can recreate, stop or remove
// its containers, so the next admin call asks the provisioner again instead of using an address another container
// may hold by now.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { coreIp } from '../src/core-addr.ts'
import { httpProvisioner } from '../src/provisioner.ts'

const REF = 'clientcacheaaaaaaaaa'
const TOKEN = 't'.repeat(40)
let ip = '10.207.0.3'
let inspects = 0
const state = () => ({ ref: REF, network: true, controlAttached: true, services: [{ service: 'core', exists: true, state: 'running',
  health: 'healthy', specHash: 'h', templateVersion: 'v', memLimitMb: 64, proxyAttached: true, projectIp: ip }] })
const server = createServer((req, res) => {
  req.resume()
  if (req.method === 'GET' && req.url === `/projects/${REF}`) inspects++
  const body = req.method === 'DELETE' ? { removed: { containers: [], volumes: [], network: true } } : state()
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
})
let p: ReturnType<typeof httpProvisioner>

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  p = httpProvisioner(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, TOKEN)
})
afterAll(() => new Promise((r) => server.close(r)))

it('ensure, start, stop, remove and attach-proxy each make the next lookup ask again', async () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['ensure', () => p.ensure({ ref: REF, templateVersion: 'v', size: 'micro', subnet: '10.207.0.0/27', hosts: [], env: {} })],
    ['start', () => p.start(REF)], ['stop', () => p.stop(REF)], ['remove', () => p.remove(REF, false)], ['attachProxy', () => p.attachProxy(REF)],
  ]
  for (const [name, call] of calls) {
    const before = await coreIp(p, REF)
    ip = `10.207.0.${Number(before.split('.')[3]) + 1}`
    expect(await coreIp(p, REF), `${name}: cached`).toBe(before)
    const n = inspects
    await call()
    expect(await coreIp(p, REF), `${name}: asked again`).toBe(ip)
    expect(inspects, name).toBe(n + 1)
  }
})
