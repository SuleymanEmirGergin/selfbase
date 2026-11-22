// All runtime settings, read once from the environment. A missing or bad value stops startup naming the key
// (never its value).
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

export type Config = ReturnType<typeof loadConfig>

export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export function loadConfig(input: Record<string, string | undefined> = process.env) {
  // secrets come from <KEY>_FILE (compose secrets: not in the container's Config.Env, which a socket proxy's inspect
  // shows); the plain <KEY> is the fallback for development and tests
  const env = { ...input }
  for (const k of ['SELFBASE_MASTER_KEY', 'CONTROL_DB_PASSWORD', 'CONTROL_JWT_SECRET', 'PROVISIONER_TOKEN']) {
    const f = input[`${k}_FILE`]
    if (!f) continue
    try {
      env[k] = readFileSync(f, 'utf8').trim()
    } catch {
      fail(`${k}_FILE cannot be read`)
    }
  }
  const need = (k: string) => env[k] || fail(`${k} is required`)
  const num = (k: string, dflt: number) => {
    const v = env[k]
    if (v === undefined || v === '') return dflt
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : fail(`${k} must be a non-negative number`)
  }
  const oneOf = <T extends string>(k: string, dflt: T, allowed: T[]) => {
    const v = (env[k] || dflt) as T
    return allowed.includes(v) ? v : fail(`${k} must be one of ${allowed.join(', ')}`)
  }

  const masterKeyB64 = need('SELFBASE_MASTER_KEY')
  // canonical base64 of exactly 32 bytes: Buffer.from would silently accept a truncated or padded key
  if (!/^[A-Za-z0-9+/]{43}=$/.test(masterKeyB64)) fail('SELFBASE_MASTER_KEY must be base64 of exactly 32 bytes')
  const jwtSecret = need('CONTROL_JWT_SECRET')
  if (jwtSecret.length < 32) fail('CONTROL_JWT_SECRET must be at least 32 characters')
  const base = need('BASE_DOMAIN')
  const legacyHostnames = (env.LEGACY_HOSTNAMES || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  const publicUrl = env.PUBLIC_URL || `https://selfbase.${base}`
  if (!/^https?:$/.test(URL.parse(publicUrl)?.protocol ?? '') || !URL.parse(publicUrl)?.hostname) fail('PUBLIC_URL must be an http(s) URL with a hostname')
  for (const h of legacyHostnames) if (!HOSTNAME_RE.test(h)) fail('LEGACY_HOSTNAMES must be a comma-separated list of hostnames')
  const proxyMode = oneOf('PROXY_MODE', 'coolify', ['coolify', 'own'])
  const trustedProxyIps = (env.TRUSTED_PROXY_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)
  if (trustedProxyIps.some((h) => !isIP(h))) fail('TRUSTED_PROXY_HOSTS takes IP addresses only (the proxy container is PROXY_CONTAINER)')

  return {
    port: num('PORT', 8080),
    masterKey: Buffer.from(masterKeyB64, 'base64'),
    // DB_HOST/DB_PORT for core's modules are derived from these (db.ts)
    dbHost: env.CONTROL_DB_HOST || 'selfbase-control-db',
    dbPort: num('CONTROL_DB_PORT', 5432),
    dbPassword: need('CONTROL_DB_PASSWORD'),
    jwtSecret,
    provisionerUrl: env.PROVISIONER_URL || 'http://selfbase-provisioner:8090',
    provisionerToken: need('PROVISIONER_TOKEN'),
    baseDomain: base,
    publicUrl,
    nodeName: env.NODE_NAME || 'main',
    proxyMode,
    // proxyMode picks the provisioner's default PROXY_CONTAINER (selfbase-traefik / coolify-proxy)
    // fixed proxy addresses whose X-Forwarded-For counts, besides the proxy container's (from the provisioner, which
    // reads PROXY_CONTAINER by exact name). Addresses only: a name would be resolved by DNS, which is steerable.
    trustedProxyIps,
    proxyNetwork: env.PROXY_NETWORK || 'coolify',
    templateVersion: need('TEMPLATE_VERSION'),
    memoryBudgetMb: num('MEMORY_BUDGET_MB', 16384),
    overcommit: num('OVERCOMMIT', 1.0),
    sharedReservedMb: num('SHARED_RESERVED_MB', 2720),
    jobSlotMb: num('JOB_SLOT_MB', 512),
    projectSubnetPool: env.PROJECT_SUBNET_POOL || '10.207.0.0/16',
    maxNewHostsPerWeek: num('MAX_NEW_HOSTS_PER_WEEK', 3),
    branchHostSlots: num('BRANCH_HOST_SLOTS', 2),
    testHost: env.TEST_HOST || `sb-test.${base}`,
    // hostnames under BASE_DOMAIN that already hold a certificate (v1's host); the only legacy names allowed there
    legacyHostnames,
    certProbe: oneOf('CERT_PROBE', 'on', ['on', 'off']),
    logsUrl: env.LOGS_URL || 'http://selfbase-logs:9428',
    backupRetentionDays: num('BACKUP_RETENTION_DAYS', 7),
    // the host backup directory as control sees it (mounted read-only): an import reads project.json there
    backupDir: env.BACKUP_DIR || '/backups',
    smtp: {
      host: env.SMTP_HOST || '',
      port: num('SMTP_PORT', 587),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.SMTP_FROM || '',
    },
    // empty: no Studio build to serve (API only)
    studioDir: env.STUDIO_DIR || '',
    // core's platform migrations (auth schema); the image copies db/platform here
    platformDir: env.PLATFORM_DIR || fileURLToPath(new URL('../../db/platform', import.meta.url)),
    controlMigrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  }
}

function fail(message: string): never {
  throw new Error(`config: ${message}`)
}

export const config = loadConfig()
