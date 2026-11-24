// scripts/install-check.mjs: one line per problem, key names only, exit 1; and the env keys it knows are exactly the
// ones control/.env.example lists and the control stack's compose files interpolate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const root = join(import.meta.dirname, '..', '..')
const script = join(root, 'scripts', 'install-check.mjs')
const SECRET = 'do-not-print-this-secret-value-0123456789'
// On Linux the secret files must be root:10001, which only root can set: run this file as root there (CI uses sudo,
// the documented check runs with --user 0)
const asRoot = process.platform === 'linux' && process.getuid?.() === 0
// as another user on Linux every secret file is refused (not root-owned): the checks that run the script skip there
const needsRoot = process.platform === 'linux' && !asRoot && 'on Linux this file runs as root (sudo)'
const rootTest = (name, opts, fn) => fn ? test(name, { ...opts, skip: opts.skip || needsRoot }, fn) : test(name, { skip: needsRoot }, opts)

const good = {
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
const goodSecrets = {
  master_key: Buffer.alloc(32, 7).toString('base64'),
  control_db_password: SECRET,
  control_jwt_secret: 'j'.repeat(48),
  provisioner_token: 't'.repeat(40),
}

function run(env, { raw, secrets = goodSecrets, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-install-check-'))
  const file = join(dir, '.env')
  writeFileSync(file, raw ?? Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  chmodSync(file, 0o600)
  const sdir = join(dir, 'secrets')
  mkdirSync(sdir)
  for (const [name, value] of Object.entries(secrets)) {
    writeFileSync(join(sdir, name), `${value}\n`)
    chmodSync(join(sdir, name), 0o640)
    if (asRoot) chownSync(join(sdir, name), 0, 10001)
  }
  const r = spawnSync(process.execPath, [script, file, sdir], { encoding: 'utf8', env: { ...process.env, ...extraEnv } })
  rmSync(dir, { recursive: true, force: true })
  return { status: r.status, out: r.stdout + r.stderr }
}

rootTest('a complete env file and secrets directory pass', () => {
  const r = run(good)
  assert.equal(r.status, 0, r.out)
})

rootTest('comments, blank lines, quoted values and inline comments are read like compose does', () => {
  const raw = `# header\n\n${Object.entries(good).map(([k, v]) => `${k}="${v}"`).join('\n')}\n`
  assert.equal(run(null, { raw }).status, 0)
  // an unquoted value ends before " #": otherwise TEST_HOST would not end with BASE_DOMAIN
  const inline = `${Object.entries(good).map(([k, v]) => `${k}=${v}   # the ${k.toLowerCase()}`).join('\n')}\n`
  const r = run(null, { raw: inline })
  assert.equal(r.status, 0, r.out)
})

rootTest('each problem is one line naming the key, never a value', () => {
  const r = run({ ...good, SURPRISE: SECRET, PROJECT_SUBNET_POOL: '10.207.0.0/24',
    TEST_HOST: 'sb-test.other.test', PUBLIC_URL: 'https://selfbase.other.test' })
  assert.equal(r.status, 1)
  const lines = r.out.trim().split('\n')
  for (const key of ['SURPRISE', 'PROJECT_SUBNET_POOL', 'TEST_HOST', 'PUBLIC_URL']) {
    assert.equal(lines.filter((l) => l.includes(key)).length, 1, `${key}: ${r.out}`)
  }
  assert.ok(!r.out.includes(SECRET))
})

rootTest('the four secrets live in files, not in the env file', () => {
  const r = run({ ...good, CONTROL_DB_PASSWORD: SECRET, PROVISIONER_TOKEN: SECRET })
  assert.equal(r.status, 1)
  assert.match(r.out, /CONTROL_DB_PASSWORD: .*control_db_password/)
  assert.match(r.out, /PROVISIONER_TOKEN: .*provisioner_token/)
  assert.ok(!r.out.includes(SECRET))
  const { provisioner_token, ...three } = goodSecrets
  const missing = run(good, { secrets: { ...three, control_db_password: '' } })
  assert.equal(missing.status, 1)
  assert.match(missing.out, /provisioner_token: missing/)
  assert.match(missing.out, /control_db_password: empty/)
  assert.equal(spawnSync(process.execPath, [script, join(root, 'control', '.env.example')], { encoding: 'utf8' }).status, 1)
})

rootTest('the master key must decode to 32 bytes', () => {
  for (const k of [Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), 'not base64 at all']) {
    const r = run(good, { secrets: { ...goodSecrets, master_key: k } })
    assert.equal(r.status, 1)
    assert.match(r.out, /master_key/)
    assert.ok(!r.out.includes(k))
  }
})

rootTest('the subnet pool is optional (default 10.207.0.0/16), else a /16 or larger network address', () => {
  const { PROJECT_SUBNET_POOL, ...rest } = good
  assert.equal(run(rest).status, 0)
  assert.equal(run({ ...good, PROJECT_SUBNET_POOL: '10.0.0.0/8' }).status, 0)
  for (const p of ['10.207.0.0/17', '10.207.1.0/16', '10.207.0.0', '300.1.0.0/16']) assert.equal(run({ ...good, PROJECT_SUBNET_POOL: p }).status, 1, p)
})

rootTest('settings that must agree with each other', () => {
  const bad = (patch, key) => {
    const r = run({ ...good, ...patch })
    assert.equal(r.status, 1, JSON.stringify(patch))
    assert.match(r.out, new RegExp(key))
  }
  bad({ PROXY_MODE: 'nginx' }, 'PROXY_MODE')
  bad({ PUBLIC_URL: 'https://studio.example.test' }, 'PUBLIC_URL') // control's router answers selfbase.<BASE_DOMAIN> only
  bad({ PROXY_CERTRESOLVER: '' }, 'PROXY_CERTRESOLVER') // coolify needs its resolver
  bad({ PROXY_MODE: 'own' }, 'COMPOSE_PROFILES') // own mode needs the proxy profile
  bad({ BACKUP_HOST_DIR: '/var/backups' }, 'BACKUP_HOST_DIR')
  bad({ SECRETS_DIR: '/etc/selfbase' }, 'SECRETS_DIR')
  bad({ SECRETS_GID: 'staff' }, 'SECRETS_GID')
  bad({ PROXY_TRAEFIK_MAJOR: '4' }, 'PROXY_TRAEFIK_MAJOR')
  bad({ PROXY_TRAEFIK_MAJOR: '2' }, 'COMPOSE_FILE')
  for (const p of ['8.8.8', '10.206.256', '10.206.255.0', '172.32.0']) bad({ CONTROL_NET_PREFIX: p }, 'CONTROL_NET_PREFIX')
  assert.equal(run({ ...good, CONTROL_NET_PREFIX: '172.20.9' }).status, 0)
  for (const m of ['0', '1x', '-5']) bad({ BACKUP_MIN_FREE_MIB: m }, 'BACKUP_MIN_FREE_MIB')
  assert.equal(run({ ...good, BACKUP_MIN_FREE_MIB: '256' }).status, 0)
  assert.equal(run({ ...good, PROXY_MODE: 'own', COMPOSE_PROFILES: 'proxy', PROXY_CERTRESOLVER: '' }).status, 0)
  assert.equal(run({ ...good, PROXY_TRAEFIK_MAJOR: '2', COMPOSE_FILE: 'compose.yml:compose.traefik-v2.yml' }).status, 0)
})

rootTest("DOCKER_SOCKET_GID must be the socket's group when that is not 0", () => {
  // inside the control image the socket is not mounted: the documented command passes its group as HOST_DOCKER_SOCKET_GID
  const r = run(good, { extraEnv: { HOST_DOCKER_SOCKET_GID: '998' } })
  assert.equal(r.status, 1)
  assert.match(r.out, /DOCKER_SOCKET_GID: must be 998/)
  assert.equal(run({ ...good, DOCKER_SOCKET_GID: '998' }, { extraEnv: { HOST_DOCKER_SOCKET_GID: '998' } }).status, 0)
  assert.equal(run(good, { extraEnv: { HOST_DOCKER_SOCKET_GID: '0' } }).status, 0)
})

rootTest('the env file must be 0600 and the secret files not world-readable on Linux', { skip: process.platform !== 'linux' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-install-check-'))
  const file = join(dir, '.env')
  writeFileSync(file, Object.entries(good).map(([k, v]) => `${k}=${v}`).join('\n'))
  chmodSync(file, 0o644)
  for (const [name, value] of Object.entries(goodSecrets)) writeFileSync(join(dir, name), value, { mode: 0o644 })
  const r = spawnSync(process.execPath, [script, file, dir], { encoding: 'utf8' })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(r.status, 1)
  assert.match(r.stdout + r.stderr, /0600/)
  assert.match(r.stdout + r.stderr, /master_key: mode/)
})

rootTest('TRUSTED_PROXY_HOSTS takes IP addresses only and PROXY_CONTAINER a plain name', () => {
  // a name would be resolved by DNS, and any container on the network can carry an alias
  const r = run({ ...good, TRUSTED_PROXY_HOSTS: '10.0.0.5,coolify-proxy', PROXY_CONTAINER: 'a/b' })
  assert.equal(r.status, 1)
  assert.match(r.out, /TRUSTED_PROXY_HOSTS: must be comma-separated IP addresses/)
  assert.match(r.out, /PROXY_CONTAINER: must be a plain container name/)
  assert.equal(run({ ...good, TRUSTED_PROXY_HOSTS: '10.0.0.5, fd00::1', PROXY_CONTAINER: 'my-traefik' }).status, 0)
})

test('a secret file must be owned by uid 0 and readable by group SECRETS_GID', { skip: !asRoot }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-install-check-'))
  const file = join(dir, '.env')
  writeFileSync(file, Object.entries(good).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 })
  chmodSync(file, 0o600)
  for (const [name, value] of Object.entries(goodSecrets)) {
    writeFileSync(join(dir, name), value)
    chmodSync(join(dir, name), 0o640)
    chownSync(join(dir, name), 0, 10001)
  }
  const check = () => { const r = spawnSync(process.execPath, [script, file, dir], { encoding: 'utf8' }); return { status: r.status, out: r.stdout + r.stderr } }
  assert.equal(check().status, 0)
  chownSync(join(dir, 'master_key'), 1000, 10001)
  chmodSync(join(dir, 'control_db_password'), 0o600)
  chownSync(join(dir, 'provisioner_token'), 0, 0)
  const r = check()
  rmSync(dir, { recursive: true, force: true })
  assert.equal(r.status, 1)
  assert.match(r.out, /master_key: must be owned by uid 0/)
  assert.match(r.out, /control_db_password: must be group-readable \(0640\)/)
  assert.match(r.out, /provisioner_token: group must be SECRETS_GID 10001/)
  assert.doesNotMatch(r.out, /control_jwt_secret/)
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
