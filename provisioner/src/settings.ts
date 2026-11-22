// Node settings, read once from the environment at start (loadSettings). A bad value stops startup.
import { ProvisionError } from './names.ts'

export type NodeSettings = { registry: string; templateVersion: string; proxyNetwork: string; entrypointHttp: string
  entrypointHttps: string; certResolver: string; logSyslogAddr: string; cgroupParent: string; backupHostDir: string
  subnetPool: string; controlContainer: string; controlNetwork: string }

export const VERSION_RE = /^[0-9A-Za-z._-]{1,64}$/
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const CIDR_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}/(3[0-2]|[12]?\\d)$`)

// IPv4 network in CIDR form; the address must be the network address of its prefix.
export function parseCidr(cidr: unknown): { base: number; prefix: number; mask: number } {
  const m = typeof cidr === 'string' ? CIDR_RE.exec(cidr) : null
  if (!m) throw new ProvisionError(400, 'invalid_subnet', 'subnet must be an IPv4 CIDR')
  const base = m.slice(1, 5).reduce((a, o) => a * 256 + Number(o), 0)
  const prefix = Number(m[5])
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  if (((base & mask) >>> 0) !== base) throw new ProvisionError(400, 'invalid_subnet', 'subnet is not a network address')
  return { base, prefix, mask }
}

export function loadSettings(env: Record<string, string | undefined> = process.env): NodeSettings {
  const need = (k: string) => env[k] || fail(`${k} is required`)
  const s: NodeSettings = {
    registry: need('REGISTRY'),
    templateVersion: need('TEMPLATE_VERSION'),
    proxyNetwork: env.PROXY_NETWORK ?? 'coolify',
    entrypointHttp: env.PROXY_ENTRYPOINT_HTTP ?? 'http',
    entrypointHttps: env.PROXY_ENTRYPOINT_HTTPS ?? 'https',
    certResolver: env.PROXY_CERTRESOLVER ?? 'letsencrypt',
    logSyslogAddr: env.LOG_SYSLOG_ADDR ?? '',
    cgroupParent: env.CGROUP_PARENT ?? '',
    backupHostDir: env.BACKUP_HOST_DIR ?? '',
    subnetPool: env.PROJECT_SUBNET_POOL ?? '10.207.0.0/16',
    controlContainer: env.CONTROL_CONTAINER ?? 'selfbase-control',
    controlNetwork: env.CONTROL_NETWORK ?? 'selfbase',
  }
  if (!/^[a-z0-9]+([._:/-][a-z0-9]+)*$/.test(s.registry)) fail('REGISTRY is not a registry path')
  if (!VERSION_RE.test(s.templateVersion)) fail('TEMPLATE_VERSION is not a version')
  // socket-proxy.env puts it into a regex unescaped
  if (!/^[A-Za-z0-9_-]+$/.test(s.proxyNetwork)) fail('PROXY_NETWORK must be a plain network name [A-Za-z0-9_-]+')
  // these become NetworkMode and network names: never a host namespace or another container's (`container:x`)
  for (const [k, v] of [['PROXY_NETWORK', s.proxyNetwork], ['CONTROL_NETWORK', s.controlNetwork], ['CONTROL_CONTAINER', s.controlContainer]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v) || ['host', 'none', 'bridge', 'default'].includes(v)) fail(`${k} must be a plain user-defined name`)
  }
  // the only bind mount source (AC-11): under /opt/selfbase (shared-host rule), never a system path
  if (s.backupHostDir && (!/^\/opt\/selfbase(\/[A-Za-z0-9._-]+)+$/.test(s.backupHostDir) || /\/\.\.?(\/|$)/.test(s.backupHostDir))) {
    fail('BACKUP_HOST_DIR must be a directory under /opt/selfbase/')
  }
  if (s.cgroupParent && !/^[A-Za-z0-9_-]+\.slice$/.test(s.cgroupParent)) fail('CGROUP_PARENT must be a slice name like selfbase.slice')
  if (s.logSyslogAddr && !/^(udp|tcp):\/\/[A-Za-z0-9.-]+:\d{1,5}$/.test(s.logSyslogAddr)) fail('LOG_SYSLOG_ADDR must be udp://host:port or tcp://host:port')
  for (const [k, v] of [['PROXY_ENTRYPOINT_HTTP', s.entrypointHttp], ['PROXY_ENTRYPOINT_HTTPS', s.entrypointHttps], ['PROXY_CERTRESOLVER', s.certResolver]]) {
    if (!/^[A-Za-z0-9_-]*$/.test(v)) fail(`${k} must be a plain Traefik name`)
  }
  parseCidr(s.subnetPool)
  return s
}

function fail(message: string): never {
  throw new Error(`settings: ${message}`)
}
