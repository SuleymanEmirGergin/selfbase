// End-to-end proof of the control stack (plan Task 17), PROXY_MODE=own on this Docker host:
//   node --test test/e2e/stack.test.mjs          (from the repository root; README.md has the details)
// Builds every image locally (CC-1), starts control/compose.yml as compose project selfbase-t17 with Traefik on
// 18080/18443, and drives projects through the API, supabase-shaped HTTP and Studio. The cases run in order and
// share state. E2E_KEEP=1 leaves the stack up at the end (Task 18 runs against it); otherwise everything this run
// created is removed and the host's other containers, networks and volumes are checked to be untouched.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CONTROL_HOST, E2E_DIR, FIXED, IMPOSTOR, ORIGIN, PROXY_NETWORK, SECRETS_DIR, SOCKET_GID, compose, connectFrom, docker, dockerOk, envFile,
  https, inspect, resolveFrom, root, run, runResources, snapshot, waitFor } from './helpers.mjs'

process.chdir(root)
const KEEP = process.env.E2E_KEEP === '1'
const SERVICES = ['db', 'rest', 'core', 'fn', 'pooler']
const CONTROL_STACK = ['selfbase-control', 'selfbase-control-db', 'selfbase-provisioner', 'selfbase-socket-proxy', 'selfbase-logs']
const OWNER = { email: 'owner@e2e.test', password: `e2e-${randomBytes(12).toString('base64url')}` }
const PASSPHRASE = `e2e export ${randomBytes(6).toString('hex')}`

let envPath, envDir, start, token
let tornDown = false
let madeProxyNetwork = false
let madeE2EDir = false
const P = {} // name -> { ref, host, anon }
const refs = new Set() // every project ref this run created (teardown removes only these)

