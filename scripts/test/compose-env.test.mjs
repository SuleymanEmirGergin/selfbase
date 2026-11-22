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

// Set by the compose file itself or the image, not meant for the operator.
// AUTHENTICATOR_PASSWORD defaults to POSTGRES_PASSWORD, the password rest's PGRST_DB_URI uses in plain compose.
const CORE_INTERNAL = ['DB_HOST', 'DB_PORT', 'PORT', 'PANEL_DIR', 'PLATFORM_DIR', 'AUTHENTICATOR_PASSWORD']
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

// Resolved by docker compose itself, so the anchor merge is checked the way compose applies it.
// An empty env file keeps a real .env next to compose.yml out of it; the values come from the environment.
const LIMITS = { db: [1073741824, 2], core: [536870912, 1], rest: [268435456, 1], fn: [536870912, 1], backup: [536870912, 0.5] }
const REQUIRED = { POSTGRES_PASSWORD: 'x', JWT_SECRET: 'x', PUBLIC_URL: 'https://api.example.com', SITE_URL: 'https://app.example.com', ANON_KEY: 'x', SERVICE_ROLE_KEY: 'x' }
function config(env) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-config-'))
  try {
    writeFileSync(join(dir, 'empty.env'), '')
    return spawnSync('docker', ['compose', '-f', join(root, 'template', 'compose.yml'), '--env-file', join(dir, 'empty.env'), 'config', '--format', 'json'],
      { env: { ...process.env, ...env, COMPOSE_PROJECT_NAME: 'sb-config-check' }, encoding: 'utf8', timeout: 60000 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const noDocker = spawnSync('docker', ['compose', 'version']).status !== 0

test('every service has limits, rotated logs and no-new-privileges', { skip: noDocker && 'docker not available' }, () => {
  const r = config(REQUIRED)
  assert.equal(r.status, 0, r.stderr)
  const { services } = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(services).sort(), Object.keys(LIMITS).sort())
  for (const [name, s] of Object.entries(services)) {
    assert.deepEqual([Number(s.mem_limit), Number(s.cpus)], LIMITS[name], `${name}: mem_limit/cpus`)
    assert.equal(s.pids_limit, 512, `${name}: pids_limit`)
    assert.deepEqual(s.logging, { driver: 'json-file', options: { 'max-file': '3', 'max-size': '10m' } }, `${name}: logging`)
    assert.deepEqual(s.security_opt, ['no-new-privileges:true'], `${name}: security_opt`)
  }
  assert.equal(Number(services.db.shm_size), 268435456)
})

test('compose refuses to run without PUBLIC_URL and names it', { skip: noDocker && 'docker not available' }, () => {
  const r = config({ ...REQUIRED, PUBLIC_URL: '' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /set PUBLIC_URL/)
})
