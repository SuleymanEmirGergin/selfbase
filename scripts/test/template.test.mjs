// The v2 project template: template/compose.yml passes the provisioner's strict subset and renders for every size,
// sizes.json matches the size table (global constraints), and the local stack (compose.yml + compose.build.yml)
// comes up on empty volumes. The stack test builds every image; it is skipped without Docker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { parse } from 'yaml'
import { validateTemplate } from '../../provisioner/src/template.ts'
import { buildProject } from '../../provisioner/src/spec.ts'

const root = join(import.meta.dirname, '..', '..')
const tplFile = join(root, 'template', 'compose.yml')
const sizes = JSON.parse(readFileSync(join(root, 'template', 'sizes.json'), 'utf8'))
const SIZES = ['micro', 'small', 'medium']
const SERVICES = ['db', 'rest', 'core', 'fn', 'pooler']

test('template --check passes', () => {
  const r = spawnSync(process.execPath, [join(root, 'provisioner', 'src', 'template.ts'), '--check', tplFile], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /template ok: db, rest, core, fn, pooler; rendered for micro, small, medium/)
})

test('sizes.json: memory, cpus, pids and Postgres settings per size', () => {
  const mem = { micro: [512, 128, 256, 256, 32], small: [1024, 256, 512, 512, 32], medium: [2048, 256, 512, 1024, 32] }
  const cpus = { micro: [1, 0.5, 0.5, 0.5, 0.25], small: [2, 1, 1, 1, 0.25], medium: [2, 1, 1, 1, 0.25] }
  const db = { micro: [128, '128MB', 60], small: [256, '256MB', 100], medium: [512, '512MB', 150] }
  const pool = { micro: 15, small: 20, medium: 30 }
  const total = { micro: 1184, small: 2336, medium: 3872 }
  assert.deepEqual(Object.keys(sizes), SIZES)
  for (const size of SIZES) {
    const t = sizes[size]
    assert.deepEqual(Object.keys(t), SERVICES, size)
    assert.deepEqual(SERVICES.map((s) => t[s].mem_mb), mem[size], `${size} mem_mb`)
    assert.deepEqual(SERVICES.map((s) => t[s].cpus), cpus[size], `${size} cpus`)
    assert.deepEqual(SERVICES.map((s) => t[s].pids), [512, 512, 512, 512, 64], `${size} pids`)
    assert.equal(SERVICES.reduce((n, s) => n + t[s].mem_mb, 0), total[size], `${size} total`)
    assert.deepEqual([t.db.shm_mb, t.db.shared_buffers, t.db.max_connections], db[size], `${size} db`)
    assert.equal(t.pooler.pool_size, pool[size], `${size} pool_size`)
    for (const s of SERVICES) {
      for (const k of ['mem_mb', 'pids']) assert.ok(Number.isInteger(t[s][k]) && t[s][k] > 0, `${size}.${s}.${k}`)
      assert.ok(t[s].cpus > 0, `${size}.${s}.cpus`)
    }
  }
})

// Exactly the names the template needs without a default; anything else unset renders its default.
const ENV = { POSTGRES_PASSWORD: 'p', AUTHENTICATOR_PASSWORD: 'a', JWT_SECRET: 'j', ANON_KEY: 'k', SERVICE_ROLE_KEY: 's',
  PUBLIC_URL: 'https://abcdefghijabcdefghij.example.com', SITE_URL: 'https://app.example.com', ADMIN_TOKEN: 't',
  PROJECT_REF: 'abcdefghijabcdefghij' }
const NODE = { registry: 'registry.example.com/selfbase', templateVersion: '2.0.0', proxyNetwork: 'proxy', entrypointHttp: 'http',
  entrypointHttps: 'https', certResolver: 'letsencrypt', logSyslogAddr: '', cgroupParent: '', backupHostDir: '',
  subnetPool: '10.207.0.0/16', controlContainer: 'selfbase-control', controlNetwork: 'selfbase' }

