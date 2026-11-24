// Fails when core/fn read an env variable that template/compose.yml does not pass to that service
// (so it could never be set in a compose deployment) and that is not deliberately internal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const root = join(import.meta.dirname, '..', '..')
const compose = readFileSync(join(root, 'template', 'compose.yml'), 'utf8')

// Text of one top-level service block (2-space indented key up to the next one).
function serviceBlock(name) {
  const lines = compose.split(/\r?\n/)
  const start = lines.findIndex((l) => l === `  ${name}:`)
  assert.ok(start >= 0, `service ${name} not found in compose.yml`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^\S/.test(l) || /^  \S/.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

function sources(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'test' ? [] : sources(p)
    return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [readFileSync(p, 'utf8')] : []
  })
}

const reads = (texts, re) => new Set(texts.flatMap((t) => [...t.matchAll(re)].map((m) => m[1])))

// Set by the image, not meant for the operator.
const CORE_INTERNAL = ['DB_PORT', 'PORT', 'PLATFORM_DIR']
const FN_INTERNAL = ['PORT']

function check(service, vars, internal) {
  const block = serviceBlock(service)
  const missing = [...vars].filter((v) => !internal.includes(v) && !new RegExp(`^\\s+${v}:`, 'm').test(block))
  assert.deepEqual(missing, [], `${service}: read by code but not passed in compose.yml (pass with \${X:-default} or allowlist as internal)`)
}

test('every env variable core reads is passed by compose or internal', () => {
  const vars = reads(sources(join(root, 'core', 'src')), /\b(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g)
  assert.ok(vars.size > 20, 'scan found too few variables, regex broken?')
  check('core', vars, CORE_INTERNAL)
})

test('fn gets no database credentials', () => {
  const block = serviceBlock('fn')
  assert.doesNotMatch(block, /^\s+SUPABASE_DB_URL:/m)
  assert.doesNotMatch(block, /POSTGRES_PASSWORD/)
})

test('values the services cannot run without stop compose when missing', () => {
  for (const [service, vars] of [['core', ['PUBLIC_URL', 'SITE_URL']], ['fn', ['ANON_KEY', 'SERVICE_ROLE_KEY']]]) {
    const block = serviceBlock(service)
    for (const v of vars) assert.match(block, new RegExp(`\\$\\{${v}:\\?[^}]+\\}`), `${service}: ${v} must be \${${v}:?message}`)
  }
})

test('every env variable fn reads is passed by compose or internal', () => {
  const vars = reads(sources(join(root, 'fn')), /Deno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)
  assert.ok(vars.has('FN_IMPORT_TIMEOUT_MS'), 'scan missed FN_IMPORT_TIMEOUT_MS, regex broken?')
  check('fn', vars, FN_INTERNAL)
})

test('no panel settings and no Coolify labels are left', () => {
  assert.doesNotMatch(compose, /PANEL_/)
  assert.doesNotMatch(compose, /coolify\./)
})

test('control reaches its siblings by their fixed addresses, never a DNS name (it is on the proxy network too)', () => {
  const ctl = readFileSync(join(root, 'control', 'compose.yml'), 'utf8')
  // any container on the proxy network can carry the alias selfbase-provisioner.selfbase, and Docker's DNS answers it
  // before the selfbase network's own container (R1, reproduced on Docker 29.8)
  const P = '\\$\\{CONTROL_NET_PREFIX:-10\\.206\\.255\\}'
  const at = (service, n) => assert.match(serviceOf(ctl, service), new RegExp(`^\\s+selfbase: \\{ ipv4_address: "${P}\\.${n}" \\}$`, 'm'), service)
  assert.match(ctl, new RegExp(`^\\s+PROVISIONER_URL: http://${P}\\.3:8090$`, 'm'))
  assert.match(ctl, new RegExp(`^\\s+CONTROL_DB_HOST: ${P}\\.2$`, 'm'))
  assert.match(ctl, new RegExp(`^\\s+LOGS_URL: http://${P}\\.4:9428$`, 'm'))
  at('control-db', 2)
  at('provisioner', 3)
  at('logs', 4)
  assert.doesNotMatch(ctl, /^\s+[A-Z_]+: .*selfbase-(provisioner|control-db|logs)\b/m)
  // dynamic addresses (control, backup jobs) never land on a fixed one
  assert.match(ctl, new RegExp(`subnet: ${P}\\.0/27\\s+ip_range: ${P}\\.16/28\\s+gateway: ${P}\\.1\\s`))
})

function serviceOf(text, name) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l === `  ${name}:`)
  const rest = lines.slice(start + 1)
  return rest.slice(0, rest.findIndex((l) => /^  \S/.test(l) || /^\S/.test(l))).join('\n')
}

// The local stack (compose.yml + compose.build.yml), resolved by docker compose itself.
// An empty env file keeps a real .env out of it; the values come from the environment.
const REQUIRED = { REGISTRY: 'selfbase', TEMPLATE_VERSION: 'dev', POSTGRES_PASSWORD: 'x', AUTHENTICATOR_PASSWORD: 'x', JWT_SECRET: 'x',
  PUBLIC_URL: 'https://api.example.com', SITE_URL: 'https://app.example.com', ANON_KEY: 'x', SERVICE_ROLE_KEY: 'x' }
function config(env) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-config-'))
  try {
    writeFileSync(join(dir, 'empty.env'), '')
    return spawnSync('docker', ['compose', '-f', join(root, 'template', 'compose.yml'), '-f', join(root, 'template', 'compose.build.yml'),
      '--env-file', join(dir, 'empty.env'), 'config', '--format', 'json'],
      { env: { ...process.env, ...env, COMPOSE_PROJECT_NAME: 'sb-config-check' }, encoding: 'utf8', timeout: 60000 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const noDocker = spawnSync('docker', ['compose', 'version']).status !== 0

test('local stack: five services, only core published, on loopback 8080', { skip: noDocker && 'docker not available' }, () => {
  const r = config(REQUIRED)
  assert.equal(r.status, 0, r.stderr)
  const { name, services } = JSON.parse(r.stdout)
  assert.equal(name, 'sb-config-check')
  assert.deepEqual(Object.keys(services).sort(), ['core', 'db', 'fn', 'pooler', 'rest'])
  for (const [n, s] of Object.entries(services)) {
    assert.deepEqual((s.ports ?? []).map((p) => `${p.host_ip}:${p.target}`), n === 'core' ? ['127.0.0.1:8080'] : [], `${n}: ports`)
    assert.equal(s.restart, 'unless-stopped', `${n}: restart`)
    assert.ok(s.build, `${n}: build`)
  }
  assert.deepEqual(services.core.depends_on, { db: { condition: 'service_healthy', required: true },
    rest: { condition: 'service_started', required: true } })
})

test('compose refuses to run without PUBLIC_URL and names it', { skip: noDocker && 'docker not available' }, () => {
  const r = config({ ...REQUIRED, PUBLIC_URL: '' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /set PUBLIC_URL/)
})
