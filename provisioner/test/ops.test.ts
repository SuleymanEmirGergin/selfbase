// Real Docker: the provisioner in compose.test.yml, behind the socket proxy, against the fixture template.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { api, docker, down, IMAGE, PROXY_NET, tryDocker, up } from './fixtures/stack.ts'

const REF = 'sbtestopsaaaaaaaaaaa'
const MISSING = 'sbtestopsbbbbbbbbbbb'
const UNLABELLED = 'sbtestopsccccccccccc'
const input = (over: Record<string, unknown> = {}) => ({ templateVersion: 'test', size: 'micro', subnet: '10.207.250.0/27',
  hosts: ['sbtest.example.com'], env: { MARKER: 'one' }, ...over })
const id = (name: string) => docker('inspect', '-f', '{{.Id}}', name)
const ids = () => ({ db: id(`sb-${REF}-db`), core: id(`sb-${REF}-core`) })
const leftovers = () => {
  for (const r of [REF, MISSING, UNLABELLED]) {
    for (const s of ['db', 'core', 'job-backup']) tryDocker('rm', '-f', `sb-${r}-${s}`)
    for (const v of ['pgdata', 'storage']) tryDocker('volume', 'rm', `sb-${r}-${v}`)
    tryDocker('network', 'rm', `sb-${r}`)
  }
}

before(async () => {
  leftovers()
  await up()
})
after(() => {
  leftovers()
  down()
})

test('a wrong bearer is 401; /health needs none', async () => {
  assert.equal((await api('GET', '/projects', undefined, 'wrong')).status, 401)
  assert.equal((await api('POST', `/projects/${REF}/ensure`, input(), 'wrong')).status, 401)
  const h = await fetch(`http://127.0.0.1:${process.env.TEST_PROVISIONER_PORT ?? 58090}/health`).then((r) => r.json())
  assert.deepEqual(h, { ok: true, templateVersion: 'test' })
})

test('an image neither local nor pullable is 502 image_unavailable, nothing created', async () => {
  const r = await api('POST', `/projects/${MISSING}/ensure`, input({ templateVersion: 'missing', subnet: '10.207.250.32/27' }))
  assert.equal(r.status, 502)
  assert.equal(r.body.error, 'image_unavailable')
  assert.match(r.body.message, /selfbase-db:missing/)
  assert.equal(tryDocker('network', 'inspect', `sb-${MISSING}`), null)
})

test('a template that cannot render is 500 template_invalid; bad input is 400', async () => {
  const r = await api('POST', `/projects/${REF}/ensure`, input({ env: {} }))
  assert.deepEqual([r.status, r.body.error], [500, 'template_invalid'])
  assert.equal((await api('POST', `/projects/${REF}/ensure`, input({ subnet: '10.208.0.0/27' }))).body.error, 'invalid_subnet')
  assert.equal((await api('GET', '/projects/NOT-A-REF')).body.error, 'invalid_ref')
  assert.deepEqual(Object.values(await api('GET', '/projects/%E0')).map((v: any) => v.error ?? v), [400, 'invalid_path'])
})

test('ensure creates network, volumes and labelled containers', async () => {
  const r = await api('POST', `/projects/${REF}/ensure`, input())
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.network, true)
  assert.equal(r.body.controlAttached, true)
  assert.deepEqual(r.body.services.map((s: any) => [s.service, s.exists, s.state, s.memLimitMb]), [['db', true, 'running', 32], ['core', true, 'running', 32]])
  assert.deepEqual(r.body.services.map((s: any) => s.proxyAttached), [false, true])
  assert.equal(docker('network', 'inspect', '-f', '{{(index .IPAM.Config 0).Subnet}} {{index .Labels "selfbase.project"}}', `sb-${REF}`), `10.207.250.0/27 ${REF}`)
  for (const v of ['pgdata', 'storage']) assert.equal(docker('volume', 'inspect', '-f', '{{index .Labels "selfbase.managed"}}', `sb-${REF}-${v}`), 'true')
  for (const s of ['db', 'core']) {
    const labels = JSON.parse(docker('inspect', '-f', '{{json .Config.Labels}}', `sb-${REF}-${s}`))
    assert.equal(labels['selfbase.managed'], 'true')
    assert.equal(labels['selfbase.project'], REF)
    assert.match(labels['selfbase.spec'], /^[0-9a-f]{64}$/)
  }
  assert.match(docker('inspect', '-f', '{{json .NetworkSettings.Networks}}', `sb-${REF}-core`), new RegExp(PROXY_NET))
})

test('a second ensure changes nothing', async () => {
  const before = ids()
  assert.equal((await api('POST', `/projects/${REF}/ensure`, input())).status, 200)
  assert.deepEqual(ids(), before)
})

test('changing one env value recreates only that service', async () => {
  const before = ids()
  assert.equal((await api('POST', `/projects/${REF}/ensure`, input({ env: { MARKER: 'two' } }))).status, 200)
  const now = ids()
  assert.notEqual(now.db, before.db)
  assert.equal(now.core, before.core)
  // the old db got SIGTERM and wrote its marker; a SIGKILL (force remove) would leave none
  assert.equal(tryDocker('run', '--rm', '-v', `sb-${REF}-pgdata:/d`, IMAGE, 'cat', '/d/stopped-cleanly'), 'clean')
})

