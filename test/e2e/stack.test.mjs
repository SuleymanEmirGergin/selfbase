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
import { BACKUP_HOST_DIR, CONTROL_HOST, ORIGIN, PROXY_NETWORK, compose, connectFrom, docker, dockerOk, envFile, https, inspect,
  resolveFrom, root, run, snapshot, waitFor } from './helpers.mjs'

process.chdir(root)
const KEEP = process.env.E2E_KEEP === '1'
const SERVICES = ['db', 'rest', 'core', 'fn', 'pooler']
const CONTROL_STACK = ['selfbase-control', 'selfbase-control-db', 'selfbase-provisioner', 'selfbase-socket-proxy', 'selfbase-logs']
const OWNER = { email: 'owner@e2e.test', password: `e2e-${randomBytes(12).toString('base64url')}` }
const PASSPHRASE = `e2e export ${randomBytes(6).toString('hex')}`

let envPath, envDir, start, token
let tornDown = false
const P = {} // name -> { ref, host, anon }

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
  const before = new Set([...start.containers, ...start.networks, ...start.volumes])
  const ours = (list) => list.filter((n) => /^sb-/.test(n) && !before.has(n))
  const now = snapshot()
  // projects first (control is attached to their networks), then the stack, then what the run made by hand
  const cs = ours(now.containers)
  if (cs.length) dockerOk('rm', '-f', ...cs)
  try { compose(envPath, 'down', '-v', '--remove-orphans', '--timeout', '5') } catch (e) { log(`compose down: ${e.message}`) }
  for (const n of ours(now.networks)) dockerOk('network', 'rm', n)
  for (const v of ours(now.volumes)) dockerOk('volume', 'rm', '-f', v)
  // the host backup directory (Docker created it on first bind)
  // (an image without VOLUME: the job image's would leave an anonymous volume)
  dockerOk('run', '--rm', '--user', '0', '-v', '/opt/selfbase:/o', 'selfbase.local/selfbase-control:e2e', 'rm', '-rf', `/o/${BACKUP_HOST_DIR.split('/').pop()}`)
  rmSync(envDir, { recursive: true, force: true })
}

before(async () => {
  start = snapshot()
  for (const n of [...CONTROL_STACK, 'selfbase-traefik']) assert.ok(!start.containers.includes(n), `${n} exists already: another selfbase stack runs here`)
  for (const n of ['selfbase', PROXY_NETWORK]) assert.ok(!start.networks.includes(n), `network ${n} exists already`)
  envDir = mkdtempSync(join(tmpdir(), 'sb-e2e-'))
  envPath = join(envDir, '.env')
  writeFileSync(envPath, Object.entries(envFile()).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  chmodSync(envPath, 0o600)
  assert.equal(run(process.execPath, ['scripts/install-check.mjs', envPath]), 'install-check: ok')
  docker('network', 'create', PROXY_NETWORK)
  let t = Date.now()
  compose(envPath, '--profile', 'images', 'build')
  log(`images built in ${((Date.now() - t) / 1000).toFixed(0)} s`)
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
  assert.deepEqual(mounts.map((m) => [m.Destination, m.RW]), [['/backups', false]])
  // only the two socket proxies mount the socket
  for (const n of [...CONTROL_STACK, 'selfbase-traefik']) {
    const sock = inspect(n).Mounts.some((m) => m.Source === '/var/run/docker.sock')
    assert.equal(sock, n === 'selfbase-socket-proxy', n)
  }
  // control cannot reach the Docker API: it is not on the socket proxy's network
  assert.match(resolveFrom('selfbase-control', 'selfbase-socket-proxy'), /ENOTFOUND|EAI_AGAIN/)
})

test('4: Studio against the real stack: table editor, SQL, logs', async () => {
  const { chromium } = await import('@playwright/test')
  const { expect } = await import('@playwright/test')
  await sql(P.a.ref, 'create table public.e2e_notes (id serial primary key, note text); grant select on public.e2e_notes to anon')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true, baseURL: ORIGIN, viewport: { width: 1440, height: 900 } })
    await page.goto('/')
    await page.getByLabel('E-posta').fill(OWNER.email)
    await page.getByLabel('Parola').fill(OWNER.password)
    await page.getByRole('button', { name: 'Giriş yap' }).click()
    await expect(page.getByLabel('Organizasyon')).toBeVisible({ timeout: 15_000 })
    await page.goto(`/project/${P.a.ref}/editor`)
    await page.getByRole('complementary', { name: 'Tablolar' }).getByRole('button', { name: 'e2e_notes' }).click()
    await page.getByRole('button', { name: 'Satır ekle' }).click()
    await page.getByRole('dialog', { name: 'Satır ekle' }).getByLabel('note').fill('from studio')
    await page.getByRole('button', { name: 'Kaydet' }).click()
    await expect(page.getByRole('cell', { name: 'from studio' })).toBeVisible()

    await page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'SQL', exact: true }).click()
    await page.getByRole('textbox', { name: 'SQL sorgusu' }).click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('select 1 as one')
    await page.keyboard.press('Control+Enter')
    await expect(page.getByRole('columnheader', { name: 'one' })).toBeVisible()
    await expect(page.getByRole('cell', { name: '1', exact: true })).toBeVisible()

    await page.goto(`/project/${P.a.ref}/logs`)
    await expect(page.getByRole('list', { name: 'core günlüğü' }).getByRole('listitem').first()).toBeVisible({ timeout: 15_000 })
    // from VictoriaLogs over syslog, not the container fallback
    await expect(page.getByText(/Günlük deposuna ulaşılamadı/)).toHaveCount(0)
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