const log = (msg) => console.log(`# ${msg}`)
const psql = (sql) => docker('exec', 'selfbase-control-db', 'psql', '-U', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', sql)
const api = async (method, path, body) => {
  const r = await https(CONTROL_HOST, `/platform${path}`, { method, body, headers: { authorization: `Bearer ${token}` } })
  return r
}
const ok = async (method, path, body) => {
  const r = await api(method, path, body)
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`)
  return r.json
}
const sql = async (ref, query) => {
  const j = await ok('POST', `/projects/${ref}/admin/sql`, { query })
  assert.ok(!j.error, `${query}: ${j.error?.message}`)
  return j
}
// read from control-db: GET /platform/jobs/:id answers 404 once a delete job has marked its project REMOVED
const job = (id, timeout = 180_000) => waitFor(`job ${id}`, () => {
  const [st, ...error] = psql(`select status || '|' || coalesce(error, '') from control.jobs where id = '${id}'`).split('|')
  return ['succeeded', 'failed'].includes(st) && { status: st, error: error.join('|') }
}, { timeout, every: 1000 })
const status = async (ref) => (await ok('GET', `/projects/${ref}`)).status
const healthyProject = (ref, timeout = 180_000) => waitFor(`${ref} ACTIVE_HEALTHY`, async () => (await status(ref)) === 'ACTIVE_HEALTHY', { timeout })
const containersOf = (ref) => docker('ps', '-a', '--filter', `name=^sb-${ref}-`, '--format', '{{.Names}}').split('\n').filter(Boolean).sort()
// short: right after a container stops, Traefik may still send to its address for a moment, and that request hangs
const health = (host) => https(host, '/health', { timeout: 3000 })

async function create(name) {
  const t0 = Date.now()
  const r = await ok('POST', '/projects', { organization_slug: 'default', name, size: 'micro' })
  const ref = r.project.ref
  refs.add(ref)
  return { ref, jobId: r.job_id, t0 }
}
async function finish({ ref, jobId, t0 }, name) {
  const j = await job(jobId)
  assert.equal(j.status, 'succeeded', `create ${name}: ${j.error}`)
  await healthyProject(ref)
  const seconds = (Date.now() - t0) / 1000
  const host = (await ok('GET', `/projects/${ref}/domains`)).find((d) => d.kind === 'default').hostname
  const anon = (await ok('GET', `/projects/${ref}/api-keys`)).find((k) => k.name === 'anon').api_key
  P[name] = { ref, host, anon }
  log(`project ${name}: ${ref} on ${host}, ACTIVE_HEALTHY after ${seconds.toFixed(1)} s`)
  return seconds
}

function teardown() {
  if (tornDown) return
  tornDown = true
  // control-db knows every project, also one whose create call the test never saw answered
  try { for (const r of psql('select ref from control.projects').split('\n').filter(Boolean)) refs.add(r) } catch {}
  // a removal that fails is listed and fails the teardown (case 11, or after()): leftovers are never silent
  const failed = []
  const attempt = (fn) => { try { fn() } catch (e) { failed.push(e.message.split('\n')[0]) } }
  // control first: its reconcile (every 30 s) would recreate the project containers removed below
  if (dockerOk('ps', '-aq', '--filter', 'name=^selfbase-control$')) attempt(() => docker('stop', '--time', '5', 'selfbase-control'))
  // projects next (control is attached to their networks), then the stack (its anonymous volumes with it; the named
  // ones below, by compose's label: never `down -v`), then what the run made by hand
  const mine = runResources(refs, { proxyNetwork: madeProxyNetwork })
  if (mine.containers.length) attempt(() => docker('rm', '-f', '-v', ...mine.containers))
  attempt(() => docker('rm', '-f', '-v', IMPOSTOR)) // run with --rm; only a killed run leaves it (before() checked it was not there)
  attempt(() => {
    compose(envPath, 'rm', '-f', '-s', '-v')
    compose(envPath, 'down', '--remove-orphans', '--timeout', '5')
  })
  for (const n of mine.networks) attempt(() => docker('network', 'rm', n))
  for (const v of mine.volumes) attempt(() => docker('volume', 'rm', '-f', v))
  // the run's host directory (backups, secrets, the env file's copy), only when this run made it
  if (madeE2EDir) attempt(() => docker('run', '--rm', '--user', '0', '--network', 'none', '-v', '/opt/selfbase:/o', IMAGE, 'rm', '-rf', `/o/${E2E_DIR.split('/').pop()}`))
  rmSync(envDir, { recursive: true, force: true })
  if (failed.length) throw new Error(`teardown could not remove:\n${failed.join('\n')}`)
}

// as root, no network, like the documented install commands (control/.env.example); an image without VOLUME (the job
// image's would leave an anonymous volume behind)
const IMAGE = 'selfbase.local/selfbase-control:e2e'
const asRoot = (args, opts) => run('docker', ['run', '--rm', '-i', '--user', '0', '--network', 'none', ...args], opts)

before(async () => {
  const now = snapshot()
  // never adopt a real install's (or a kept run's) resources: compose would use them and the teardown remove them
  for (const kind of ['containers', 'networks', 'volumes']) {
    const there = FIXED[kind].filter((n) => now[kind].includes(n))
    assert.equal(there.length, 0, `${kind} ${there.join(', ')} exist already: another selfbase stack (or a kept run) is here; remove it first`)
  }
  start = now // only now may after() tear down
  envDir = mkdtempSync(join(tmpdir(), 'sb-e2e-'))
  envPath = join(envDir, '.env')
  const envText = Object.entries(envFile()).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  writeFileSync(envPath, envText)
  chmodSync(envPath, 0o600)
  let t = Date.now()
  compose(envPath, '--profile', 'images', 'build')
  log(`images built in ${((Date.now() - t) / 1000).toFixed(0)} s`)
  const dir = E2E_DIR.split('/').pop()
  assert.equal(asRoot(['-v', '/opt/selfbase:/o', IMAGE, 'sh', '-c', `test -e /o/${dir} && echo exists || true`]), '',
    `${E2E_DIR} exists already (a kept or failed run): remove it first`)
  asRoot(['-v', '/opt/selfbase:/o', IMAGE, 'sh', '-c', `mkdir -m 0700 /o/${dir} /o/${dir}/secrets`])
  madeE2EDir = true
  // the install steps of control/.env.example, as written there: secret files, a root-only env file, the check
  asRoot(['-v', `${SECRETS_DIR}:/secrets`, IMAGE, 'node', '/app/scripts/gen-keys.mjs', '--secrets', '/secrets', '10001'])
  asRoot(['-v', `${E2E_DIR}:/o`, IMAGE, 'sh', '-c', 'umask 077; cat > /o/.env'], { input: envText })
  assert.equal(asRoot(['-e', `HOST_DOCKER_SOCKET_GID=${SOCKET_GID}`, '-v', `${E2E_DIR}/.env:/env:ro`, '-v', `${SECRETS_DIR}:/secrets:ro`, IMAGE,
    'node', '/app/scripts/install-check.mjs', '/env', '/secrets']), 'install-check: ok')
  docker('network', 'create', PROXY_NETWORK)
  madeProxyNetwork = true
  t = Date.now()
  compose(envPath, 'up', '-d', '--wait')
  // Traefik routes a container once its health check passes, a moment after compose's --wait returns
  await waitFor('Studio through Traefik', async () => (await https(CONTROL_HOST, '/health')).status === 200, { timeout: 30_000, every: 500 })
  log(`control stack up in ${((Date.now() - t) / 1000).toFixed(0)} s`)
  // AC-33: the control host's certificate counts against the weekly cap (an install records it; Task 20 step 4)
  psql(`insert into control.settings (key, value) values ('control_host_first_issued_at', now()::text) on conflict (key) do nothing`)
})

after(() => {
  if (KEEP) return log(`E2E_KEEP=1: the stack stays up (env file ${envPath}); owner ${OWNER.email}`)
  if (start) teardown()
})

test('1: owner, sign-in, project A healthy in under 120 s; admin and panel paths are not public', async () => {
  run('docker', ['exec', '-i', 'selfbase-control', 'node', 'src/cli.ts', 'create-owner', OWNER.email], { input: OWNER.password })
  const login = await https(CONTROL_HOST, '/platform/login', { method: 'POST', body: OWNER, headers: { origin: ORIGIN } })
  assert.equal(login.status, 200, login.text)
  const cookie = [login.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ')
  const tok = await https(CONTROL_HOST, '/platform/access-tokens', { method: 'POST', body: { name: 'e2e' }, headers: { origin: ORIGIN, cookie } })
  assert.equal(tok.status, 201, tok.text)
  token = tok.json.token
  assert.match(token, /^sbp_[0-9a-f]{40}$/)

  const seconds = await finish(await create('a'), 'a')
  assert.ok(seconds < 120, `create took ${seconds} s`)
  const { host, anon } = P.a
  assert.equal((await https(host, '/health')).status, 200)
  assert.equal((await https(host, '/rest/v1/', { headers: { apikey: anon, authorization: `Bearer ${anon}` } })).status, 200)
  for (const path of ['/admin/ready', '/panel/']) assert.equal((await https(host, path)).status, 404, path)
})

test('2: project B is isolated from A', async () => {
  await finish(await create('b'), 'b')
  const a = `sb-${P.a.ref}-core`
  const b = (s) => `sb-${P.b.ref}-${s}`
  for (const name of [b('db'), b('rest'), b('pooler')]) assert.match(resolveFrom(a, name), /ENOTFOUND|EAI_AGAIN/, name)
  const ipOn = (c, net) => inspect(c).NetworkSettings.Networks[net].IPAddress
  const bNet = `sb-${P.b.ref}`
  // the two cores share the proxy network (spec 7.3), so B's core name resolves from A, but only to that address
  assert.equal(resolveFrom(a, b('core')), ipOn(b('core'), PROXY_NETWORK))
  assert.equal(connectFrom(a, ipOn(b('db'), bNet), 5432), 'timeout')
  assert.equal(connectFrom(a, ipOn(b('core'), bNet), 8080), 'timeout')
  assert.equal(connectFrom(a, ipOn(b('core'), bNet), 8081), 'timeout')
  // and B's admin port refuses a peer from there (core's /27 check), token or not
  const admin = run('docker', ['exec', a, 'node', '-e', `fetch('http://${ipOn(b('core'), PROXY_NETWORK)}:8081/admin/ready').then(r=>console.log(r.status),e=>console.log(e.message))`])
  assert.equal(admin, '403')
  const onB = await https(P.b.host, '/rest/v1/', { headers: { apikey: P.a.anon, authorization: `Bearer ${P.a.anon}` } })
  assert.equal(onB.status, 401)
  const subnet = (ref) => JSON.parse(docker('network', 'inspect', `sb-${ref}`))[0].IPAM.Config[0].Subnet
  const [sa, sb] = [subnet(P.a.ref), subnet(P.b.ref)]
  assert.notEqual(sa, sb)
  for (const s of [sa, sb]) assert.match(s, /^10\.218\.\d+\.\d+\/27$/)
})

test('3: every project container is capped and hardened; control has no Docker socket', () => {
  const names = docker('ps', '-a', '--filter', 'name=^sb-', '--format', '{{.Names}}').split('\n').filter((n) => n && !start.containers.includes(n))
  assert.equal(names.length, 10)
  for (const n of names) {
    const h = inspect(n).HostConfig
    assert.ok(h.Memory > 0 && h.Memory === h.MemorySwap, `${n} memory`)
    assert.ok(h.PidsLimit > 0, `${n} pids`)
    assert.ok(h.SecurityOpt?.some((s) => s.startsWith('no-new-privileges')), `${n} no-new-privileges`)
    assert.ok(!h.Binds?.length, `${n} binds`)
    assert.ok(!Object.keys(h.PortBindings ?? {}).length, `${n} ports`)
    assert.equal(h.LogConfig.Type, 'syslog', `${n} log driver`)
    assert.equal(h.LogConfig.Config['syslog-address'], 'udp://127.0.0.1:5514')
  }
  const mounts = inspect('selfbase-control').Mounts
  assert.ok(!mounts.some((m) => /docker\.sock/.test(m.Source + m.Destination)), 'socket in control')
  assert.deepEqual(mounts.map((m) => [m.Destination, m.RW]).sort(), [['/backups', false], ...['control_db_password', 'control_jwt_secret',
    'master_key', 'provisioner_token'].map((s) => [`/run/secrets/${s}`, false])])
  // the secrets are files: nothing a socket proxy's inspect shows (Config.Env) holds one
  for (const n of CONTROL_STACK) {
    const env = inspect(n).Config.Env.map((e) => e.split('=')[0])
    for (const k of ['SELFBASE_MASTER_KEY', 'CONTROL_DB_PASSWORD', 'CONTROL_JWT_SECRET', 'PROVISIONER_TOKEN', 'POSTGRES_PASSWORD']) assert.ok(!env.includes(k), `${n}: ${k}`)
  }
  // only the two socket proxies mount the socket
  for (const n of [...CONTROL_STACK, 'selfbase-traefik']) {
    const sock = inspect(n).Mounts.some((m) => m.Source === '/var/run/docker.sock')
    assert.equal(sock, n === 'selfbase-socket-proxy', n)
  }
  // control cannot reach the Docker API: it is not on the socket proxy's network
  assert.match(resolveFrom('selfbase-control', 'selfbase-socket-proxy'), /ENOTFOUND|EAI_AGAIN/)
  // a project container reaches control:8080 without Traefik; its X-Forwarded-For is ignored, so a fresh spoofed
  // address per try does not escape the sign-in limit (5 per IP)
  const signIns = `const http=require('http'),out=[];let n=0
const go=()=>{const body=JSON.stringify({email:'nobody@e2e.test',password:'wrong-password-1'})
const r=http.request({host:'selfbase-control',port:8080,path:'/platform/login',method:'POST',headers:{host:'${CONTROL_HOST}',
'content-type':'application/json','content-length':Buffer.byteLength(body),origin:'${ORIGIN}','x-forwarded-for':'198.51.100.'+(++n)}},
(res)=>{res.resume();out.push(res.statusCode);if(n<7)go();else console.log(out.join(' '))});r.on('error',(e)=>console.log(e.code));r.end(body)}
go()`
  const limited = (tries) => {
    assert.equal(tries.length, 7, tries.join(' '))
    assert.ok(tries.slice(0, 5).every((s) => s !== '429') && tries.slice(5).every((s) => s === '429'), tries.join(' '))
  }
  limited(run('docker', ['exec', `sb-${P.a.ref}-core`, 'node', '-e', signIns]).split(' '))
  // nor from a container on the proxy network that answers to the proxy's name: trust is by exact container name
  // (the provisioner inspects selfbase-traefik), never DNS
  limited(run('docker', ['run', '--rm', '--name', IMPOSTOR, '--network', PROXY_NETWORK, '--network-alias', 'selfbase-traefik',
    '--entrypoint', 'node', inspect(`sb-${P.a.ref}-core`).Config.Image, '-e', signIns]).split(' '))
})

test('4: Studio against the real stack: table editor, SQL, logs', async () => {
  const { chromium } = await import('@playwright/test')
  const { expect } = await import('@playwright/test')
  await sql(P.a.ref, 'create table public.e2e_notes (id serial primary key, note text); grant select on public.e2e_notes to anon')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true, baseURL: ORIGIN, viewport: { width: 1440, height: 900 } })
    await page.goto('/')
    await page.getByLabel('Email').fill(OWNER.email)
    await page.getByLabel('Password', { exact: true }).fill(OWNER.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByLabel('Organization')).toBeVisible({ timeout: 15_000 })
    await page.goto(`/project/${P.a.ref}/editor`)
    await page.getByRole('complementary', { name: 'Tables' }).getByRole('button', { name: 'e2e_notes' }).click()
    await page.getByRole('button', { name: 'Add row' }).click()
    await page.getByRole('dialog', { name: 'Add row' }).getByLabel('note').fill('from studio')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('cell', { name: 'from studio' })).toBeVisible()

    await page.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name: 'SQL', exact: true }).click()
    await page.getByRole('textbox', { name: 'SQL query' }).click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('select 1 as one')
    await page.keyboard.press('Control+Enter')
    await expect(page.getByRole('columnheader', { name: 'one' })).toBeVisible()
    await expect(page.getByRole('cell', { name: '1', exact: true })).toBeVisible()

    await page.goto(`/project/${P.a.ref}/logs`)
    await expect(page.getByRole('list', { name: 'core log' }).getByRole('listitem').first()).toBeVisible({ timeout: 15_000 })
    // from VictoriaLogs over syslog, not the container fallback
    await expect(page.getByText(/The log store could not be reached/)).toHaveCount(0)
  } finally {
    await browser.close()
  }
  const rows = await sql(P.a.ref, 'select note from public.e2e_notes')
  assert.deepEqual(rows.rows, [['from studio']])
})

test('5: projects keep serving with the control stack stopped; a core restarts with logs down', async () => {
  log(`docker stats (idle):\n${docker('stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}', ...CONTROL_STACK, 'selfbase-traefik',
    'selfbase-traefik-socket-proxy', ...SERVICES.map((s) => `sb-${P.a.ref}-${s}`))}`)
  const jobsBefore = psql('select count(*) from control.jobs')
  const ids = () => Object.fromEntries([...containersOf(P.a.ref), ...containersOf(P.b.ref)].map((n) => [n, inspect(n).Id]))
  const idsBefore = ids()
  docker('stop', ...CONTROL_STACK)
  for (const p of [P.a, P.b]) {
    assert.equal((await https(p.host, '/health')).status, 200)
    const h = { apikey: p.anon, authorization: `Bearer ${p.anon}` }
    assert.equal((await https(p.host, '/rest/v1/', { headers: h })).status, 200)
    const signup = await https(p.host, '/auth/v1/signup', { method: 'POST', headers: { apikey: p.anon }, body: { email: `down-${p.ref}@e2e.test`, password: 'down-password-1' } })
    assert.equal(signup.status, 200, signup.text)
  }
  docker('restart', `sb-${P.a.ref}-core`)
  await waitFor('core healthy with logs stopped', () => inspect(`sb-${P.a.ref}-core`).State.Health?.Status === 'healthy', { timeout: 90_000 })
  assert.equal((await https(P.a.host, '/health')).status, 200)

  docker('start', ...CONTROL_STACK)
  await waitFor('control healthy', () => inspect('selfbase-control').State.Health?.Status === 'healthy', { timeout: 90_000 })
  await waitFor('control answers', async () => (await api('GET', '/capacity')).status === 200, { timeout: 30_000 })
  // reconcile runs at start and every 30 s: let one pass after the first go by
  await new Promise((r) => setTimeout(r, 35_000))
  assert.equal(psql('select count(*) from control.jobs'), jobsBefore, 'reconcile enqueued work')
  assert.equal(await status(P.a.ref), 'ACTIVE_HEALTHY')
  assert.equal(await status(P.b.ref), 'ACTIVE_HEALTHY')
  const after = ids()
  for (const [n, id] of Object.entries(idsBefore)) assert.equal(after[n], id, `${n} was recreated`)
})

test('6: both project routes return by themselves within 30 s of a proxy restart', async () => {
  docker('restart', 'selfbase-traefik')
  const t0 = Date.now()
  await waitFor('routes back', async () => (await health(P.a.host)).status === 200 && (await health(P.b.host)).status === 200,
    { timeout: 30_000, every: 500 })
  log(`routes back ${((Date.now() - t0) / 1000).toFixed(1)} s after the restart`)
})

test('7: a paused project answers 540, a restored one 200', async () => {
  const pause = await job((await ok('POST', `/projects/${P.b.ref}/pause`)).job_id)
  assert.equal(pause.status, 'succeeded', pause.error)
  const seen = []
  const paused = await waitFor('540', async () => {
    const r = await health(P.b.host).catch((e) => ({ status: e.message }))
    seen.push(r.status)
    return r.status === 540 && r
  }, { timeout: 30_000 }).catch((e) => { throw new Error(`${e.message}; answers: ${seen.join(' ')}`) })
  assert.deepEqual(paused.json, { message: 'project is not running' })
  const restore = await job((await ok('POST', `/projects/${P.b.ref}/restore`)).job_id)
  assert.equal(restore.status, 'succeeded', restore.error)
  await waitFor('200 again', async () => (await health(P.b.host)).status === 200, { timeout: 60_000 })
})

test('8: the new-host cap refuses a third project; deleting B frees its host and everything it had', async () => {
  const cap = await ok('GET', '/capacity')
  assert.equal(cap.new_hosts_this_week, 3)
  const refused = await create('over-cap')
  const j = await job(refused.jobId)
  assert.equal(j.status, 'failed')
  assert.match(j.error, /used its 3 new hostnames for this week/)
  const del = await ok('DELETE', `/projects/${refused.ref}`, { confirm_name: 'over-cap' })
  assert.equal((await job(del.job_id)).status, 'succeeded')

  const b = P.b
  const gone = await job((await ok('DELETE', `/projects/${b.ref}`, { confirm_name: 'b' })).job_id)
  assert.equal(gone.status, 'succeeded', gone.error)
  assert.deepEqual(containersOf(b.ref), [])
  assert.equal(docker('network', 'ls', '-q', '--filter', `name=^sb-${b.ref}$`), '')
  assert.equal(docker('volume', 'ls', '-q', '--filter', `name=^sb-${b.ref}-`), '')
  assert.equal(psql(`select coalesce(project_id::text, 'free') from control.host_slots where hostname = '${b.host}'`), 'free')
})

test('9: reconcile recreates a removed container; a create survives a control kill', async () => {
  docker('rm', '-f', `sb-${P.a.ref}-rest`)
  const t0 = Date.now()
  await waitFor('rest recreated', () => dockerOk('inspect', '--format', '{{.State.Running}}', `sb-${P.a.ref}-rest`) === 'true', { timeout: 60_000 })
  log(`rest recreated after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  await healthyProject(P.a.ref, 120_000)

  const c = await create('c')
  await waitFor('C containers being created', () => containersOf(c.ref).length > 0, { timeout: 60_000, every: 200 })
  docker('kill', 'selfbase-control')
  log(`killed control with ${containersOf(c.ref).length} of C's containers created`)
  await waitFor('control back', () => {
    if (!inspect('selfbase-control').State.Running) docker('start', 'selfbase-control')
    return inspect('selfbase-control').State.Health?.Status === 'healthy'
  }, { timeout: 90_000, every: 2000 })
  await finish(c, 'c')
  assert.deepEqual(containersOf(c.ref), SERVICES.map((s) => `sb-${c.ref}-${s}`).sort())
  assert.match(docker('network', 'ls', '-q', '--filter', `name=^sb-${c.ref}$`), /^\w+$/)
  assert.equal(P.c.host, P.b.host, 'C reuses the host B freed')
})

