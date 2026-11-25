// All runtime settings, read once from the environment. A missing or bad value stops startup naming the key
// (never its value).
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

export type Config = ReturnType<typeof loadConfig>

// organization slugs as platform-orgs.ts makes them
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
// The last label is never a number, decimal or 0x hex: that is exactly when the WHATWG URL parser reads a name as
// IPv4 (203.0.113.5, 0x7f.0x1) or refuses it (a.0x7f). No TLD looks like one.
export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(?!([0-9]+|0x[0-9a-f]*)$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
// BASE_DOMAIN and TEST_HOST: a hostname, or localhost itself for a local install (REHBER, test/e2e)
const serverHost = (h: string) => h === 'localhost' || HOSTNAME_RE.test(h)
const LABELS_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

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
  const mib = (k: string) => {
    const v = env[k]
    if (v === undefined || v === '') return null
    return /^[1-9]\d{0,7}$/.test(v) ? Number(v) : fail(`${k} must be a whole number of MiB from 1`)
  }
  // whole numbers only: backup.sh refuses anything else, and make_interval(days => 1.5) fails every reconcile pass
  const whole = (k: string, dflt: number, min: 0 | 1, what: string) => {
    const v = env[k]
    if (v === undefined || v === '') return dflt
    return (min ? /^[1-9]\d{0,5}$/ : /^\d{1,6}$/).test(v) ? Number(v) : fail(`${k} must be a whole number ${what}`)
  }
  const oneOf =<T extends string>(k: string, dflt: T, allowed: T[]) => {
    const v = (env[k] || dflt) as T
    return allowed.includes(v) ? v : fail(`${k} must be one of ${allowed.join(', ')}`)
  }

  const masterKeyB64 = need('SELFBASE_MASTER_KEY')
  // canonical base64 of exactly 32 bytes: Buffer.from would silently accept a truncated or padded key
  if (!/^[A-Za-z0-9+/]{43}=$/.test(masterKeyB64)) fail('SELFBASE_MASTER_KEY must be base64 of exactly 32 bytes')
  const jwtSecret = need('CONTROL_JWT_SECRET')
  if (jwtSecret.length < 32) fail('CONTROL_JWT_SECRET must be at least 32 characters')
  const base = need('BASE_DOMAIN')
  if (!serverHost(base)) fail('BASE_DOMAIN must be a lowercase hostname such as example.com')
  // host=org_slug: the name may be added by that organization only; a bare host is the default organization's
  const legacyOrgs: Record<string, string> = {}
  for (const entry of (env.LEGACY_HOSTNAMES || '').split(',').map((h) => h.trim()).filter(Boolean)) {
    const [host, slug = 'default', extra] = entry.split('=')
    if (extra !== undefined || !HOSTNAME_RE.test(host.toLowerCase()) || !SLUG_RE.test(slug)) {
      fail('LEGACY_HOSTNAMES must be a comma-separated list of hostname or hostname=org_slug')
    }
    legacyOrgs[host.toLowerCase()] = slug
  }
  const legacyHostnames = Object.keys(legacyOrgs)
  const testHost = env.TEST_HOST || `sb-test.${base}`
  if (!serverHost(testHost)) fail('TEST_HOST must be a lowercase hostname')
  // as install-check requires; it also keeps TEST_HOST=localhost to a localhost install
  if (testHost !== base && !testHost.endsWith(`.${base}`)) fail('TEST_HOST must sit under BASE_DOMAIN')
  const publicUrl = env.PUBLIC_URL || `https://selfbase.${base}`
  if (!/^https?:$/.test(URL.parse(publicUrl)?.protocol ?? '') || !URL.parse(publicUrl)?.hostname) fail('PUBLIC_URL must be an http(s) URL with a hostname')
  const proxyMode = oneOf('PROXY_MODE', 'coolify', ['coolify', 'own'])
  const trustedProxyIps = (env.TRUSTED_PROXY_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)
  if (trustedProxyIps.some((h) => !isIP(h))) fail('TRUSTED_PROXY_HOSTS takes IP addresses only (the proxy container is PROXY_CONTAINER)')
  // core matches these exactly (core/src/config.ts): plain names (one label too) or addresses, never a pattern or URL
  const outboundAllowHosts = (env.OUTBOUND_ALLOW_HOSTS || '').split(',').map((h) => h.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1'))
    .filter(Boolean)
  if (outboundAllowHosts.some((h) => !isIP(h) && !LABELS_RE.test(h))) {
    fail('OUTBOUND_ALLOW_HOSTS must be a comma-separated list of hostnames or IP addresses')
  }

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
    // the private hosts every project's core may call (a mail relay on the operator's network); a node setting only
    outboundAllowHosts,
    proxyNetwork: env.PROXY_NETWORK || 'coolify',
    templateVersion: need('TEMPLATE_VERSION'),
    memoryBudgetMb: num('MEMORY_BUDGET_MB', 16384),
    overcommit: num('OVERCOMMIT', 1.0),
    sharedReservedMb: num('SHARED_RESERVED_MB', 2720),
    jobSlotMb: num('JOB_SLOT_MB', 512),
    projectSubnetPool: env.PROJECT_SUBNET_POOL || '10.207.0.0/16',
    maxNewHostsPerWeek: num('MAX_NEW_HOSTS_PER_WEEK', 3),
    branchHostSlots: num('BRANCH_HOST_SLOTS', 2),
    testHost,
    // hostnames under BASE_DOMAIN that already hold a certificate (v1's host); the only legacy names allowed there
    legacyHostnames,
    // the organization slug each legacy name belongs to (hosts.ts)
    legacyOrgs,
    certProbe: oneOf('CERT_PROBE', 'on', ['on', 'off']),
    logsUrl: env.LOGS_URL || 'http://selfbase-logs:9428',
    backupRetentionDays: whole('BACKUP_RETENTION_DAYS', 7, 0, 'of days'),
    // backups kept per subdirectory, the newest first (backup.sh)
    backupMaxCount: whole('BACKUP_MAX_COUNT', 14, 1, 'from 1'),
    // the backup volume's free-space floor in MiB, as the provisioner gives the backup jobs; null: 10% or 5 GiB (disk.ts)
    backupMinFreeMib: mib('BACKUP_MIN_FREE_MIB'),
    // days an export is kept: its backups row (reconcile.ts) and, through the backup jobs, its files
    exportRetentionDays: whole('EXPORT_RETENTION_DAYS', 7, 0, 'of days'),
    // a Studio session ends this long after sign-in, or after this long without a refresh (session.ts)
    sessionMaxAgeDays: num('STUDIO_SESSION_MAX_AGE_DAYS', 7),
    sessionIdleHours: num('STUDIO_SESSION_IDLE_HOURS', 24),
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
