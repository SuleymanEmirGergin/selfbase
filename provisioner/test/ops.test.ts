// Real Docker: the provisioner in compose.test.yml, behind the socket proxy, against the fixture template.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { api, BACKUP_DIR, docker, down, IMAGE, PROXY_CONTAINER, PROXY_NET, tryDocker, up } from './fixtures/stack.ts'

const REF = 'sbtestopsaaaaaaaaaaa'
const MISSING = 'sbtestopsbbbbbbbbbbb'
const UNLABELLED = 'sbtestopsccccccccccc'
const IMPOSTOR = 'selfbase-test-impostor'
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
  // again: the project network cannot be removed while control's stand-in (gone with down) is attached
  leftovers()
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

test('env missing a render variable is 400 invalid_env; other bad input is 400', async () => {
  const r = await api('POST', `/projects/${REF}/ensure`, input({ env: {} }))
  assert.deepEqual([r.status, r.body.error], [400, 'invalid_env'])
  assert.match(r.body.message, /MARKER/)
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
  // control connects to this address, never to a name Docker's DNS may answer from another network
  for (const s of r.body.services) assert.equal(s.projectIp, docker('inspect', '-f', `{{(index .NetworkSettings.Networks "sb-${REF}").IPAddress}}`, `sb-${REF}-${s.service}`))
  // fixed addresses from base+2; the gateway stays base+1
  assert.deepEqual(r.body.services.map((s: any) => s.projectIp), ['10.207.250.2', '10.207.250.3'])
  assert.equal(docker('network', 'inspect', '-f', '{{(index .IPAM.Config 0).Gateway}}', `sb-${REF}`), '10.207.250.1')
  assert.match(r.body.services[1].projectIp, /^10\.207\.250\.\d+$/)
  assert.equal(docker('network', 'inspect', '-f', '{{(index .IPAM.Config 0).Subnet}} {{index .Labels "selfbase.project"}}', `sb-${REF}`), `10.207.250.0/27 ${REF}`)
  for (const v of ['pgdata', 'storage']) assert.equal(docker('volume', 'inspect', '-f', '{{index .Labels "selfbase.managed"}}', `sb-${REF}-${v}`), 'true')
  for (const s of ['db', 'core']) {
    const labels = JSON.parse(docker('inspect', '-f', '{{json .Config.Labels}}', `sb-${REF}-${s}`))
    assert.equal(labels['selfbase.managed'], 'true')
    assert.equal(labels['selfbase.project'], REF)
    assert.match(labels['selfbase.spec'], /^[0-9a-f]{64}$/)
  }
  assert.match(docker('inspect', '-f', '{{json .NetworkSettings.Networks}}', `sb-${REF}-core`), new RegExp(PROXY_NET))
  // depends_on order: db (core's dependency) was started first
  const started = (s: string) => Date.parse(docker('inspect', '-f', '{{.State.StartedAt}}', `sb-${REF}-${s}`))
  assert.ok(started('db') <= started('core'))
})

test('ensure refuses an existing network with another subnet, changing nothing', async () => {
  const before = ids()
  const r = await api('POST', `/projects/${REF}/ensure`, input({ subnet: '10.207.250.64/27' }))
  assert.deepEqual([r.status, r.body.error], [409, 'subnet_conflict'])
  assert.deepEqual(ids(), before)
})

test('a job for a project without a network is 404, nothing created', async () => {
  const r = await api('POST', `/projects/${MISSING}/jobs`, { type: 'backup', args: { dir: MISSING }, env: {} })
  assert.deepEqual([r.status, r.body.error], [404, 'project_not_found'])
  assert.equal(tryDocker('inspect', `sb-${MISSING}-job-backup`), null)
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
  // reverse order: core (the dependent) stopped before db
  const finished = (s: string) => Date.parse(docker('inspect', '-f', '{{.State.FinishedAt}}', `sb-${REF}-${s}`))
  assert.ok(finished('core') <= finished('db'))
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
  assert.equal((await api('GET', `/projects/${REF}/services/nope/stats`)).body.error, 'invalid_service')
  assert.equal((await api('GET', `/projects/${REF}/services/job-backup/logs`)).body.error, 'invalid_service')
})

