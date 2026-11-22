// scripts/install-check.mjs: one line per problem, key names only, exit 1; and the env keys it knows are exactly the
// ones control/.env.example lists and the control stack's compose files interpolate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const root = join(import.meta.dirname, '..', '..')
const script = join(root, 'scripts', 'install-check.mjs')
const SECRET = 'do-not-print-this-secret-value-0123456789'

const good = {
  SELFBASE_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  CONTROL_DB_PASSWORD: SECRET,
  CONTROL_JWT_SECRET: 'j'.repeat(48),
  PROVISIONER_TOKEN: 't'.repeat(40),
  BASE_DOMAIN: 'example.test',
  REGISTRY: 'ghcr.io/owner',
  TEMPLATE_VERSION: '2.1.0',
  PROXY_MODE: 'coolify',
  PROXY_NETWORK: 'coolify',
  PROXY_CERTRESOLVER: 'letsencrypt',
  BACKUP_HOST_DIR: '/opt/selfbase/backups',
  PROJECT_SUBNET_POOL: '10.207.0.0/16',
  TEST_HOST: 'sb-test.example.test',
  PUBLIC_URL: 'https://selfbase.example.test',
}

function run(env, { raw } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-install-check-'))
  const file = join(dir, '.env')
  writeFileSync(file, raw ?? Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  chmodSync(file, 0o600)
  const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' })
  rmSync(dir, { recursive: true, force: true })
  return { status: r.status, out: r.stdout + r.stderr }
}

test('a complete env file passes', () => {
  const r = run(good)
  assert.equal(r.status, 0, r.out)
})

test('comments, blank lines and quoted values are read like compose does', () => {
  const raw = `# header\n\n${Object.entries(good).map(([k, v]) => `${k}="${v}"`).join('\n')}\n`
  assert.equal(run(null, { raw }).status, 0)
})

test('each problem is one line naming the key, never a value', () => {
  const { SELFBASE_MASTER_KEY, ...rest } = good
  const r = run({ ...rest, PROVISIONER_TOKEN: '', SURPRISE: SECRET, PROJECT_SUBNET_POOL: '10.207.0.0/24',
    TEST_HOST: 'sb-test.other.test', PUBLIC_URL: 'https://selfbase.other.test' })
  assert.equal(r.status, 1)
  const lines = r.out.trim().split('\n')
  for (const key of ['SELFBASE_MASTER_KEY', 'PROVISIONER_TOKEN', 'SURPRISE', 'PROJECT_SUBNET_POOL', 'TEST_HOST', 'PUBLIC_URL']) {
    assert.equal(lines.filter((l) => l.includes(key)).length, 1, `${key}: ${r.out}`)
  }
  assert.ok(!r.out.includes(SECRET))
})

test('the master key must decode to 32 bytes', () => {
  for (const k of [Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), 'not base64 at all']) {
    const r = run({ ...good, SELFBASE_MASTER_KEY: k })
    assert.equal(r.status, 1)
    assert.match(r.out, /SELFBASE_MASTER_KEY/)
    assert.ok(!r.out.includes(k))
  }
})

test('the subnet pool is a /16 or larger network address', () => {
  assert.equal(run({ ...good, PROJECT_SUBNET_POOL: '10.0.0.0/8' }).status, 0)
  for (const p of ['10.207.0.0/17', '10.207.1.0/16', '10.207.0.0', '300.1.0.0/16']) assert.equal(run({ ...good, PROJECT_SUBNET_POOL: p }).status, 1, p)
})

test('settings that must agree with each other', () => {
  const bad = (patch, key) => {
    const r = run({ ...good, ...patch })
    assert.equal(r.status, 1, JSON.stringify(patch))
    assert.match(r.out, new RegExp(key))
  }
  bad({ PROXY_MODE: 'nginx' }, 'PROXY_MODE')
  bad({ PROXY_CERTRESOLVER: '' }, 'PROXY_CERTRESOLVER') // coolify needs its resolver
  bad({ PROXY_MODE: 'own' }, 'COMPOSE_PROFILES') // own mode needs the proxy profile
  bad({ BACKUP_HOST_DIR: '/var/backups' }, 'BACKUP_HOST_DIR')
  bad({ PROXY_TRAEFIK_MAJOR: '4' }, 'PROXY_TRAEFIK_MAJOR')
  bad({ PROXY_TRAEFIK_MAJOR: '2' }, 'COMPOSE_FILE')
  assert.equal(run({ ...good, PROXY_MODE: 'own', COMPOSE_PROFILES: 'proxy', PROXY_CERTRESOLVER: '' }).status, 0)
  assert.equal(run({ ...good, PROXY_TRAEFIK_MAJOR: '2', COMPOSE_FILE: 'compose.yml:compose.traefik-v2.yml' }).status, 0)
})

test('the env file must be 0600 on Linux', { skip: process.platform !== 'linux' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-install-check-'))
  const file = join(dir, '.env')
  writeFileSync(file, Object.entries(good).map(([k, v]) => `${k}=${v}`).join('\n'))
  chmodSync(file, 0o644)
  const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(r.status, 1)
  assert.match(r.stdout + r.stderr, /0600/)
})

test('no file: exit 1 with usage', () => {
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 1)
})

test('.env.example lists exactly the known keys, empty, each after one comment line', () => {
  const known = JSON.parse(spawnSync(process.execPath, [script, '--keys'], { encoding: 'utf8' }).stdout)
  const lines = readFileSync(join(root, 'control', '.env.example'), 'utf8').split(/\r?\n/)
  const keys = []
  lines.forEach((l, i) => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l)
    if (!m) return
    keys.push(m[1])
    assert.equal(m[2], '', `${m[1]} must be empty`)
    assert.match(lines[i - 1] ?? '', /^# \S/, `${m[1]} needs a comment line`)
  })
  assert.deepEqual([...keys].sort(), [...known].sort())
})

test('every variable the control stack interpolates is a known key', () => {
  const known = new Set(JSON.parse(spawnSync(process.execPath, [script, '--keys'], { encoding: 'utf8' }).stdout))
  for (const f of ['control/compose.yml', 'control/compose.build.yml', 'provisioner/socket-proxy.env', 'control/traefik-socket-proxy.env']) {
    const text = readFileSync(join(root, f), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    for (const [, name] of text.matchAll(/\$\{([A-Z0-9_]+)/g)) assert.ok(known.has(name), `${f}: ${name}`)
  }
})