test('renders for every size; only core joins the proxy, on 8080; the admin port stays internal', () => {
  const tpl = validateTemplate(parse(readFileSync(tplFile, 'utf8'), { maxAliasCount: 0 }))
  for (const size of SIZES) {
    const p = buildProject({ ref: ENV.PROJECT_REF, templateVersion: '2.0.0', size, subnet: '10.207.0.0/27',
      hosts: ['abcdefghijabcdefghij.example.com'], env: ENV }, tpl, sizes, NODE)
    const by = Object.fromEntries(p.containers.map((c) => [c.service, c]))
    assert.deepEqual(Object.keys(by).sort(), [...SERVICES].sort())
    assert.deepEqual(p.volumes.sort(), ['denocache', 'functions', 'pgdata', 'storage'].map((v) => `sb-${ENV.PROJECT_REF}-${v}`))
    const envOf = (s) => Object.fromEntries(by[s].body.Env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
    const t = sizes[size]
    assert.ok(by.db.body.Cmd.includes(`shared_buffers=${t.db.shared_buffers}`) && by.db.body.Cmd.includes(`max_connections=${t.db.max_connections}`))
    assert.equal(envOf('pooler').POOL_SIZE, String(t.pooler.pool_size))
    assert.equal(envOf('rest').PGRST_DB_URI, 'postgres://authenticator:a@db:5432/postgres')
    const core = envOf('core')
    assert.deepEqual([core.ADMIN_PORT, core.ADMIN_TOKEN, core.PROJECT_REF, core.AUTH_DISABLE_SIGNUP], ['8081', 't', ENV.PROJECT_REF, 'false'])
    assert.ok(!Object.keys(core).some((k) => k.startsWith('PANEL_')))
    // core is on the proxy network too, where Docker's DNS may answer any name first: siblings by their fixed addresses
    const net = `sb-${ENV.PROJECT_REF}`
    const ip = (s) => by[s].body.NetworkingConfig.EndpointsConfig[net].IPAMConfig.IPv4Address
    assert.deepEqual([core.DB_HOST, core.PGRST_URL, core.FN_URL], [ip('db'), `http://${ip('rest')}:3000`, `http://${ip('fn')}:8000`])
    assert.match(core.DB_HOST, /^10\.207\.0\.\d+$/)
    assert.equal(core.TRUSTED_PROXY_IPS, '')
    assert.ok(!('POSTGRES_PASSWORD' in envOf('fn')) && !('SUPABASE_DB_URL' in envOf('fn')))
    for (const c of p.containers) {
      assert.equal(c.body.Image, `${NODE.registry}/selfbase-${c.service}:2.0.0`)
      // R6: core also on the control /29 (with control only), fn on its egress network
      assert.deepEqual(c.networks, c.service === 'core' ? [net, `${net}-ctl`, 'proxy'] : c.service === 'fn' ? [net, `${net}-egress`] : [net])
      const labels = Object.entries(c.body.Labels)
      assert.ok(!labels.some(([k]) => k.startsWith('coolify.')), `${c.service}: no coolify labels`)
      assert.ok(!labels.some(([, v]) => v.includes('8081')), `${c.service}: 8081 never labelled`)
      assert.equal(labels.some(([k]) => k.startsWith('traefik.')), c.service === 'core')
    }
    assert.equal(by.core.body.Labels[`traefik.http.services.sb-${ENV.PROJECT_REF}.loadbalancer.server.port`], '8080')
  }
})

// --- local stack ---
const noDocker = spawnSync('docker', ['compose', 'version']).status !== 0
const PROJECT = 'sb-template-test'
const CORE_PORT = process.env.TEST_TEMPLATE_CORE_PORT ?? '58080'
const b64url = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
const sign = (payload, secret) => {
  const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

test('local stack comes up on empty volumes and answers', { skip: noDocker && 'docker not available', timeout: 900_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-template-'))
  const secret = randomBytes(48).toString('base64url')
  const anon = sign({ role: 'anon', iss: 'selfbase' }, secret)
  const adminToken = randomBytes(32).toString('hex')
  const pw = randomBytes(24).toString('hex')
  const envFile = join(dir, 'test.env')
  writeFileSync(envFile, Object.entries({ REGISTRY: 'selfbase-test', TEMPLATE_VERSION: 'dev', POSTGRES_PASSWORD: pw,
    AUTHENTICATOR_PASSWORD: randomBytes(24).toString('hex'), JWT_SECRET: secret, ANON_KEY: anon,
    SERVICE_ROLE_KEY: sign({ role: 'service_role', iss: 'selfbase' }, secret), ADMIN_TOKEN: adminToken,
    PUBLIC_URL: `http://localhost:${CORE_PORT}`, SITE_URL: 'http://localhost:3000', CORE_PORT }).map(([k, v]) => `${k}=${v}\n`).join(''))
  const dc = (...args) => spawnSync('docker', ['compose', '-p', PROJECT, '-f', tplFile, '-f', join(root, 'template', 'compose.build.yml'),
    '--env-file', envFile, ...args], { encoding: 'utf8', timeout: 900_000 })
  const ok = (r) => { assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); return r.stdout }
  try {
    dc('down', '-v')
    ok(dc('up', '-d', '--build'))
    const deadline = Date.now() + 240_000
    let ps
    for (;;) {
      ps = ok(dc('ps', '-a', '--format', 'json')).trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
      if (ps.length === 5 && ps.every((c) => c.Health === 'healthy')) break
      if (Date.now() > deadline) assert.fail(`not healthy: ${ps.map((c) => `${c.Service}=${c.State}/${c.Health}`).join(' ')}`)
      await new Promise((r) => setTimeout(r, 3000))
    }
    const base = `http://127.0.0.1:${CORE_PORT}`
    assert.equal((await fetch(`${base}/health`)).status, 200)
    // On a fresh database the OpenAPI root takes longer than anon's 3 s statement timeout until the backends'
    // catalog caches are warm (same note in core/test/bootstrap.test.ts), so it may answer 500 a few times first.
    let rest
    for (let i = 0; i < 20 && rest !== 200; i++) {
      rest = (await fetch(`${base}/rest/v1/`, { headers: { apikey: anon, authorization: `Bearer ${anon}` } })).status
    }
    assert.equal(rest, 200)
    assert.equal((await fetch(`${base}/functions/v1/no-such-function`, { headers: { apikey: anon, authorization: `Bearer ${anon}` } })).status, 404)
    assert.equal(ok(dc('exec', '-T', '-e', `PGPASSWORD=${pw}`, 'db', 'psql', '-h', 'pooler', '-p', '6432', '-U', 'postgres', '-tAc', 'select 1')).trim(), '1')
    // only core publishes, only its 8080, only on loopback
    const published = ps.flatMap((c) => (c.Publishers ?? []).filter((p) => p.PublishedPort).map((p) => `${c.Service}:${p.URL}:${p.TargetPort}`))
    assert.deepEqual(published, [`core:127.0.0.1:8080`])
    // the admin port answers inside the project network
    const ready = (token) => ok(dc('exec', '-T', 'fn', 'deno', 'eval',
      `const r = await fetch('http://core:8081/admin/ready', { headers: { authorization: 'Bearer ${token}' } }); console.log(r.status)`)).trim()
    assert.equal(ready(adminToken), '200')
    assert.equal(ready('wrong'), '401')
  } finally {
    dc('down', '-v')
    rmSync(dir, { recursive: true, force: true })
  }
})
