#!/usr/bin/env node
// Checks the control stack's env file and secret files before the first start (plan Task 17), as root (both are
// root-only) and with the host socket's group (the socket is not mounted):
//   docker run --rm --user 0 --network none -e HOST_DOCKER_SOCKET_GID=$(stat -c %g /var/run/docker.sock) \
//     -v /opt/selfbase/.env:/env:ro -v /opt/selfbase/secrets:/secrets:ro <control image> \
//     node /app/scripts/install-check.mjs /env /secrets
// One line per problem, naming the key or file and never a value; exit 1 when there is any. Standard library only.
// `--keys` prints the known keys as JSON (tests compare them with control/.env.example and the compose files).
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REQUIRED = ['BASE_DOMAIN', 'REGISTRY', 'TEMPLATE_VERSION', 'PROXY_MODE', 'PROXY_NETWORK', 'BACKUP_HOST_DIR']
// compose secrets (SECRETS_DIR/<file>), never env: a container's Config.Env is readable by a socket proxy's inspect
const SECRET_FILES = { SELFBASE_MASTER_KEY: 'master_key', CONTROL_DB_PASSWORD: 'control_db_password',
  CONTROL_JWT_SECRET: 'control_jwt_secret', PROVISIONER_TOKEN: 'provisioner_token' }
const OPTIONAL = ['PROJECT_SUBNET_POOL', 'SECRETS_DIR', 'SECRETS_GID', 'TRUSTED_PROXY_HOSTS',
  'PUBLIC_URL', 'TEST_HOST', 'NODE_NAME', 'LEGACY_HOSTNAMES', 'MEMORY_BUDGET_MB', 'OVERCOMMIT', 'SHARED_RESERVED_MB',
  'JOB_SLOT_MB', 'MAX_NEW_HOSTS_PER_WEEK', 'BRANCH_HOST_SLOTS', 'CERT_PROBE', 'BACKUP_RETENTION_DAYS', 'SMTP_HOST', 'SMTP_PORT',
  'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'AUTH_RATE_LIMIT_SIGN_IN', 'PROXY_ENTRYPOINT_HTTP', 'PROXY_ENTRYPOINT_HTTPS',
  'PROXY_CERTRESOLVER', 'PROXY_TRAEFIK_MAJOR', 'LOG_SYSLOG_ADDR', 'CGROUP_PARENT', 'DOCKER_SOCKET_GID', 'PROXY_HTTP_PORT',
  'PROXY_HTTPS_PORT', 'ACME_EMAIL', 'COMPOSE_PROFILES', 'COMPOSE_FILE']

const [arg, secretsDir] = process.argv.slice(2)
if (arg === '--keys') {
  console.log(JSON.stringify([...REQUIRED, ...OPTIONAL]))
  process.exit(0)
}
if (!arg || !secretsDir) {
  console.error('usage: install-check.mjs <env file> <secrets dir>')
  process.exit(1)
}

