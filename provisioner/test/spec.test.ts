import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { validateTemplate } from '../src/template.ts'
import { buildJob, buildProject, type EnsureInput, type JobInput, type Sizes } from '../src/spec.ts'
import { ProvisionError } from '../src/names.ts'
import type { NodeSettings } from '../src/settings.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/template.yml', import.meta.url))
const tpl = validateTemplate(parse(readFileSync(fixturePath, 'utf8')))

// Global Constraints sizes (MiB); Task 5's template/sizes.json carries the same values.
const row = (db: number, rest: number, core: number, fn: number, cpu: number, shm: number, sb: string, mc: number, pool: number) => ({
  db: { mem_mb: db, cpus: cpu, pids: 512, shm_mb: shm, shared_buffers: sb, max_connections: mc },
  rest: { mem_mb: rest, cpus: cpu / 2, pids: 512 },
  core: { mem_mb: core, cpus: cpu / 2, pids: 512 },
  fn: { mem_mb: fn, cpus: cpu / 2, pids: 512 },
  pooler: { mem_mb: 32, cpus: 0.25, pids: 64, pool_size: pool },
})
const SIZES: Sizes = {
  micro: row(512, 128, 256, 256, 1, 128, '128MB', 60, 15),
  small: row(1024, 256, 512, 512, 2, 256, '256MB', 100, 20),
  medium: row(2048, 256, 512, 1024, 2, 512, '512MB', 150, 30),
}

const NODE: NodeSettings = {
  registry: 'ghcr.io/acme/selfbase', templateVersion: '2.1.0', proxyNetwork: 'coolify', entrypointHttp: 'http',
  entrypointHttps: 'https', certResolver: 'letsencrypt', logSyslogAddr: 'udp://127.0.0.1:5514', cgroupParent: '',
  backupHostDir: '/opt/selfbase/backups', subnetPool: '10.207.0.0/16', controlContainer: 'selfbase-control',
  controlNetwork: 'selfbase',
}
const REF = 'abcdefghijklmnopqrst'
const ENV = {
  POSTGRES_PASSWORD: 'pw', AUTHENTICATOR_PASSWORD: 'apw', JWT_SECRET: 'j', ADMIN_TOKEN: 't', ANON_KEY: 'a',
  SERVICE_ROLE_KEY: 's', PUBLIC_URL: 'https://x', SITE_URL: 'https://y',
}
const input = (over: Partial<EnsureInput> = {}): EnsureInput => ({
  ref: REF, templateVersion: '2.1.0', size: 'micro', subnet: '10.207.0.32/27', hosts: [`${REF}.example.com`], env: ENV, ...over,
})
const MiB = 1024 * 1024
const code = (c: string) => (e: unknown) => e instanceof ProvisionError && e.code === c

test('per-service memory equals sizes for every size, swap equal', () => {
  for (const size of ['micro', 'small', 'medium'] as const) {
    const { containers } = buildProject(input({ size }), tpl, SIZES, NODE)
    assert.equal(containers.length, 5)
    for (const c of containers) {
      const hc = c.body.HostConfig as any
      assert.equal(hc.Memory, SIZES[size][c.service].mem_mb * MiB, `${size} ${c.service}`)
      assert.equal(hc.MemorySwap, hc.Memory)
      assert.ok(hc.NanoCpus > 0 && hc.PidsLimit > 0)
      assert.deepEqual(hc.SecurityOpt, ['no-new-privileges:true'])
      assert.deepEqual(hc.RestartPolicy, { Name: 'unless-stopped' })
      assert.ok(hc.Mounts.every((m: any) => m.Type === 'volume' && m.Source.startsWith(`sb-${REF}-`)))
      assert.equal(hc.LogConfig.Type, 'syslog')
      assert.equal(hc.LogConfig.Config.tag, `sb-${REF}-${c.service}`)
      assert.equal(c.name, `sb-${REF}-${c.service}`)
      assert.equal((c.body.Labels as any)['selfbase.spec'], c.specHash)
    }
  }
})

