// Pure spec builder: (template, size table, project input, node settings) -> exact Docker payloads.
// Nothing here talks to Docker; ops (Task 7) sends what this returns, unchanged.
//
// buildProject(input: EnsureInput, tpl: Template, sizes: Sizes, node: NodeSettings) returns
//   network:    { name: 'sb-<ref>', body }   body = POST /networks/create payload (bridge, the given /27)
//   volumes:    ['sb-<ref>-<volume>', ...]   every volume the template declares
//   containers: ContainerSpec[] in start order (each after its depends_on)
// buildJob(input: JobInput, node: NodeSettings) returns one ContainerSpec for a one-off job container.
// ContainerSpec = { name, service, body (POST /containers/create payload, name goes in ?name=), specHash,
//   networks (body joins networks[0]; ops connects the rest, i.e. core -> proxy network) }.
// specHash = sha256 of the canonical JSON of body without the selfbase.spec label; it is also that label.
//
// Render variables = input.env without the RESERVED names, plus REGISTRY, TEMPLATE_VERSION, PROJECT_SUBNET
// (node/input) and DB_SHARED_BUFFERS, DB_MAX_CONNECTIONS, POOL_SIZE (size table, when set). A container's Env
// is only its template `environment`, rendered. Every refusal is a ProvisionError thrown before anything is returned.
import { createHash } from 'node:crypto'
import { assertRef, containerName, networkName, ProvisionError, volumeName } from './names.ts'
import { parseCidr, VERSION_RE, type NodeSettings } from './settings.ts'
import { ENV_KEY_RE, isObj, MissingVarError, render, startOrder, type Template } from './template.ts'

export type Size = 'micro' | 'small' | 'medium'
export type SizeEntry = { mem_mb: number; cpus: number; pids: number; shm_mb?: number; shared_buffers?: string
  max_connections?: number; pool_size?: number }
export type Sizes = Record<Size, Record<string, SizeEntry>>
export type EnsureInput = { ref: string; templateVersion: string; size: Size; subnet: string; hosts: string[]
  env: Record<string, string> }
export type JobType = 'backup' | 'restore' | 'clone' | 'basebackup' | 'volume-copy' | 'migra-diff'
export type JobInput = { ref: string | 'control'; type: JobType; args: { dir?: string }; env: Record<string, string> }
export type ContainerSpec = { name: string; service: string; body: Record<string, unknown>; specHash: string
  networks: string[] }

const MiB = 1024 * 1024
const MAX_ENV_VALUE = 64 * 1024
// default + legacy + custom domains of one project; each new one can cost a certificate (Task 11 caps new hosts)
const MAX_HOSTS = 10
// render variables only the provisioner sets; a project env value for one of them is dropped
const RESERVED = ['REGISTRY', 'TEMPLATE_VERSION', 'PROJECT_SUBNET', 'DB_SHARED_BUFFERS', 'DB_MAX_CONNECTIONS', 'POOL_SIZE']

/** Every variable the template reads, set to 'check', for the start-time and --check dry runs. */
export const dryRunEnv = (tpl: Template) => Object.fromEntries([...JSON.stringify(tpl).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)]
  .filter((m) => !RESERVED.includes(m[1])).map((m) => [m[1], 'check']))
const SIZE_NAMES: string[] = ['micro', 'small', 'medium']
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const DIR_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/
const JOB_TYPES: string[] = ['backup', 'restore', 'clone', 'basebackup', 'volume-copy', 'migra-diff']
const JOB_CMD: Partial<Record<JobType, string[]>> = { backup: ['bash', '/scripts/backup.sh'], restore: ['bash', '/scripts/restore.sh'] }
const JOB_ENV = new Set(['PGHOST', 'PGPASSWORD', 'PGUSER', 'PGDATABASE', 'BACKUP_SUBDIR', 'BACKUP_RETENTION_DAYS', 'RESTORE_DIR', 'MANIFEST_B64'])
const JOB_RES: SizeEntry = { mem_mb: 512, cpus: 0.5, pids: 512 }
const NS: Record<string, number> = { ms: 1e6, s: 1e9, m: 6e10, h: 3.6e12 }

const refuse = (status: number, code: string, message?: string): never => {
  throw new ProvisionError(status, code, message)
}