let text
try {
  text = readFileSync(arg, 'utf8')
} catch {
  console.error(`install-check: cannot read ${arg}`)
  process.exit(1)
}
const env = {}
for (const line of text.split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
  if (!m || /^\s*#/.test(line)) continue
  // compose: surrounding quotes are not part of the value, and " #" after a value (or its closing quote) starts a comment
  const value = m[2].trim()
  const quoted = /^(["'])(.*?)\1(\s+#.*)?$/.exec(value)
  env[m[1]] = quoted ? quoted[2] : value.replace(/\s+#.*$/, '')
}

const problems = []
const bad = (key, why) => problems.push(`${key}: ${why}`)
const known = new Set([...REQUIRED, ...OPTIONAL])
for (const k of Object.keys(env)) {
  if (SECRET_FILES[k]) bad(k, `belongs in the secret file ${SECRET_FILES[k]} (compose secrets), not the env file`)
  else if (!known.has(k)) bad(k, 'unknown key')
}
for (const k of REQUIRED) if (!env[k]) bad(k, 'required, missing or empty')

const v = (k) => env[k] ?? ''
const secretsGid = v('SECRETS_GID') || '10001'
if (!/^\d+$/.test(secretsGid)) bad('SECRETS_GID', 'must be a numeric group id')
const linux = process.platform === 'linux'
for (const [key, name] of Object.entries(SECRET_FILES)) {
  const path = join(secretsDir, name)
  let text
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch {
    bad(name, 'missing or unreadable')
    continue
  }
  if (!text) bad(name, 'empty')
  else if (key === 'SELFBASE_MASTER_KEY' && !/^[A-Za-z0-9+/]{43}=$/.test(text)) bad(name, 'must be base64 of exactly 32 bytes')
  else if (key !== 'SELFBASE_MASTER_KEY' && key !== 'CONTROL_DB_PASSWORD' && text.length < 32) bad(name, 'must be at least 32 characters')
  // control and the provisioner read it as group SECRETS_GID (compose bind-mounts the file with its host mode)
  const st = statSync(path)
  if (linux && ((st.mode & 0o037) !== 0 || String(st.gid) !== secretsGid)) bad(name, `mode must be 0640 root:${secretsGid} (gen-keys.mjs --secrets)`)
}
// SECRETS_DIR as compose sees it on the host (the check reads the directory mounted at its second argument)
if (v('SECRETS_DIR') && (!/^\/opt\/selfbase(\/[A-Za-z0-9._-]+)+$/.test(v('SECRETS_DIR')) || /\/\.\.?(\/|$)/.test(v('SECRETS_DIR')))) {
  bad('SECRETS_DIR', 'must be a directory under /opt/selfbase/')
}
// the socket's group: stat'ed when this runs on the host, else passed by the documented docker run
let socketGid = process.env.HOST_DOCKER_SOCKET_GID
try { socketGid ??= String(statSync('/var/run/docker.sock').gid) } catch {}
if (socketGid && socketGid !== '0' && v('DOCKER_SOCKET_GID') !== socketGid) bad('DOCKER_SOCKET_GID', `must be ${socketGid}, the group of /var/run/docker.sock`)

const pool = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(v('PROJECT_SUBNET_POOL'))
if (v('PROJECT_SUBNET_POOL')) {
  const octets = pool ? pool.slice(1, 5).map(Number) : []
  const prefix = pool ? Number(pool[5]) : 99
  const addr = octets.reduce((a, o) => a * 256 + o, 0)
  const network = prefix === 0 ? 0 : (addr & ((0xffffffff << (32 - prefix)) >>> 0)) >>> 0
  if (!pool || octets.some((o) => o > 255) || prefix > 16 || network !== addr) bad('PROJECT_SUBNET_POOL', 'must be an IPv4 network address of a /16 or larger')
}

const base = v('BASE_DOMAIN').toLowerCase()
const under = (host) => host === base || host.endsWith(`.${base}`)
if (v('TEST_HOST') && base && !under(v('TEST_HOST').toLowerCase())) bad('TEST_HOST', 'must end with BASE_DOMAIN')
if (v('PUBLIC_URL') && base && !under(URL.parse(v('PUBLIC_URL'))?.hostname ?? '')) bad('PUBLIC_URL', 'must be an http(s) URL whose host ends with BASE_DOMAIN')

const mode = v('PROXY_MODE')
if (mode && mode !== 'coolify' && mode !== 'own') bad('PROXY_MODE', 'must be coolify or own')
if (mode === 'coolify' && !v('PROXY_CERTRESOLVER')) bad('PROXY_CERTRESOLVER', "required with PROXY_MODE=coolify (Coolify's is letsencrypt)")
const profiles = v('COMPOSE_PROFILES').split(',').map((s) => s.trim())
if (mode === 'own' && !profiles.includes('proxy')) bad('COMPOSE_PROFILES', 'must include proxy with PROXY_MODE=own (starts our Traefik)')
if (mode === 'coolify' && profiles.includes('proxy')) bad('COMPOSE_PROFILES', 'must not include proxy with PROXY_MODE=coolify')
if (mode === 'own') {
  for (const [k, name] of [['PROXY_ENTRYPOINT_HTTP', 'http'], ['PROXY_ENTRYPOINT_HTTPS', 'https']]) {
    if (v(k) && v(k) !== name) bad(k, `must be ${name} (or empty) with PROXY_MODE=own`)
  }
}
const major = v('PROXY_TRAEFIK_MAJOR')
if (major && major !== '2' && major !== '3') bad('PROXY_TRAEFIK_MAJOR', 'must be 2 or 3')
if (major === '2' && !v('COMPOSE_FILE').split(/[:;]/).some((f) => f.endsWith('compose.traefik-v2.yml'))) {
  bad('COMPOSE_FILE', 'must add compose.traefik-v2.yml with PROXY_TRAEFIK_MAJOR=2 (e.g. compose.yml:compose.traefik-v2.yml)')
}
// shared-host rule: our only host paths live under /opt/selfbase (the provisioner refuses others too)
if (v('BACKUP_HOST_DIR') && (!/^\/opt\/selfbase(\/[A-Za-z0-9._-]+)+$/.test(v('BACKUP_HOST_DIR')) || /\/\.\.?(\/|$)/.test(v('BACKUP_HOST_DIR')))) {
  bad('BACKUP_HOST_DIR', 'must be a directory under /opt/selfbase/')
}
if (linux && (statSync(arg).mode & 0o777) !== 0o600) problems.push(`${arg}: mode must be 0600 (it holds SMTP_PASS and the host layout)`)

for (const p of problems) console.log(p)
if (problems.length) process.exit(1)
console.log('install-check: ok')