test('containers come in depends_on order with rendered values', () => {
  const { containers, network, volumes } = buildProject(input({ size: 'small' }), tpl, SIZES, NODE)
  const order = containers.map((c) => c.service)
  assert.ok(order.indexOf('db') < order.indexOf('rest') && order.indexOf('rest') < order.indexOf('core'))
  const db = containers.find((c) => c.service === 'db')!
  assert.equal(db.body.Image, 'ghcr.io/acme/selfbase/selfbase-db:2.1.0')
  assert.ok((db.body.Cmd as string[]).includes('shared_buffers=256MB'))
  assert.ok((db.body.Env as string[]).includes('POSTGRES_PASSWORD=pw'))
  assert.equal((db.body.HostConfig as any).ShmSize, 256 * MiB)
  assert.equal((db.body.Healthcheck as any).Interval, 5e9)
  assert.equal(db.body.StopTimeout, 60)
  assert.equal((containers.find((c) => c.service === 'core')!.body.HostConfig as any).Init, true)
  assert.ok((containers.find((c) => c.service === 'pooler')!.body.Env as string[]).includes('POOL_SIZE=20'))
  assert.deepEqual((db.body.NetworkingConfig as any).EndpointsConfig, { [`sb-${REF}`]: { Aliases: ['db'] } })
  assert.equal(network.name, `sb-${REF}`)
  assert.deepEqual((network.body as any).IPAM.Config, [{ Subnet: '10.207.0.32/27' }])
  assert.equal((network.body as any).Labels['selfbase.project'], REF)
  assert.deepEqual(volumes, ['pgdata', 'storage', 'functions', 'denocache'].map((v) => `sb-${REF}-${v}`))
})

test('json-file logs when no syslog address', () => {
  const { containers } = buildProject(input(), tpl, SIZES, { ...NODE, logSyslogAddr: '', cgroupParent: 'selfbase.slice' })
  const hc = containers[0].body.HostConfig as any
  assert.deepEqual(hc.LogConfig, { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } })
  assert.equal(hc.CgroupParent, 'selfbase.slice')
})

const FORBIDDEN = ['Privileged', 'CapAdd', 'Binds', 'PidMode', 'IpcMode', 'UsernsMode', 'Devices', 'PortBindings']
function scan(v: unknown, path: string) {
  if (Array.isArray(v)) return v.forEach((x, i) => scan(x, `${path}[${i}]`))
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      assert.ok(!FORBIDDEN.includes(k), `${path}.${k}`)
      assert.ok(!(k === 'NetworkMode' && x === 'host'), `${path}.${k}`)
      scan(x, `${path}.${k}`)
    }
  }
}

test('no body contains a forbidden key (deep scan)', () => {
  for (const size of ['micro', 'small', 'medium'] as const) {
    const p = buildProject(input({ size }), tpl, SIZES, NODE)
    scan(JSON.parse(JSON.stringify(p)), size)
  }
})

test('only core is on the proxy network and carries traefik labels, all named sb-<ref>', () => {
  const { containers } = buildProject(input({ hosts: [`${REF}.example.com`, 'api.custom.org'] }), tpl, SIZES, NODE)
  for (const c of containers) {
    const traefik = Object.entries(c.body.Labels as Record<string, string>).filter(([k]) => k.startsWith('traefik.'))
    if (c.service !== 'core') {
      assert.deepEqual(c.networks, [`sb-${REF}`])
      assert.equal(traefik.length, 0)
      continue
    }
    assert.deepEqual(c.networks, [`sb-${REF}`, 'coolify'])
    const l = Object.fromEntries(traefik)
    for (const [k] of traefik) {
      const name = /^traefik\.http\.(?:routers|services|middlewares)\.([^.]+)\./.exec(k)?.[1]
      if (name !== undefined) assert.ok(name === `sb-${REF}` || name.startsWith(`sb-${REF}-`), k)
      else assert.ok(['traefik.enable', 'traefik.docker.network'].includes(k), k)
    }
    assert.equal(l[`traefik.http.routers.sb-${REF}.rule`], `Host(\`${REF}.example.com\`) || Host(\`api.custom.org\`)`)
    assert.equal(l[`traefik.http.routers.sb-${REF}.entrypoints`], 'https')
    assert.equal(l[`traefik.http.routers.sb-${REF}.tls`], 'true')
    assert.equal(l[`traefik.http.routers.sb-${REF}.tls.certresolver`], 'letsencrypt')
    assert.equal(l[`traefik.http.services.sb-${REF}.loadbalancer.server.port`], '8080')
    assert.equal(l[`traefik.http.routers.sb-${REF}-http.middlewares`], `sb-${REF}-redirect`)
    assert.equal(l[`traefik.http.routers.sb-${REF}-http.entrypoints`], 'http')
    assert.equal(l[`traefik.http.middlewares.sb-${REF}-redirect.redirectscheme.scheme`], 'https')
  }
  const noResolver = buildProject(input(), tpl, SIZES, { ...NODE, certResolver: '' }).containers.find((c) => c.service === 'core')!
  assert.ok(!Object.keys(noResolver.body.Labels as object).some((k) => k.endsWith('certresolver')))
})

