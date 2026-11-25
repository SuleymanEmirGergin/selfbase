import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { validateTemplate } from '../src/template.ts'
import { buildJob, buildProject, dryRunEnv, type EnsureInput, type JobInput, type Sizes } from '../src/spec.ts'
import { ProvisionError } from '../src/names.ts'
import { proxyForCore } from '../src/ops.ts'
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
      assert.deepEqual(hc.CapDrop, c.service === 'db' ? ['NET_RAW'] : ['ALL'], c.service)
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
  const { containers, networks: [network], volumes } = buildProject(input({ size: 'small' }), tpl, SIZES, NODE)
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
  assert.deepEqual((db.body.NetworkingConfig as any).EndpointsConfig,
    { [`sb-${REF}`]: { Aliases: ['db'], IPAMConfig: { IPv4Address: '10.207.0.34' } } })
  assert.equal(network.name, `sb-${REF}`)
  assert.deepEqual((network.body as any).IPAM.Config, [{ Subnet: '10.207.0.32/28', IPRange: '10.207.0.40/29', Gateway: '10.207.0.33' }])
  assert.equal((network.body as any).Labels['selfbase.project'], REF)
  assert.deepEqual(volumes, ['pgdata', 'storage', 'functions', 'denocache'].map((v) => `sb-${REF}-${v}`))
})

test('R1: every service has a fixed address in the /27, and siblings are reached by address, never by a DNS name', () => {
  const { containers } = buildProject(input(), tpl, SIZES, NODE)
  // declaration order from base+2; dynamic addresses (jobs) come from base+8/29 only
  const want: Record<string, string> = { db: '10.207.0.34', rest: '10.207.0.35', core: '10.207.0.36', fn: '10.207.0.37', pooler: '10.207.0.38' }
  const hosts = Object.entries(want).map(([s, a]) => `${s}:${a}`)
  for (const c of containers) {
    assert.equal((c.body.NetworkingConfig as any).EndpointsConfig[`sb-${REF}`].IPAMConfig.IPv4Address, want[c.service])
    // bare names in the template (rest's @db, fn's http://core) go to /etc/hosts, ahead of Docker's DNS
    assert.deepEqual((c.body.HostConfig as any).ExtraHosts, hosts, c.service)
  }
  const env = containers.find((c) => c.service === 'core')!.body.Env as string[]
  // core is on the proxy network too, where any container can carry the alias db.sb-<ref> (reproduced on Docker 29.8)
  assert.ok(!env.some((e) => /\.sb-/.test(e)), env.join(' '))
  const tplCore = tpl.services.core.environment
  assert.equal(tplCore.DB_HOST, 'db') // the fixture hardcodes it; the real template reads ${DB_HOST}
  const real = validateTemplate(parse(readFileSync(fileURLToPath(new URL('../../template/compose.yml', import.meta.url)), 'utf8')))
  const sizes = JSON.parse(readFileSync(fileURLToPath(new URL('../../template/sizes.json', import.meta.url)), 'utf8'))
  const coreEnv = buildProject(input({ env: dryRunEnv(real) }), real, sizes, NODE).containers.find((c) => c.service === 'core')!.body.Env as string[]
  for (const e of ['DB_HOST=10.207.0.34', 'PGRST_URL=http://10.207.0.35:3000', 'FN_URL=http://10.207.0.37:8000']) assert.ok(coreEnv.includes(e), e)
  // a project env value cannot steer them
  const steered = buildProject(input({ env: { ...dryRunEnv(real), DB_HOST: 'evil', PGRST_URL: 'http://evil' } }), real, sizes, NODE)
  assert.ok((steered.containers.find((c) => c.service === 'core')!.body.Env as string[]).includes('DB_HOST=10.207.0.34'))
  // more services than base+2..base+7 holds
  const big = structuredClone(tpl)
  for (let i = 0; i < 10; i++) big.services[`x${i}`] = structuredClone(tpl.services.pooler)
  assert.throws(() => buildProject(input(), big, SIZES, NODE), code('template_invalid'))
})