const ns = (d: string) => [...d.matchAll(/(\d+)(ms|s|m|h)/g)].reduce((t, [, n, u]) => t + Number(n) * NS[u], 0)

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isObj(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

// Names that are a plain identifier (no `=`, no NUL); values a string of at most 64 KiB without NUL.
function stringMap(v: unknown): Record<string, string> {
  if (!isObj(v)) refuse(400, 'invalid_env', 'env must map names to strings')
  for (const [k, x] of Object.entries(v as object)) {
    if (!ENV_KEY_RE.test(k)) refuse(400, 'invalid_env', 'env names must match [A-Za-z_][A-Za-z0-9_]*')
    if (typeof x !== 'string' || x.includes('\0') || Buffer.byteLength(x) > MAX_ENV_VALUE) {
      refuse(400, 'invalid_env', `env ${k} must be a string of at most 64 KiB without NUL`)
    }
  }
  return { ...(v as Record<string, string>) }
}

function hostConfig(node: NodeSettings, name: string, r: SizeEntry, restart: string, network: string) {
  return {
    Memory: r.mem_mb * MiB,
    MemorySwap: r.mem_mb * MiB,
    NanoCpus: Math.round(r.cpus * 1e9),
    PidsLimit: r.pids,
    SecurityOpt: ['no-new-privileges:true'],
    RestartPolicy: { Name: restart },
    NetworkMode: network,
    ...(node.cgroupParent ? { CgroupParent: node.cgroupParent } : {}),
    LogConfig: node.logSyslogAddr
      ? { Type: 'syslog', Config: { 'syslog-address': node.logSyslogAddr, 'syslog-format': 'rfc5424', tag: name, mode: 'non-blocking' } }
      : { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
  }
}

function seal(name: string, service: string, body: Record<string, unknown>, networks: string[]): ContainerSpec {
  const specHash = createHash('sha256').update(canonical(body)).digest('hex')
  ;(body.Labels as Record<string, string>)['selfbase.spec'] = specHash
  return { name, service, body, specHash, networks }
}

const baseLabels = (ref: string, service: string, templateVersion: string): Record<string, string> => ({
  'selfbase.managed': 'true', 'selfbase.project': ref, 'selfbase.service': service, 'selfbase.template': templateVersion,
})

// Spec 7.3; every router, service and middleware is named sb-<ref>[-...] so it cannot collide with another's.
function traefikLabels(ref: string, hosts: string[], node: NodeSettings): Record<string, string> {
  const r = `sb-${ref}`
  const rule = hosts.map((h) => `Host(\`${h}\`)`).join(' || ')
  return {
    'traefik.enable': 'true',
    'traefik.docker.network': node.proxyNetwork,
    [`traefik.http.routers.${r}.rule`]: rule,
    [`traefik.http.routers.${r}.entrypoints`]: node.entrypointHttps,
    [`traefik.http.routers.${r}.tls`]: 'true',
    ...(node.certResolver ? { [`traefik.http.routers.${r}.tls.certresolver`]: node.certResolver } : {}),
    [`traefik.http.routers.${r}.service`]: r,
    [`traefik.http.services.${r}.loadbalancer.server.port`]: '8080',
    [`traefik.http.routers.${r}-http.rule`]: rule,
    [`traefik.http.routers.${r}-http.entrypoints`]: node.entrypointHttp,
    [`traefik.http.routers.${r}-http.middlewares`]: `${r}-redirect`,
    [`traefik.http.routers.${r}-http.service`]: r,
    [`traefik.http.middlewares.${r}-redirect.redirectscheme.scheme`]: 'https',
    [`traefik.http.middlewares.${r}-redirect.redirectscheme.permanent`]: 'true',
  }
}

export function buildProject(input: EnsureInput, tpl: Template, sizes: Sizes, node: NodeSettings):
  { network: { name: string; body: Record<string, unknown> }; volumes: string[]; containers: ContainerSpec[] } {
  const { ref, templateVersion, size, subnet, hosts } = input
  assertRef(ref)
  if (typeof templateVersion !== 'string' || !VERSION_RE.test(templateVersion)) refuse(400, 'invalid_template_version')
  if (!SIZE_NAMES.includes(size) || !Object.hasOwn(sizes, size)) refuse(400, 'invalid_size')
  const sub = parseCidr(subnet)
  const pool = parseCidr(node.subnetPool)
  if (sub.prefix !== 27 || pool.prefix > 27 || ((sub.base & pool.mask) >>> 0) !== pool.base) {
    refuse(400, 'invalid_subnet', `subnet must be a /27 inside ${node.subnetPool}`)
  }
  if (!Array.isArray(hosts) || !hosts.length || hosts.length > MAX_HOSTS || !hosts.every((h) => typeof h === 'string' && h.length <= 253 && HOST_RE.test(h))) {
    refuse(400, 'invalid_host', `hosts must be 1..${MAX_HOSTS} lowercase DNS names`)
  }
  const table = sizes[size]
  const res = (service: string) => {
    const r = Object.hasOwn(table, service) ? table[service] : refuse(500, 'size_missing', `sizes.${size}.${service} is missing`)
    const bad = (k: string, why: string) => refuse(500, 'size_invalid', `sizes.${size}.${service}${k} ${why}`)
    if (!isObj(r)) bad('', 'must be an object')
    // Docker reads 0, null or a negative value as "no limit"; limits are whole numbers, cpus at least 0.01
    const int = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0
    for (const k of ['mem_mb', 'pids'] as const) if (!int(r[k])) bad(`.${k}`, 'must be a whole number > 0')
    if (typeof r.cpus !== 'number' || !(r.cpus >= 0.01 && r.cpus <= 1024)) bad('.cpus', 'must be a number from 0.01')
    if (r.shm_mb !== undefined && !int(r.shm_mb)) bad('.shm_mb', 'must be a whole number > 0')
    // these become db command arguments and the pooler config
    if (r.shared_buffers !== undefined && !(typeof r.shared_buffers === 'string' && /^[1-9]\d{0,6}(kB|MB|GB)$/.test(r.shared_buffers))) {
      bad('.shared_buffers', 'must be like 128MB')
    }
    for (const k of ['max_connections', 'pool_size'] as const) if (r[k] !== undefined && !int(r[k])) bad(`.${k}`, 'must be a whole number > 0')
    return r
  }
  const db = Object.hasOwn(table, 'db') ? res('db') : undefined
  const pooler = Object.hasOwn(table, 'pooler') ? res('pooler') : undefined
  const env = stringMap(input.env)
  const dropped = RESERVED.filter((k) => Object.hasOwn(env, k))
  for (const k of dropped) delete env[k]
  // names only: the values are control's and may be secrets
  if (dropped.length) console.warn(`provisioner: ${ref}: ignored provisioner-set env names from the request: ${dropped.join(', ')}`)
  Object.assign(env, {
    REGISTRY: node.registry,
    TEMPLATE_VERSION: templateVersion,
    PROJECT_SUBNET: subnet,
    ...(db?.shared_buffers !== undefined ? { DB_SHARED_BUFFERS: db.shared_buffers } : {}),
    ...(db?.max_connections !== undefined ? { DB_MAX_CONNECTIONS: String(db.max_connections) } : {}),
    ...(pooler?.pool_size !== undefined ? { POOL_SIZE: String(pooler.pool_size) } : {}),
  })
  // a variable the caller left out of env is the caller's error (400); any other render error is the template's (500)
  const rendered = (v: string) => {
    try { return render(v, env) } catch (e) { throw e instanceof MissingVarError ? new ProvisionError(400, 'invalid_env', e.message) : e }
  }

  const net = networkName(ref)
  const containers = startOrder(tpl.services).map((service) => {
    const s = tpl.services[service]
    const r = res(service)
    const name = containerName(ref, service)
    const image = rendered(s.image)
    if (image !== `${node.registry}/selfbase-${service}:${templateVersion}`) {
      refuse(500, 'image_refused', `${service}: image must be ${node.registry}/selfbase-${service}:${templateVersion}`)
    }
    const hc = s.healthcheck
    const body: Record<string, unknown> = {
      Image: image,
      Env: Object.entries(s.environment).map(([k, v]) => `${k}=${rendered(v)}`),
      ...(s.command ? { Cmd: s.command.map(rendered) } : {}),
      ...(s.user !== undefined ? { User: rendered(s.user) } : {}),
      ...(s.stop_grace_period ? { StopTimeout: Math.ceil(ns(s.stop_grace_period) / 1e9) } : {}),
      ...(hc ? { Healthcheck: { Test: hc.test.map(rendered), Interval: hc.interval && ns(hc.interval),
        Timeout: hc.timeout && ns(hc.timeout), Retries: hc.retries, StartPeriod: hc.start_period && ns(hc.start_period) } } : {}),
      Labels: { ...baseLabels(ref, service, templateVersion), ...(service === 'core' ? traefikLabels(ref, hosts, node) : {}) },
      HostConfig: {
        ...hostConfig(node, name, r, 'unless-stopped', net),
        Mounts: s.volumes.map((v) => ({ Type: 'volume', Source: volumeName(ref, v.name), Target: v.path, ReadOnly: v.readOnly })),
        ...(r.shm_mb ? { ShmSize: r.shm_mb * MiB } : {}),
        ...(s.init ? { Init: true } : {}),
      },
      NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [service] } } },
    }
    return seal(name, service, body, service === 'core' ? [net, node.proxyNetwork] : [net])
  })

  return {
    network: { name: net, body: { Name: net, Driver: 'bridge', IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] },
      Labels: { 'selfbase.managed': 'true', 'selfbase.project': ref } } },
    volumes: tpl.volumes.map((v) => volumeName(ref, v)),
    containers,
  }
}

