// Security review refusals (docs/reviews/wave1-provisioner-security.md). Threat: control is compromised and
// holds PROVISIONER_TOKEN. Pure: every refusal here happens before any Docker call, against the real
// template/compose.yml and template/sizes.json. The real-Docker refusals are in ops.test.ts and proxy.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { validateTemplate, TemplateError } from '../src/template.ts'
import { buildJob, buildProject, type EnsureInput, type JobInput, type Sizes } from '../src/spec.ts'
import { ProvisionError } from '../src/names.ts'
import { loadSettings, type NodeSettings } from '../src/settings.ts'
import * as ops from '../src/ops.ts'

const read = (p: string) => readFileSync(new URL(`../../template/${p}`, import.meta.url), 'utf8')
const raw = () => parse(read('compose.yml'))
const tpl = validateTemplate(raw())
const SIZES: Sizes = JSON.parse(read('sizes.json'))
const NODE: NodeSettings = {
  registry: 'ghcr.io/acme/selfbase', templateVersion: '2.1.0', proxyNetwork: 'coolify', entrypointHttp: 'http',
  entrypointHttps: 'https', certResolver: 'letsencrypt', logSyslogAddr: '', cgroupParent: '',
  backupHostDir: '/opt/selfbase/backups', subnetPool: '10.207.0.0/16', controlContainer: 'selfbase-control',
  controlNetwork: 'selfbase',
}
const ctx: ops.Ctx = { tpl, sizes: SIZES, node: NODE }
const REF = 'abcdefghijklmnopqrst'
const ENV = { POSTGRES_PASSWORD: 'pw', AUTHENTICATOR_PASSWORD: 'apw', JWT_SECRET: 'j', ANON_KEY: 'a', SERVICE_ROLE_KEY: 's',
  PUBLIC_URL: 'https://x', SITE_URL: 'https://y' }
const input = (over: Partial<EnsureInput> = {}): EnsureInput =>
  ({ ref: REF, templateVersion: '2.1.0', size: 'micro', subnet: '10.207.0.32/27', hosts: ['a.example.com'], env: ENV, ...over })
const job = (over: Partial<JobInput> = {}): JobInput => ({ ref: REF, type: 'backup', args: {}, env: {}, ...over })
const code = (c: string) => (e: unknown) => e instanceof ProvisionError && e.code === c
const envOf = (p: ReturnType<typeof buildProject>, service: string) =>
  p.containers.find((c) => c.service === service)!.body.Env as string[]
const withSize = (f: (s: any) => void) => {
  const s = structuredClone(SIZES) as any
  f(s)
  return s as Sizes
}

test("a host equal to another project's host is accepted: uniqueness is control's job (Task 11)", () => {
  const a = buildProject(input(), tpl, SIZES, NODE)
  const b = buildProject(input({ ref: 'bbbbbbbbbbbbbbbbbbbb', subnet: '10.207.0.64/27' }), tpl, SIZES, NODE)
  const rule = (p: typeof a, r: string) => (p.containers.find((c) => c.service === 'core')!.body.Labels as any)[`traefik.http.routers.sb-${r}.rule`]
  assert.equal(rule(a, REF), rule(b, 'bbbbbbbbbbbbbbbbbbbb'))
})

test('more than 10 hosts are refused', () => {
  const hosts = Array.from({ length: 11 }, (_, i) => `h${i}.example.com`)
  assert.throws(() => buildProject(input({ hosts }), tpl, SIZES, NODE), code('invalid_host'))
  assert.doesNotThrow(() => buildProject(input({ hosts: hosts.slice(1) }), tpl, SIZES, NODE))
})

test('env keys containing = or NUL, or not a plain name, are refused (project and job env)', () => {
  for (const k of ['A=B', 'A\0B', 'PATH=/x', '', '1A', 'A B']) {
    assert.throws(() => buildProject(input({ env: { ...ENV, [k]: 'v' } }), tpl, SIZES, NODE), code('invalid_env'), JSON.stringify(k))
    assert.throws(() => buildJob(job({ env: { [k]: 'v' } }), NODE), code('invalid_env'), JSON.stringify(k))
  }
})

test('an env value over 64 KiB or with a NUL is refused', () => {
  const big = 'x'.repeat(64 * 1024 + 1)
  assert.throws(() => buildProject(input({ env: { ...ENV, SMTP_PASS: big } }), tpl, SIZES, NODE), code('invalid_env'))
  assert.throws(() => buildJob(job({ env: { PGPASSWORD: big } }), NODE), code('invalid_env'))
  assert.throws(() => buildProject(input({ env: { ...ENV, SMTP_PASS: 'a\0b' } }), tpl, SIZES, NODE), code('invalid_env'))
  assert.doesNotThrow(() => buildProject(input({ env: { ...ENV, SMTP_PASS: 'x'.repeat(64 * 1024) } }), tpl, SIZES, NODE))
})