test('R6: core and control alone on sb-<ref>-ctl, whose /29 is all the admin port answers; fn alone on an egress network; the tenant network isolated where the engine can', () => {
  const real = validateTemplate(parse(readFileSync(fileURLToPath(new URL('../../template/compose.yml', import.meta.url)), 'utf8')))
  const sizes = JSON.parse(readFileSync(fileURLToPath(new URL('../../template/sizes.json', import.meta.url)), 'utf8'))
  const iso = buildProject(input({ env: dryRunEnv(real) }), real, sizes, NODE, [], true)
  const n = Object.fromEntries(iso.networks.map((x) => [x.name, x.body as any]))
  // the project's /27 in three: tenant /28 (jobs from base+8/29), control /29, egress /29
  assert.deepEqual(Object.keys(n), [`sb-${REF}`, `sb-${REF}-ctl`, `sb-${REF}-egress`])
  assert.deepEqual(n[`sb-${REF}`].IPAM.Config, [{ Subnet: '10.207.0.32/28', IPRange: '10.207.0.40/29', Gateway: '10.207.0.33' }])
  assert.deepEqual(n[`sb-${REF}-ctl`].IPAM.Config, [{ Subnet: '10.207.0.48/29', IPRange: '10.207.0.52/30', Gateway: '10.207.0.49' }])
  assert.deepEqual(n[`sb-${REF}-egress`].IPAM.Config, [{ Subnet: '10.207.0.56/29', Gateway: '10.207.0.57' }])
  for (const x of Object.values(n)) assert.equal(x.Labels['selfbase.project'], REF)
  // M-2: IPv6 off on every project network, whatever the daemon's default network options say (with or without isolation)
  for (const x of [...iso.networks, ...buildProject(input({ env: dryRunEnv(real) }), real, sizes, NODE).networks]) {
    assert.equal((x.body as any).EnableIPv6, false, x.name)
  }
  // no route out and no host gateway for db, rest, pooler (and core's admin side); fn keeps egress on its own network
  const isolated = { Internal: true, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' } }
  for (const k of [`sb-${REF}`, `sb-${REF}-ctl`]) assert.deepEqual({ Internal: n[k].Internal, Options: n[k].Options }, isolated, k)
  assert.ok(!('Internal' in n[`sb-${REF}-egress`]) && !('Options' in n[`sb-${REF}-egress`]))
  // an engine without the gateway mode: the same split, no isolation flags
  for (const x of buildProject(input({ env: dryRunEnv(real) }), real, sizes, NODE).networks) {
    assert.ok(!('Internal' in x.body) && !('Options' in x.body), x.name)
  }
  const ep = (s: string) => (iso.containers.find((c) => c.service === s)!.body.NetworkingConfig as any).EndpointsConfig
  assert.deepEqual(ep('core')[`sb-${REF}-ctl`], { Aliases: ['core'], IPAMConfig: { IPv4Address: '10.207.0.50' } })
  assert.deepEqual(Object.keys(ep('core')), [`sb-${REF}`, `sb-${REF}-ctl`])
  assert.deepEqual(ep('fn')[`sb-${REF}-egress`], { Aliases: ['fn'], IPAMConfig: { IPv4Address: '10.207.0.58' } })
  assert.deepEqual(Object.keys(ep('fn')), [`sb-${REF}`, `sb-${REF}-egress`])
  for (const s of ['db', 'rest', 'pooler']) assert.deepEqual(Object.keys(ep(s)), [`sb-${REF}`], s)
  // core's admin port answers PROJECT_SUBNET's peers only: the control /29, never the tenant /28 where fn runs
  const coreEnv = iso.containers.find((c) => c.service === 'core')!.body.Env as string[]
  assert.ok(coreEnv.includes('PROJECT_SUBNET=10.207.0.48/29'), coreEnv.join(' '))
})

test('backup and restore jobs get the node floor BACKUP_MIN_FREE_MIB; a request can never set it', () => {
  const backup = (node: NodeSettings, env: Record<string, string> = {}) =>
    buildJob({ ref: REF, type: 'backup', args: { dir: REF }, env: { PGHOST: 'db', PGPASSWORD: 'x', ...env } }, node).body.Env as string[]
  assert.ok(!backup(NODE).some((e) => e.startsWith('BACKUP_MIN_FREE_MIB=')))
  assert.ok(backup({ ...NODE, backupMinFreeMib: '100' }).includes('BACKUP_MIN_FREE_MIB=100'))
  assert.throws(() => backup(NODE, { BACKUP_MIN_FREE_MIB: '1' }), code('invalid_env'))
  const restore = buildJob({ ref: REF, type: 'restore', args: { dir: `${REF}/20260101-000000` }, env: { PGHOST: 'db', PGPASSWORD: 'x' } },
    { ...NODE, backupMinFreeMib: '100' }).body.Env as string[]
  // E: a restore keeps the same floor free on the volume it writes the project's data to
  assert.ok(restore.includes('BACKUP_MIN_FREE_MIB=100'), restore.join(' '))
})

test('I1: a restore job takes ROTATE_KEYS (an import with new keys ends the restored sessions in the job)', () => {
  const restore = buildJob({ ref: REF, type: 'restore', args: { dir: `${REF}/20260101-000000` },
    env: { PGHOST: 'db', PGPASSWORD: 'x', ROTATE_KEYS: '1' } }, NODE).body.Env as string[]
  assert.ok(restore.includes('ROTATE_KEYS=1'))
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
      assert.deepEqual(c.networks, c.service === 'fn' ? [`sb-${REF}`, `sb-${REF}-egress`] : [`sb-${REF}`], c.service)
      assert.equal(traefik.length, 0)
      continue
    }
    assert.deepEqual(c.networks, [`sb-${REF}`, `sb-${REF}-ctl`, 'coolify'])
    const l = Object.fromEntries(traefik)
    for (const [k] of traefik) {
      const name = /^traefik\.http\.(?:routers|services|middlewares)\.([^.]+)\./.exec(k)?.[1]
      if (name !== undefined) assert.ok(name === `sb-${REF}` || name.startsWith(`sb-${REF}-`), k)
      else assert.ok(['traefik.enable', 'traefik.docker.network'].includes(k), k)
    }
    assert.equal(l[`traefik.http.routers.sb-${REF}.rule`], `Host(\`${REF}.example.com\`) || Host(\`api.custom.org\`)`)
    // explicit and low: a foreign router for the same host (rule-length priority) always wins over ours
    assert.equal(l[`traefik.http.routers.sb-${REF}.priority`], '10')
    assert.equal(l[`traefik.http.routers.sb-${REF}-http.priority`], '10')
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

const TS = '20261122-030000'
const job = (over: Partial<JobInput> = {}): JobInput => ({
  ref: REF, type: 'backup', args: { dir: REF }, env: { PGHOST: 'db', PGPASSWORD: 'pw' }, ...over,
})

test('backup job: one bind, its own backup directory only; storage volume; fixed command', () => {
  const spec = buildJob(job(), NODE)
  assert.equal(spec.name, `sb-${REF}-job-backup`)
  const hc = spec.body.HostConfig as any
  const binds = hc.Mounts.filter((m: any) => m.Type === 'bind')
  // R5: never the whole backup directory (every org and control); created on the host for a project's first backup
  assert.deepEqual(binds, [{ Type: 'bind', Source: `/opt/selfbase/backups/${REF}`, Target: `/backups/${REF}`, BindOptions: { CreateMountpoint: true } }])
  assert.deepEqual(hc.Mounts.filter((m: any) => m.Type === 'volume'),
    [{ Type: 'volume', Source: `sb-${REF}-storage`, Target: '/data/storage', ReadOnly: true }])
  assert.deepEqual(spec.body.Cmd, ['bash', '/scripts/backup.sh'])
  assert.equal(spec.body.Image, 'ghcr.io/acme/selfbase/selfbase-job:2.1.0')
  assert.deepEqual(hc.RestartPolicy, { Name: 'no' })
  // a stopped job gets 60 s to stop its writer and undo its steps before SIGKILL (Docker's default is 10 s)
  for (const type of ['backup', 'restore'] as const) {
    assert.equal(buildJob(job({ type, args: { dir: type === 'backup' ? REF : `${REF}/${TS}` } }), NODE).body.StopTimeout, 60, type)
  }
  assert.equal(hc.Memory, 512 * MiB)
  assert.equal(hc.MemorySwap, hc.Memory)
  assert.ok((spec.body.Env as string[]).includes(`BACKUP_SUBDIR=${REF}`))
  assert.deepEqual(spec.networks, [`sb-${REF}`])
  scan(spec, 'job')
  const exp = buildJob(job({ args: { dir: `export-${REF}` } }), NODE).body.HostConfig as any
  assert.equal(exp.Mounts[0].Source, `/opt/selfbase/backups/export-${REF}`)
})

test('I3: a prune-only backup job (expired exports, a deleted project too) has no network and no storage', () => {
  const spec = buildJob(job({ args: { dir: `export-${REF}` }, env: { BACKUP_PRUNE_ONLY: '1', EXPORT_RETENTION_DAYS: '7' } }), NODE)
  const hc = spec.body.HostConfig as any
  // the export directory only, never created on the host (nothing to prune when it is not there)
  assert.deepEqual(hc.Mounts, [{ Type: 'bind', Source: `/opt/selfbase/backups/export-${REF}`, Target: `/backups/export-${REF}` }])
  assert.equal(hc.NetworkMode, 'none')
  assert.equal(spec.body.NetworkingConfig, undefined)
  assert.deepEqual(spec.networks, [])
  assert.ok((spec.body.Env as string[]).includes('BACKUP_PRUNE_ONLY=1'))
  scan(spec, 'prune job')
  // a project's own backups, control's, a restore or another value: refused
  assert.throws(() => buildJob(job({ env: { BACKUP_PRUNE_ONLY: '1' } }), NODE), code('invalid_dir'))
  assert.throws(() => buildJob(job({ ref: 'control', args: { dir: 'control' }, env: { BACKUP_PRUNE_ONLY: '1' } }), NODE), code('invalid_dir'))
  assert.throws(() => buildJob(job({ type: 'restore', args: { dir: `export-${REF}/${TS}` }, env: { BACKUP_PRUNE_ONLY: '1' } }), NODE), code('invalid_env'))
  for (const v of ['0', 'yes', '']) {
    assert.throws(() => buildJob(job({ args: { dir: `export-${REF}` }, env: { BACKUP_PRUNE_ONLY: v } }), NODE), code('invalid_env'), v)
  }
})

test('R5: a restore job mounts the one backup it reads, read-only', () => {
  for (const dir of [`${REF}/${TS}`, `export-zyxwvutsrqponmlkjihg/${TS}`, 'import/acme/app-v1']) {
    const spec = buildJob(job({ type: 'restore', args: { dir } }), NODE)
    assert.deepEqual(spec.body.Cmd, ['bash', '/scripts/restore.sh'])
    const hc = spec.body.HostConfig as any
    assert.deepEqual(hc.Mounts.filter((m: any) => m.Type === 'bind'), [{ Type: 'bind', Source: `/opt/selfbase/backups/${dir}`, Target: `/backups/${dir}`, ReadOnly: true }], dir)
    assert.ok((spec.body.Env as string[]).includes(`RESTORE_DIR=${dir}`))
  }
})

test('R5: a backup job writes only into its own ref (or export-<ref>, control for control)', () => {
  const OTHER = 'zyxwvutsrqponmlkjihg'
  for (const dir of [OTHER, `export-${OTHER}`, 'control', `${REF}/x`, 'daily', `${REF}-x`]) {
    assert.throws(() => buildJob(job({ args: { dir } }), NODE), code('invalid_dir'), dir)
    assert.throws(() => buildJob(job({ args: {}, env: { BACKUP_SUBDIR: dir } }), NODE), code('invalid_dir'), dir)
  }
  assert.throws(() => buildJob(job({ ref: 'control', args: { dir: REF } }), NODE), code('invalid_dir'))
  // no directory at all: refused, never the whole backup directory
  assert.throws(() => buildJob(job({ args: {} }), NODE), code('invalid_dir'))
  assert.throws(() => buildJob(job({ type: 'restore', args: {} }), NODE), code('invalid_dir'))
  // control's dump holds every project's secrets: never restored into a project
  for (const dir of [`control/${TS}`, `${REF}/latest`, `${REF}`, `${OTHER}/${TS}/x`]) {
    assert.throws(() => buildJob(job({ type: 'restore', args: { dir } }), NODE), code('invalid_dir'), dir)
  }
})

test('jobs run as root (pg_dump, tar) but without NET_RAW', () => {
  assert.deepEqual((buildJob(job(), NODE).body.HostConfig as any).CapDrop, ['NET_RAW'])
})

test('control job: control network, no volume', () => {
  const spec = buildJob(job({ ref: 'control', args: { dir: 'control' } }), NODE)
  assert.equal(spec.name, 'sb-control-job-backup')
  assert.deepEqual(spec.networks, ['selfbase'])
  assert.deepEqual((spec.body.HostConfig as any).Mounts.map((m: any) => [m.Type, m.Source]), [['bind', '/opt/selfbase/backups/control']])
})

test('job refusals', () => {
  assert.throws(() => buildJob(job({ env: { LD_PRELOAD: '/x.so' } }), NODE), code('invalid_env'))
  // an export's group: control reads its project.json
  assert.ok((buildJob(job({ args: { dir: `export-${REF}` }, env: { MANIFEST_B64: 'e30=', CONTROL_GID: '1000' } }), NODE).body.Env as string[]).includes('CONTROL_GID=1000'))
  assert.throws(() => buildJob(job({ env: { RESTORE_DIR: '../etc' } }), NODE), code('invalid_dir'))
  for (const dir of ['../etc', 'a/b/c', '.', 'a/..', '/abs', '', 'a b', 'import/a/b', 'import/a/..']) {
    assert.throws(() => buildJob(job({ args: { dir } }), NODE), code('invalid_dir'), dir)
  }
  // a restore may read import/<org slug>/<name>; a backup never writes there
  assert.doesNotThrow(() => buildJob(job({ type: 'restore', args: { dir: 'import/acme/v1' } }), NODE))
  for (const dir of ['import/a/b/c', 'import/a/..', 'other/a/b', 'import/../x']) {
    assert.throws(() => buildJob(job({ type: 'restore', args: { dir } }), NODE), code('invalid_dir'), dir)
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

test("template/compose.yml: core's TRUSTED_PROXY_IPS is what the provisioner renders, an empty list staying empty", () => {
  const real = validateTemplate(parse(readFileSync(fileURLToPath(new URL('../../template/compose.yml', import.meta.url)), 'utf8')))
  const sizes = JSON.parse(readFileSync(fileURLToPath(new URL('../../template/sizes.json', import.meta.url)), 'utf8'))
  const coreEnv = (proxy: string[]) => buildProject(input({ env: dryRunEnv(real) }), real, sizes, NODE, proxy)
    .containers.find((c) => c.service === 'core')!.body.Env as string[]
  // empty: the proxy is down, trust no peer (only an unset variable, a standalone stack, renders `*`)
  assert.ok(coreEnv([]).includes('TRUSTED_PROXY_IPS='), coreEnv([]).join(' '))
  assert.ok(coreEnv(['10.0.1.2']).includes('TRUSTED_PROXY_IPS=10.0.1.2'))
})

test("ensure's proxy list: the proxy's addresses; none while it is not running; core's current list when it cannot be read", async () => {
  const core = async () => ({ Config: { Env: ['A=1', 'TRUSTED_PROXY_IPS=10.0.1.2,10.0.1.3'] } })
  const fail = (code: string) => async (): Promise<string[]> => { throw new ProvisionError(code === 'proxy_unavailable' ? 503 : 502, code) }
  assert.deepEqual(await proxyForCore(async () => ['10.0.1.9'], core), ['10.0.1.9'])
  assert.deepEqual(await proxyForCore(fail('proxy_unavailable'), core), [])
  // any other failure (the socket proxy unreachable, a refused inspect) keeps core as it is: no recreate now, and none
  // again on the next pass when the proxy reads fine
  assert.deepEqual(await proxyForCore(fail('docker_unreachable'), core), ['10.0.1.2', '10.0.1.3'])
  assert.deepEqual(await proxyForCore(fail('docker_refused'), async () => null), [])
})