function checkDir(dir: unknown) {
  if (typeof dir !== 'string' || !DIR_RE.test(dir) || dir.split('/').some((p) => p === '.' || p === '..')) {
    refuse(400, 'invalid_dir', 'dir must be one or two plain path segments')
  }
}

// Jobs run for a project ref, or for the control stack itself ('control'), which only ever backs up.
export function assertJobRef(ref: unknown, type: unknown) {
  if (ref !== 'control') assertRef(ref)
  else if (type !== 'backup') refuse(400, 'invalid_ref', "ref 'control' is only allowed for backup jobs")
}

export function buildJob(input: JobInput, node: NodeSettings): ContainerSpec {
  const { ref, type } = input
  assertJobRef(ref, type)
  if (!JOB_TYPES.includes(type)) refuse(400, 'invalid_job_type')
  const cmd = JOB_CMD[type] ?? refuse(501, 'not_implemented', `job type ${type} is not implemented`)
  if (!node.backupHostDir) refuse(409, 'backup_dir_unset', 'no backup host directory is configured')
  const args = input.args ?? {}
  if (!isObj(args) || Object.keys(args).some((k) => k !== 'dir')) refuse(400, 'invalid_args', 'args may only carry dir')
  const env = { ...stringMap(input.env) }
  for (const k of Object.keys(env)) if (!JOB_ENV.has(k)) refuse(400, 'invalid_env', `env key ${k} is not allowed`)
  if (args.dir !== undefined) env[type === 'backup' ? 'BACKUP_SUBDIR' : 'RESTORE_DIR'] = args.dir
  for (const k of ['BACKUP_SUBDIR', 'RESTORE_DIR']) if (Object.hasOwn(env, k)) checkDir(env[k])

  const service = `job-${type}`
  const name = containerName(ref, service)
  const net = ref === 'control' ? node.controlNetwork : networkName(ref)
  const storage = ref === 'control' ? []
    : [{ Type: 'volume', Source: volumeName(ref, 'storage'), Target: '/data/storage', ReadOnly: type === 'backup' }]
  const body: Record<string, unknown> = {
    Image: `${node.registry}/selfbase-job:${node.templateVersion}`,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Cmd: cmd,
    Labels: baseLabels(ref, service, node.templateVersion),
    HostConfig: {
      ...hostConfig(node, name, JOB_RES, 'no', net),
      Init: true,
      // the only bind mount the provisioner ever writes (AC-11)
      Mounts: [{ Type: 'bind', Source: node.backupHostDir, Target: '/backups' }, ...storage],
    },
    NetworkingConfig: { EndpointsConfig: { [net]: {} } },
  }
  return seal(name, service, body, [net])
}