test('a backup job runs, a second one is 409, the result is read once', async () => {
  // another org's directory next to ours: the job must not see it (R5)
  docker('run', '--rm', '-v', `${BACKUP_DIR}:/b`, IMAGE, 'mkdir', '-p', '/b/other-org')
  const first = await api('POST', `/projects/${REF}/jobs`, { type: 'backup', args: { dir: `export-${REF}` }, env: {} })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.match(first.body.id, /^[0-9a-f]{64}$/)
  const second = await api('POST', `/projects/${REF}/jobs`, { type: 'backup', args: { dir: REF }, env: {} })
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
  assert.match(s.tail, new RegExp(`^backup fixture sees: export-${REF} $`, 'm'))
  // the whole backup directory is never mounted; a directory that is not the ref's own is refused
  const foreign = await api('POST', `/projects/${REF}/jobs`, { type: 'backup', args: { dir: 'other-org' }, env: {} })
  assert.deepEqual([foreign.status, foreign.body.error], [400, 'invalid_dir'])
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

test('a delete and a job create for the same ref do not interleave: no job container outlives the delete', async () => {
  for (let i = 0; i < 3; i++) {
    assert.equal((await api('POST', `/projects/${REF}/ensure`, input())).status, 200)
    const [del, job] = await Promise.all([api('DELETE', `/projects/${REF}?volumes=true`),
      api('POST', `/projects/${REF}/jobs`, { type: 'backup', args: { dir: `export-${REF}` }, env: {} })])
    assert.equal(del.status, 200)
    assert.ok([200, 404].includes(job.status), JSON.stringify(job.body))
    assert.equal(tryDocker('inspect', `sb-${REF}-job-backup`), null, `round ${i}: job ${job.status}`)
  }
})

test("GET /proxy: the proxy's address by its exact container name, never a DNS alias of it", async () => {
  // an impostor on the proxy network carrying the proxy's name as an alias: a DNS lookup would answer both
  tryDocker('rm', '-f', PROXY_CONTAINER, IMPOSTOR)
  docker('run', '-d', '--init', '--name', PROXY_CONTAINER, '--network', PROXY_NET, IMAGE)
  docker('run', '-d', '--init', '--name', IMPOSTOR, '--network', PROXY_NET, '--network-alias', PROXY_CONTAINER, IMAGE)
  try {
    const r = await api('GET', '/proxy')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const ip = (n: string) => docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${PROXY_NET}").IPAddress}}`, n)
    assert.deepEqual(r.body, { container: PROXY_CONTAINER, addresses: [ip(PROXY_CONTAINER)] })
    docker('stop', '-t', '1', PROXY_CONTAINER)
    assert.equal((await api('GET', '/proxy')).status, 503)
  } finally {
    tryDocker('rm', '-f', PROXY_CONTAINER, IMPOSTOR)
  }
})

test('R1: impostors aliased db, db.sb-<ref>, rest.sb-<ref> and fn.sb-<ref> on the proxy network never reach core; it trusts the proxy', async () => {
  const ROGUE = 'selfbase-test-rogue-db'
  const SPACER = 'selfbase-test-spacer'
  const proxyIpOf = () => docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${PROXY_NET}").IPAddress}}`, PROXY_CONTAINER)
  tryDocker('rm', '-f', PROXY_CONTAINER, ROGUE, SPACER)
  docker('run', '-d', '--init', '--name', PROXY_CONTAINER, '--network', PROXY_NET, IMAGE)
  docker('run', '-d', '--init', '--name', ROGUE, '--network', PROXY_NET, '--network-alias', 'db', '--network-alias', `db.sb-${REF}`,
    '--network-alias', `rest.sb-${REF}`, '--network-alias', `fn.sb-${REF}`, IMAGE)
  try {
    const r = await api('POST', `/projects/${REF}/ensure`, input())
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const env = JSON.parse(docker('inspect', '-f', '{{json .Config.Env}}', `sb-${REF}-core`)) as string[]
    const dbIp = r.body.services.find((s: any) => s.service === 'db').projectIp
    // db's fixed address (base+2), an IP literal: nothing to resolve
    assert.equal(dbIp, '10.207.250.2')
    assert.ok(env.includes(`DB_HOST=${dbIp}`), env.join(' '))
    const proxyIp = proxyIpOf()
    assert.ok(env.includes(`TRUSTED_PROXY_IPS=${proxyIp}`), env.join(' '))
    assert.equal(r.body.services.find((s: any) => s.service === 'core').proxyStale, false)
    const lookup = (name: string) =>
      docker('exec', `sb-${REF}-core`, 'node', '-e', `require('dns').lookup('${name}', (e, a) => console.log(e ? 'error' : a))`)
    const rogueIp = docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${PROXY_NET}").IPAddress}}`, ROGUE)
    // the bare name goes to /etc/hosts (ExtraHosts), ahead of Docker's DNS
    for (let i = 0; i < 3; i++) assert.equal(lookup('db'), dbIp)
    // the hijack itself is Docker's: the dotted alias wins over db on sb-<ref>. Nothing of ours resolves that name now.
    assert.equal(lookup(`db.sb-${REF}`), rogueIp)
    assert.ok(!env.some((e) => e.includes(`.sb-${REF}`)), env.join(' '))
    // the proxy comes back with another address: core is reported stale, so reconcile re-applies it
    docker('rm', '-f', PROXY_CONTAINER)
    docker('run', '-d', '--init', '--name', SPACER, '--network', PROXY_NET, IMAGE)
    docker('run', '-d', '--init', '--name', PROXY_CONTAINER, '--network', PROXY_NET, IMAGE)
    assert.notEqual(proxyIpOf(), proxyIp)
    const s = await api('GET', `/projects/${REF}`)
    assert.equal(s.body.services.find((x: any) => x.service === 'core').proxyStale, true)
  } finally {
    tryDocker('rm', '-f', PROXY_CONTAINER, ROGUE, SPACER)
  }
})

test('R1 upgrade: a project made before fixed addresses is recreated in place on them; its volumes and data stay', async () => {
  assert.equal((await api('DELETE', `/projects/${REF}?volumes=true`)).status, 200)
  const net = `sb-${REF}`
  const ipOn = (c: string) => docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, c)
  // as an earlier provisioner left it: a /27 without an IPRange, dynamic addresses, data in the volume
  docker('network', 'create', '--subnet', '10.207.250.0/27', '--label', 'selfbase.managed=true', '--label', `selfbase.project=${REF}`, net)
  docker('volume', 'create', `sb-${REF}-pgdata`)
  docker('run', '--rm', '-v', `sb-${REF}-pgdata:/d`, IMAGE, 'sh', '-c', 'echo kept > /d/data-marker')
  docker('run', '-d', '--init', '--name', `sb-${REF}-db`, '--network', net, '--ip', '10.207.250.4', '-v', `sb-${REF}-pgdata:/data`, IMAGE)
  docker('run', '-d', '--init', '--name', `sb-${REF}-core`, '--network', net, '--ip', '10.207.250.6', IMAGE)
  // a running job on it: refused before anything changes
  docker('run', '-d', '--init', '--name', `sb-${REF}-job-backup`, '--network', net, '--ip', '10.207.250.2', IMAGE)
  const before = ids()
  const busy = await api('POST', `/projects/${REF}/ensure`, input())
  assert.deepEqual([busy.status, busy.body.error], [409, 'network_busy'], JSON.stringify(busy.body))
  assert.deepEqual(ids(), before)
  docker('rm', '-f', `sb-${REF}-job-backup`)
  // the old core on db's address, control on core's
  docker('network', 'disconnect', net, `sb-${REF}-core`)
  docker('network', 'connect', '--ip', '10.207.250.2', net, `sb-${REF}-core`)
  docker('network', 'connect', '--ip', '10.207.250.3', net, 'selfbase-test-control')
  const r = await api('POST', `/projects/${REF}/ensure`, input())
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.services.map((s: any) => [s.service, s.state, s.projectIp]), [['db', 'running', '10.207.250.2'], ['core', 'running', '10.207.250.3']])
  assert.equal(r.body.controlAttached, true)
  const controlIp = Number(ipOn('selfbase-test-control').split('.')[3])
  assert.ok(controlIp >= 16 && controlIp < 31, `control at .${controlIp}`)
  assert.equal(tryDocker('run', '--rm', '-v', `sb-${REF}-pgdata:/d`, IMAGE, 'cat', '/d/data-marker'), 'kept')
  assert.equal(docker('network', 'inspect', '-f', '{{(index .IPAM.Config 0).Subnet}} {{(index .IPAM.Config 0).IPRange}} {{(index .IPAM.Config 0).Gateway}}', net),
    '10.207.250.0/27 10.207.250.16/28 10.207.250.1')
  const upgraded = ids()
  assert.equal((await api('POST', `/projects/${REF}/ensure`, input())).status, 200)
  assert.deepEqual(ids(), upgraded)
})