test('hostile refs are refused before anything is built (Review Focus 1)', () => {
  for (const ref of ['../x', 'SB', 'sb-other', 'a'.repeat(19), 'a'.repeat(21), '', undefined, 'abcdefghijklmnopqrs/', 'ABCDEFGHIJKLMNOPQRST']) {
    assert.throws(() => buildProject(input({ ref: ref as string }), tpl, SIZES, NODE), code('invalid_ref'), String(ref))
    assert.throws(() => buildJob({ ref: ref as string, type: 'backup', args: {}, env: {} }, NODE), code('invalid_ref'), String(ref))
  }
})

test('hostile hosts are refused', () => {
  for (const hosts of [['a`) || Host(`evil'], ['nodot'], ['UPPER.example.com'], ['-a.example.com'], [], ['a.example.com/x']]) {
    assert.throws(() => buildProject(input({ hosts }), tpl, SIZES, NODE), code('invalid_host'), JSON.stringify(hosts))
  }
})

test('subnet must be a /27 inside the pool', () => {
  for (const subnet of ['10.208.0.0/27', '10.207.1.0/24', '10.207.0.16/27', '10.207.0.0', '10.207.0.256/27', '010.207.0.0/27']) {
    assert.throws(() => buildProject(input({ subnet }), tpl, SIZES, NODE), code('invalid_subnet'), subnet)
  }
})

test('size and template version are checked', () => {
  assert.throws(() => buildProject(input({ size: 'huge' as 'micro' }), tpl, SIZES, NODE), code('invalid_size'))
  assert.throws(() => buildProject(input({ size: '__proto__' as 'micro' }), tpl, SIZES, NODE), code('invalid_size'))
  assert.throws(() => buildProject(input({ templateVersion: '1.0/../x' }), tpl, SIZES, NODE), code('invalid_template_version'))
})

test('an image rendered to another registry is refused', () => {
  const t = structuredClone(tpl)
  t.services.rest.image = 'docker.io/evil/selfbase-rest:${TEMPLATE_VERSION}'
  assert.throws(() => buildProject(input(), t, SIZES, NODE), code('image_refused'))
  // REGISTRY in the project env cannot redirect the image: the node's registry always wins
  const p = buildProject(input({ env: { ...ENV, REGISTRY: 'docker.io/evil' } }), tpl, SIZES, NODE)
  assert.ok(p.containers.every((c) => (c.body.Image as string).startsWith('ghcr.io/acme/selfbase/')))
})

test('a service with no entry in sizes is refused', () => {
  const sizes = structuredClone(SIZES) as any
  delete sizes.micro.pooler
  assert.throws(() => buildProject(input(), tpl, sizes, NODE), code('size_missing'))
})

test('a size entry with a missing, zero, negative or non-numeric limit is refused', () => {
  for (const field of ['mem_mb', 'cpus', 'pids', 'shm_mb']) {
    for (const bad of [undefined, NaN, 0, -1, '512', Infinity]) {
      const sizes = structuredClone(SIZES) as any
      if (bad === undefined) delete sizes.micro.db[field]
      else sizes.micro.db[field] = bad
      if (field === 'shm_mb' && bad === undefined) continue // shm_mb is optional
      assert.throws(() => buildProject(input(), tpl, sizes, NODE), code('size_invalid'), `${field}=${String(bad)}`)
    }
  }
})

test('specHash is stable and follows the body', () => {
  const a = buildProject(input(), tpl, SIZES, NODE).containers
  const b = buildProject(input(), tpl, SIZES, NODE).containers
  assert.deepEqual(a.map((c) => c.specHash), b.map((c) => c.specHash))
  const c = buildProject(input({ env: { ...ENV, ANON_KEY: 'other' } }), tpl, SIZES, NODE).containers
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].specHash === c[i].specHash, a[i].service !== 'fn', a[i].service)
  }
})