test('10: export A, import it as D on the freed host with A’s keys; a wrong passphrase leaves nothing', async () => {
  const exp = await job((await ok('POST', `/projects/${P.a.ref}/export`, { passphrase: PASSPHRASE })).job_id)
  assert.equal(exp.status, 'succeeded', exp.error)
  const dir = (await ok('GET', `/projects/${P.a.ref}/backups`)).find((x) => x.location?.startsWith(`export-${P.a.ref}/`))?.location
  assert.ok(dir, 'export location')
  await sql(P.a.ref, `update public.e2e_notes set note = 'changed after export'`)
  const del = await job((await ok('DELETE', `/projects/${P.c.ref}`, { confirm_name: 'c' })).job_id)
  assert.equal(del.status, 'succeeded', del.error)

  const importWith = async (passphrase) => {
    const form = new FormData()
    for (const [k, v] of Object.entries({ organization_slug: 'default', name: 'd', size: 'micro', backup_dir: dir, passphrase })) form.set(k, v)
    const r = new Response(form)
    return https(CONTROL_HOST, '/platform/projects/import', { method: 'POST', body: Buffer.from(await r.arrayBuffer()),
      headers: { authorization: `Bearer ${token}`, 'content-type': r.headers.get('content-type') } })
  }
  const count = () => psql(`select count(*) from control.projects where status <> 'REMOVED'`)
  const n = count()
  const wrong = await importWith('not the passphrase')
  assert.ok(wrong.status >= 400 && wrong.status < 500, `${wrong.status} ${wrong.text}`)
  assert.equal(count(), n, 'a project was left behind')

  const started = await importWith(PASSPHRASE)
  assert.equal(started.status, 202, started.text)
  const d = started.json.project.ref
  refs.add(d)
  const j = await job(started.json.job_id, 300_000)
  assert.equal(j.status, 'succeeded', j.error)
  await healthyProject(d)
  const host = (await ok('GET', `/projects/${d}/domains`)).find((x) => x.kind === 'default').hostname
  assert.equal(host, P.c.host, 'D takes the freed host')
  assert.equal((await ok('GET', '/capacity')).new_hosts_this_week, 3)
  const h = { apikey: P.a.anon, authorization: `Bearer ${P.a.anon}` }
  const rows = await https(host, '/rest/v1/e2e_notes?select=note', { headers: h })
  assert.equal(rows.status, 200, rows.text)
  assert.deepEqual(rows.json, [{ note: 'from studio' }])
  P.d = { ref: d, host, anon: P.a.anon }
})

test('11: teardown removes what the run made and nothing else', { skip: KEEP && 'E2E_KEEP=1' }, () => {
  teardown()
  assert.deepEqual(snapshot(), start)
})