test('a templateVersion outside ^[0-9A-Za-z._-]{1,64}$ is refused', () => {
  for (const v of ['', 'a'.repeat(65), '1.0/../x', '1.0:x', '1 0', '1.0\n', 'é', undefined]) {
    assert.throws(() => buildProject(input({ templateVersion: v as string }), tpl, SIZES, NODE), code('invalid_template_version'), String(v))
  }
})

test('a service path segment not in the template is refused before Docker', async () => {
  for (const s of ['job-backup', 'nope', 'db-x', 'control']) {
    await assert.rejects(ops.serviceLogs(ctx, REF, s, null), code('invalid_service'), s)
    await assert.rejects(ops.serviceStats(ctx, REF, s), code('invalid_service'), s)
  }
})

test("ref 'control' is refused on every route except jobs of type backup", async () => {
  const refused: [string, () => Promise<unknown>][] = [
    ['state', () => ops.projectState(ctx, 'control')],
    ['ensure', () => ops.ensure(ctx, 'control', input())],
    ['start', () => ops.startStop(ctx, 'control', 'start', {})],
    ['stop', () => ops.startStop(ctx, 'control', 'stop', {})],
    ['delete', () => ops.remove(ctx, 'control', true)],
    ['attach-proxy', () => ops.attachProxy(ctx, 'control')],
    ['logs', () => ops.serviceLogs(ctx, 'control', 'db', null)],
    ['stats', () => ops.serviceStats(ctx, 'control', 'db')],
    ['restore job', () => ops.runJob(ctx, 'control', { type: 'restore', args: {}, env: {} })],
    ['restore job status', () => ops.jobStatus('control', 'restore')],
  ]
  for (const [name, run] of refused) await assert.rejects(run(), code('invalid_ref'), name)
  assert.throws(() => buildJob(job({ ref: 'control', type: 'restore' }), NODE), code('invalid_ref'))
  assert.equal(buildJob(job({ ref: 'control', args: { dir: 'control' } }), NODE).name, 'sb-control-job-backup')
})

test('provisioner-set variables cannot come from project env, even when a size omits them', () => {
  const sizes = withSize((s) => { delete s.micro.db.shared_buffers; delete s.micro.db.max_connections; delete s.micro.pooler.pool_size })
  const evil = { ...ENV, DB_SHARED_BUFFERS: '1MB -c ssl=off', DB_MAX_CONNECTIONS: '9999', POOL_SIZE: '9999', PROJECT_SUBNET: '0.0.0.0/0' }
  const p = buildProject(input({ env: evil }), tpl, sizes, NODE)
  const cmd = p.containers.find((c) => c.service === 'db')!.body.Cmd as string[]
  assert.ok(cmd.includes('shared_buffers=128MB') && cmd.includes('max_connections=60'), cmd.join(' '))
  assert.ok(envOf(p, 'pooler').includes('POOL_SIZE=15'))
  assert.ok(envOf(p, 'core').includes('PROJECT_SUBNET=10.207.0.32/27'))
})

test('core gets its own /27 as PROJECT_SUBNET', () => {
  assert.ok(envOf(buildProject(input(), tpl, SIZES, NODE), 'core').includes('PROJECT_SUBNET=10.207.0.32/27'))
})

test('a size entry that is null, fractional, too small or with bad derived values is refused', () => {
  const bad: [string, (s: any) => void][] = [
    ['null entry', (s) => { s.micro.rest = null }],
    ['fractional pids', (s) => { s.micro.db.pids = 1.5 }],
    ['fractional mem_mb', (s) => { s.micro.db.mem_mb = 511.5 }],
    ['fractional shm_mb', (s) => { s.micro.db.shm_mb = 1.5 }],
    ['cpus rounding to NanoCpus 0', (s) => { s.micro.db.cpus = 1e-10 }],
    ['cpus under 0.01', (s) => { s.micro.db.cpus = 0.001 }],
    ['shared_buffers with an option', (s) => { s.micro.db.shared_buffers = '128MB -c fsync=off' }],
    ['shared_buffers not a string', (s) => { s.micro.db.shared_buffers = 128 }],
    ['max_connections fractional', (s) => { s.micro.db.max_connections = 1.5 }],
    ['max_connections a string', (s) => { s.micro.db.max_connections = '60' }],
    ['pool_size zero', (s) => { s.micro.pooler.pool_size = 0 }],
  ]
  for (const [name, f] of bad) assert.throws(() => buildProject(input(), tpl, withSize(f), NODE), code('size_invalid'), name)
})

test('a missing render variable is a 400 ProvisionError, not a TemplateError', () => {
  const { JWT_SECRET: _, ...env } = ENV
  assert.throws(() => buildProject(input({ env }), tpl, SIZES, NODE), (e: unknown) =>
    e instanceof ProvisionError && e.status === 400 && e.code === 'invalid_env' && e.message.includes('JWT_SECRET'))
})

test('a template-side render error stays a TemplateError (500 template_invalid)', () => {
  const t = structuredClone(tpl)
  t.services.core.environment.BROKEN = 'a $PUBLIC_URL'
  assert.throws(() => buildProject(input(), t, SIZES, NODE), (e: unknown) => e instanceof TemplateError && !(e instanceof ProvisionError))
})