const job = (over: Partial<JobInput> = {}): JobInput => ({
  ref: REF, type: 'backup', args: { dir: 'daily/2026-11-22' }, env: { PGHOST: 'db', PGPASSWORD: 'pw' }, ...over,
})

test('backup job: one bind, the backup host dir; storage volume; fixed command', () => {
  const spec = buildJob(job(), NODE)
  assert.equal(spec.name, `sb-${REF}-job-backup`)
  const hc = spec.body.HostConfig as any
  const binds = hc.Mounts.filter((m: any) => m.Type === 'bind')
  assert.deepEqual(binds, [{ Type: 'bind', Source: '/opt/selfbase/backups', Target: '/backups' }])
  assert.deepEqual(hc.Mounts.filter((m: any) => m.Type === 'volume'),
    [{ Type: 'volume', Source: `sb-${REF}-storage`, Target: '/data/storage', ReadOnly: true }])
  assert.deepEqual(spec.body.Cmd, ['bash', '/scripts/backup.sh'])
  assert.equal(spec.body.Image, 'ghcr.io/acme/selfbase/selfbase-job:2.1.0')
  assert.deepEqual(hc.RestartPolicy, { Name: 'no' })
  assert.equal(hc.Memory, 512 * MiB)
  assert.equal(hc.MemorySwap, hc.Memory)
  assert.ok((spec.body.Env as string[]).includes('BACKUP_SUBDIR=daily/2026-11-22'))
  assert.deepEqual(spec.networks, [`sb-${REF}`])
  scan(spec, 'job')
  assert.deepEqual(buildJob(job({ type: 'restore' }), NODE).body.Cmd, ['bash', '/scripts/restore.sh'])
})

test('control job: control network, no volume', () => {
  const spec = buildJob(job({ ref: 'control' }), NODE)
  assert.equal(spec.name, 'sb-control-job-backup')
  assert.deepEqual(spec.networks, ['selfbase'])
  assert.deepEqual((spec.body.HostConfig as any).Mounts.map((m: any) => m.Type), ['bind'])
})

test('job refusals', () => {
  assert.throws(() => buildJob(job({ env: { LD_PRELOAD: '/x.so' } }), NODE), code('invalid_env'))
  assert.throws(() => buildJob(job({ env: { RESTORE_DIR: '../etc' } }), NODE), code('invalid_dir'))
  for (const dir of ['../etc', 'a/b/c', '.', 'a/..', '/abs', '', 'a b']) {
    assert.throws(() => buildJob(job({ args: { dir } }), NODE), code('invalid_dir'), dir)
  }
  assert.throws(() => buildJob(job({ args: { dir: 'x', cmd: 'sh' } as any }), NODE), code('invalid_args'))
  assert.throws(() => buildJob(job(), { ...NODE, backupHostDir: '' }), code('backup_dir_unset'))
  assert.throws(() => buildJob(job({ type: 'shell' as 'backup' }), NODE), code('invalid_job_type'))
  for (const type of ['clone', 'basebackup', 'volume-copy', 'migra-diff'] as const) {
    assert.throws(() => buildJob(job({ type }), NODE), (e: unknown) => e instanceof ProvisionError && e.status === 501 && e.code === 'not_implemented')
  }
})

test('template.ts --check validates and renders every size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-check-'))
  copyFileSync(fixturePath, join(dir, 'compose.yml'))
  writeFileSync(join(dir, 'sizes.json'), JSON.stringify(SIZES))
  const cli = fileURLToPath(new URL('../src/template.ts', import.meta.url))
  const out = execFileSync(process.execPath, [cli, '--check', join(dir, 'compose.yml')], { encoding: 'utf8' })
  assert.match(out, /micro, small, medium/)
  writeFileSync(join(dir, 'compose.yml'), readFileSync(fixturePath, 'utf8').replace('init: true', 'init: true\n    privileged: true'))
  assert.throws(() => execFileSync(process.execPath, [cli, '--check', join(dir, 'compose.yml')], { stdio: 'pipe' }))
  copyFileSync(fixturePath, join(dir, 'compose.yml'))
  writeFileSync(join(dir, 'sizes.json'), JSON.stringify({ ...SIZES, medium: { ...SIZES.medium, core: { mem_mb: 0, cpus: 1, pids: 512 } } }))
  assert.throws(() => execFileSync(process.execPath, [cli, '--check', join(dir, 'compose.yml')], { stdio: 'pipe' }), /size_invalid|medium\.core/)
})