test("recreate:['core'] recreates only core", async () => {
  const before = ids()
  const r = await api('POST', `/projects/${REF}/ensure`, input({ env: { MARKER: 'two' }, recreate: ['core'] }))
  assert.equal(r.status, 200)
  const now = ids()
  assert.equal(now.db, before.db)
  assert.notEqual(now.core, before.core)
  assert.equal(r.body.services[1].proxyAttached, true)
  assert.equal((await api('POST', `/projects/${REF}/ensure`, input({ recreate: ['nope'] }))).body.error, 'invalid_recreate')
})

test('stop then start', async () => {
  const stopped = await api('POST', `/projects/${REF}/stop`, {})
  assert.deepEqual(stopped.body.services.map((s: any) => s.state), ['exited', 'exited'])
  const started = await api('POST', `/projects/${REF}/start`, { services: ['db'] })
  assert.deepEqual(started.body.services.map((s: any) => s.state), ['running', 'exited'])
  assert.deepEqual((await api('POST', `/projects/${REF}/start`)).body.services.map((s: any) => s.state), ['running', 'running'])
})

test('a container removed by hand is recreated by ensure', async () => {
  docker('rm', '-f', `sb-${REF}-core`)
  const gone = await api('GET', `/projects/${REF}`)
  assert.equal(gone.body.services[1].exists, false)
  const r = await api('POST', `/projects/${REF}/ensure`, input({ env: { MARKER: 'two' } }))
  assert.equal(r.body.services[1].state, 'running')
  assert.equal(r.body.services[1].proxyAttached, true)
})

test('GET /projects lists only labelled objects', async () => {
  docker('create', '--name', `sb-${UNLABELLED}-db`, IMAGE)
  const r = await api('GET', '/projects')
  assert.equal(r.status, 200)
  const refs = r.body.map((p: any) => p.ref)
  assert.ok(refs.includes(REF))
  assert.ok(!refs.includes(UNLABELLED))
})

test('logs and stats', async () => {
  const logs = await api('GET', `/projects/${REF}/services/db/logs?tail=10`)
  assert.equal(logs.status, 200)
  assert.equal(typeof logs.body, 'string')
  const stats = await api('GET', `/projects/${REF}/services/db/stats`)
  assert.equal(stats.body.mem_limit_mb, 32)
  assert.equal(typeof stats.body.cpu_percent, 'number')
  assert.equal((await api('GET', `/projects/${REF}/services/nope/stats`)).status, 404)
})

test('a backup job runs, a second one is 409, the result is read once', async () => {
  const first = await api('POST', `/projects/${REF}/jobs`, { type: 'backup', args: { dir: 'slow' }, env: {} })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.match(first.body.id, /^[0-9a-f]{64}$/)
  const second = await api('POST', `/projects/${REF}/jobs`, { type: 'backup', args: {}, env: {} })
  assert.equal(second.status, 409)
  assert.equal(second.body.error, 'job_running')
  assert.equal((await api('GET', `/projects/${REF}/jobs/backup`)).body.status, 'running')
  let s: any
  for (let i = 0; i < 40; i++) {
    s = (await api('GET', `/projects/${REF}/jobs/backup`)).body
    if (s.status !== 'running') break
    await new Promise((r) => setTimeout(r, 500))
  }
  assert.equal(s.status, 'succeeded', JSON.stringify(s))
  assert.equal(s.exitCode, 0)
  assert.match(s.tail, /backup fixture done/)
  assert.equal(tryDocker('inspect', `sb-${REF}-job-backup`), null)
  assert.equal((await api('GET', `/projects/${REF}/jobs/backup`)).status, 404)
  assert.equal((await api('POST', `/projects/${REF}/jobs`, { type: 'clone', args: {}, env: {} })).status, 501)
  // a job container whose start failed stays 'created': reported failed and removed on that read
  docker('create', '--name', `sb-${REF}-job-backup`, IMAGE)
  const stuck = await api('GET', `/projects/${REF}/jobs/backup`)
  assert.deepEqual([stuck.body.status, stuck.body.exitCode], ['failed', null])
  assert.equal(tryDocker('inspect', `sb-${REF}-job-backup`), null)
})

test('delete keeps volumes with volumes=false and removes them with true', async () => {
  const kept = await api('DELETE', `/projects/${REF}?volumes=false`)
  assert.equal(kept.status, 200)
  assert.deepEqual(kept.body.removed, { containers: [`sb-${REF}-core`, `sb-${REF}-db`], volumes: [], network: true })
  assert.notEqual(tryDocker('volume', 'inspect', `sb-${REF}-pgdata`), null)
  assert.equal(tryDocker('network', 'inspect', `sb-${REF}`), null)
  assert.ok(!docker('inspect', '-f', '{{json .NetworkSettings.Networks}}', 'selfbase-test-control').includes(`sb-${REF}`))
  const gone = await api('DELETE', `/projects/${REF}?volumes=true`)
  assert.deepEqual(gone.body.removed, { containers: [], volumes: [`sb-${REF}-pgdata`, `sb-${REF}-storage`], network: false })
  assert.equal(tryDocker('volume', 'inspect', `sb-${REF}-pgdata`), null)
  assert.equal((await api('DELETE', `/projects/${REF}?volumes=maybe`)).status, 400)
})