test('dropped provisioner-set env names are logged, names only', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  buildProject(input({ env: { ...ENV, REGISTRY: 'docker.io/evil-value', POOL_SIZE: '9999' } }), tpl, SIZES, NODE)
  assert.equal(warn.mock.callCount(), 1)
  const line = String(warn.mock.calls[0].arguments[0])
  assert.match(line, /REGISTRY/)
  assert.match(line, /POOL_SIZE/)
  assert.ok(!line.includes('evil-value') && !line.includes('9999'), line)
  buildProject(input(), tpl, SIZES, NODE)
  assert.equal(warn.mock.callCount(), 1)
})

test('a template service named job-* is refused', () => {
  for (const name of ['job-backup', 'job-x']) {
    const t = raw()
    t.services[name] = t.services.rest
    assert.throws(() => validateTemplate(t), (e: Error) => e instanceof TemplateError && e.message.includes(name), name)
  }
})

test('a template command or healthcheck that runs an interpreter with interpolation is refused', () => {
  const cases: [string, (s: any) => void][] = [
    ['sh -c', (s) => { s.command = ['sh', '-c', 'echo ${PUBLIC_URL}'] }],
    ['/bin/bash -c', (s) => { s.command = ['/bin/bash', '-c', 'x=${SITE_URL}'] }],
    ['node -e', (s) => { s.command = ['node', '-e', 'console.log("${SITE_URL}")'] }],
    ['CMD sh -c', (s) => { s.healthcheck.test = ['CMD', 'sh', '-c', 'test ${SITE_URL}'] }],
    ['CMD node -e', (s) => { s.healthcheck.test = ['CMD', 'node', '-e', '${SITE_URL}'] }],
    ['user', (s) => { s.user = '${RUN_AS:-1000}' }],
    // wrappers in front of the interpreter
    ['tini -- sh -c', (s) => { s.command = ['tini', '--', 'sh', '-c', 'echo ${SITE_URL}'] }],
    ['busybox sh -c', (s) => { s.command = ['busybox', 'sh', '-c', 'echo ${SITE_URL}'] }],
    ['busybox alone', (s) => { s.command = ['/bin/busybox', 'ash', '-c', 'echo ${SITE_URL}'] }],
    ['su-exec u bash -c', (s) => { s.command = ['su-exec', 'node', 'bash', '-c', 'echo ${SITE_URL}'] }],
    ['gosu u sh -c', (s) => { s.command = ['gosu', 'node', '/bin/sh', '-c', 'echo ${SITE_URL}'] }],
    ['xargs sh -c', (s) => { s.command = ['xargs', 'sh', '-c', 'echo ${SITE_URL}'] }],
    ['sh -ec', (s) => { s.command = ['sh', '-ec', 'echo ${SITE_URL}'] }],
    ['CMD dumb-init sh -c', (s) => { s.healthcheck.test = ['CMD', 'dumb-init', 'sh', '-c', 'test ${SITE_URL}'] }],
  ]
  for (const [name, f] of cases) {
    const t = raw()
    f(t.services.core)
    assert.throws(() => validateTemplate(t), TemplateError, name)
  }
  // args of a non-interpreter stay allowed (db's postgres -c shared_buffers=${DB_SHARED_BUFFERS})
  assert.doesNotThrow(() => validateTemplate(raw()))
})

test('node settings that would reach HostConfig unchecked stop startup', () => {
  const base = { REGISTRY: 'ghcr.io/acme/selfbase', TEMPLATE_VERSION: '2.1.0' }
  const bad: Record<string, string>[] = [
    { CONTROL_NETWORK: 'host' }, { CONTROL_NETWORK: 'none' }, { CONTROL_NETWORK: 'container:selfbase-control' },
    { CONTROL_NETWORK: 'bridge' }, { PROXY_NETWORK: 'host' }, { CONTROL_CONTAINER: 'a b' },
    { BACKUP_HOST_DIR: '/var/run' }, { BACKUP_HOST_DIR: '/' }, { BACKUP_HOST_DIR: '/opt/selfbase' },
    { BACKUP_HOST_DIR: '/opt/selfbase/../../var/run' }, { BACKUP_HOST_DIR: '/opt/selfbasex/b' },
    { CGROUP_PARENT: '../../x' }, { CGROUP_PARENT: '/' }, { LOG_SYSLOG_ADDR: 'udp://x y' }, { LOG_SYSLOG_ADDR: 'file:///etc/x' }, { LOG_SYSLOG_ADDR: 'tcp://127.0.0.1:5514' },
    { PROXY_ENTRYPOINT_HTTPS: 'a,b' }, { PROXY_CERTRESOLVER: 'le`' },
  ]
  for (const b of bad) assert.throws(() => loadSettings({ ...base, ...b }), /settings:/, JSON.stringify(b))
  const ok = loadSettings({ ...base, BACKUP_HOST_DIR: '/opt/selfbase/backups', CGROUP_PARENT: 'selfbase.slice', LOG_SYSLOG_ADDR: 'udp://127.0.0.1:5514' })
  assert.equal(ok.backupHostDir, '/opt/selfbase/backups')
})
