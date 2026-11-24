// Pure spec builder: (template, size table, project input, node settings) -> exact Docker payloads.
// Nothing here talks to Docker; ops (Task 7) sends what this returns, unchanged.
//
// buildProject(input: EnsureInput, tpl: Template, sizes: Sizes, node: NodeSettings, proxyIps, isolate) returns
//   networks:   [{ name, body }]   POST /networks/create payloads, the given /27 cut in three (R6):
//               sb-<ref>        base/28: every service at base+2.., jobs from base+8/29 (the tenant network)
//               sb-<ref>-ctl    base+16/29: core at base+18 and control (base+20/30) only; core's admin port
//                               answers this /29 only (PROJECT_SUBNET)
//               sb-<ref>-egress base+24/29: fn alone (EGRESS), its way out (only when the template has fn)
//               isolate (the engine has gateway_mode_ipv4, Docker 28+): sb-<ref> and -ctl are Internal with an
//               isolated gateway, so db, rest and pooler reach neither the internet nor the host
//   volumes:    ['sb-<ref>-<volume>', ...]   every volume the template declares
//   containers: ContainerSpec[] in start order (each after its depends_on)
// buildJob(input: JobInput, node: NodeSettings) returns one ContainerSpec for a one-off job container.
// ContainerSpec = { name, service, body (POST /containers/create payload, name goes in ?name=), specHash,
//   networks (body joins networks[0]; ops connects the rest, i.e. core -> proxy network) }.
// specHash = sha256 of the canonical JSON of body without the selfbase.spec label; it is also that label.
//
// Render variables = input.env without the RESERVED names, plus REGISTRY, TEMPLATE_VERSION, PROJECT_SUBNET
// (node/input), DB_SHARED_BUFFERS, DB_MAX_CONNECTIONS, POOL_SIZE (size table, when set), the sibling addresses
// DB_HOST, PGRST_URL, FN_URL (the services' fixed addresses) and TRUSTED_PROXY_IPS (the proxy's address, ops reads it). A container's Env
// is only its template `environment`, rendered. Every refusal is a ProvisionError thrown before anything is returned.
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { assertRef, containerName, ctlNetworkName, egressNetworkName, networkName, ProvisionError, volumeName } from './names.ts'
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
const RESERVED = ['REGISTRY', 'TEMPLATE_VERSION', 'PROJECT_SUBNET', 'DB_SHARED_BUFFERS', 'DB_MAX_CONNECTIONS', 'POOL_SIZE',
  'DB_HOST', 'PGRST_URL', 'FN_URL', 'TRUSTED_PROXY_IPS']
// below every rule-length priority Traefik gives a foreign router (and above selfbase-paused's 1): a neighbour's
// router for the same host always wins over ours, however many hosts our rule lists
const ROUTER_PRIORITY = '10'

/** Every variable the template reads, set to 'check', for the start-time and --check dry runs. */
export const dryRunEnv = (tpl: Template) => Object.fromEntries([...JSON.stringify(tpl).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)]
  .filter((m) => !RESERVED.includes(m[1])).map((m) => [m[1], 'check']))
const SIZE_NAMES: string[] = ['micro', 'small', 'medium']
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
// a restore reads one backup: <ref>/<ts> or export-<ref>/<ts> (of any project: control checks the org), or the
// operator's drop area for v1 and foreign dumps, import/<org slug>/<name>; never control's own dump
const RESTORE_DIR_RE = /^(export-)?[a-z]{20}\/\d{8}-\d{6}$|^import\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const JOB_TYPES: string[] = ['backup', 'restore', 'clone', 'basebackup', 'volume-copy', 'migra-diff']
const JOB_CMD: Partial<Record<JobType, string[]>> = { backup: ['bash', '/scripts/backup.sh'], restore: ['bash', '/scripts/restore.sh'] }
const JOB_ENV = new Set(['PGHOST', 'PGPASSWORD', 'PGUSER', 'PGDATABASE', 'BACKUP_SUBDIR', 'BACKUP_RETENTION_DAYS', 'EXPORT_RETENTION_DAYS', 'BACKUP_MAX_COUNT', 'RESTORE_DIR', 'MANIFEST_B64', 'CONTROL_GID'])
const JOB_RES: SizeEntry = { mem_mb: 512, cpus: 0.5, pids: 512 }
const NS: Record<string, number> = { ms: 1e6, s: 1e9, m: 6e10, h: 3.6e12 }

const refuse = (status: number, code: string, message?: string): never => {
  throw new ProvisionError(status, code, message)
}

const dotted = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')
// base+2..base+15 are the services' fixed addresses; Docker hands out the upper /28 to everything else (control, jobs)
const MAX_SERVICES = 6
// the services that need a way out (Deno fetch); everything else on sb-<ref> has none where the engine can isolate
const EGRESS = new Set(['fn'])
const ISOLATED = { Internal: true, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' } }

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

function hostConfig(node: NodeSettings, name: string, r: SizeEntry, restart: string, network: string, capDrop: string[]) {
  return {
    // on a shared bridge: the non-root services need no capability; db's entrypoint and jobs run as root (chown, gosu)
    CapDrop: capDrop,
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
    [`traefik.http.routers.${r}.priority`]: ROUTER_PRIORITY,
    [`traefik.http.routers.${r}.entrypoints`]: node.entrypointHttps,
    [`traefik.http.routers.${r}.tls`]: 'true',
    ...(node.certResolver ? { [`traefik.http.routers.${r}.tls.certresolver`]: node.certResolver } : {}),
    [`traefik.http.routers.${r}.service`]: r,
    [`traefik.http.services.${r}.loadbalancer.server.port`]: '8080',
    [`traefik.http.routers.${r}-http.rule`]: rule,
    [`traefik.http.routers.${r}-http.priority`]: ROUTER_PRIORITY,
    [`traefik.http.routers.${r}-http.entrypoints`]: node.entrypointHttp,
    [`traefik.http.routers.${r}-http.middlewares`]: `${r}-redirect`,
    [`traefik.http.routers.${r}-http.service`]: r,
    [`traefik.http.middlewares.${r}-redirect.redirectscheme.scheme`]: 'https',
    [`traefik.http.middlewares.${r}-redirect.redirectscheme.permanent`]: 'true',
  }
}

/** proxyIps: the proxy container's addresses (ops reads them by exact name); core trusts X-Forwarded-For from these only. */
export function buildProject(input: EnsureInput, tpl: Template, sizes: Sizes, node: NodeSettings, proxyIps: string[] = [],
  isolate = false): { networks: { name: string; body: Record<string, unknown> }[]; volumes: string[]; containers: ContainerSpec[] } {
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
  const net = networkName(ref)
  const ctl = ctlNetworkName(ref)
  const egress = egressNetworkName(ref)
  const names = Object.keys(tpl.services)
  if (names.length > MAX_SERVICES) refuse(500, 'template_invalid', `at most ${MAX_SERVICES} services have a fixed address in the tenant /28`)
  const addr: Record<string, string> = Object.fromEntries(names.map((s, i) => [s, dotted(sub.base + 2 + i)]))
  const outbound = names.filter((s) => EGRESS.has(s))
  // Siblings by address only: core is also on the proxy network, where Docker's DNS answers a name or alias any
  // container there carries (db.sb-<ref> included) before the project network's own service. Bare names in the
  // template go to /etc/hosts (ExtraHosts), which is read before Docker's DNS.
  const extraHosts = names.map((s) => `${s}:${addr[s]}`)
  Object.assign(env, {
    ...(addr.db ? { DB_HOST: addr.db } : {}),
    ...(addr.rest ? { PGRST_URL: `http://${addr.rest}:3000` } : {}),
    ...(addr.fn ? { FN_URL: `http://${addr.fn}:8000` } : {}),
    TRUSTED_PROXY_IPS: proxyIps.filter((a) => isIP(a)).join(','),
    REGISTRY: node.registry,
    TEMPLATE_VERSION: templateVersion,
    PROJECT_SUBNET: `${dotted(sub.base + 16)}/29`,
    ...(db?.shared_buffers !== undefined ? { DB_SHARED_BUFFERS: db.shared_buffers } : {}),
    ...(db?.max_connections !== undefined ? { DB_MAX_CONNECTIONS: String(db.max_connections) } : {}),
    ...(pooler?.pool_size !== undefined ? { POOL_SIZE: String(pooler.pool_size) } : {}),
  })
  // a variable the caller left out of env is the caller's error (400); any other render error is the template's (500)
  const rendered = (v: string) => {
    try { return render(v, env) } catch (e) { throw e instanceof MissingVarError ? new ProvisionError(400, 'invalid_env', e.message) : e }
  }

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
        ...hostConfig(node, name, r, 'unless-stopped', net, service === 'db' ? ['NET_RAW'] : ['ALL']),
        Mounts: s.volumes.map((v) => ({ Type: 'volume', Source: volumeName(ref, v.name), Target: v.path, ReadOnly: v.readOnly })),
        ...(r.shm_mb ? { ShmSize: r.shm_mb * MiB } : {}),
        ...(s.init ? { Init: true } : {}),
        ExtraHosts: extraHosts,
      },
      NetworkingConfig: { EndpointsConfig: {
        [net]: { Aliases: [service], IPAMConfig: { IPv4Address: addr[service] } },
        ...(service === 'core' ? { [ctl]: { Aliases: [service], IPAMConfig: { IPv4Address: dotted(sub.base + 18) } } } : {}),
        ...(EGRESS.has(service) ? { [egress]: { Aliases: [service], IPAMConfig: { IPv4Address: dotted(sub.base + 26 + outbound.indexOf(service)) } } } : {}),
      } },
    }
    return seal(name, service, body, service === 'core' ? [net, ctl, node.proxyNetwork] : EGRESS.has(service) ? [net, egress] : [net])
  })

  // each gateway is pinned to its range's first address (with IPRange set Docker would take the range's first)
  const network = (name: string, at: number, prefix: number, range: string | null, internal: boolean) => ({ name, body: {
    Name: name, Driver: 'bridge', ...(internal ? ISOLATED : {}),
    IPAM: { Driver: 'default', Config: [{ Subnet: `${dotted(sub.base + at)}/${prefix}`, ...(range ? { IPRange: range } : {}), Gateway: dotted(sub.base + at + 1) }] },
    Labels: { 'selfbase.managed': 'true', 'selfbase.project': ref } } })
  return {
    networks: [network(net, 0, 28, `${dotted(sub.base + 8)}/29`, isolate), network(ctl, 16, 29, `${dotted(sub.base + 20)}/30`, isolate),
      ...(outbound.length ? [network(egress, 24, 29, null, false)] : [])],
    volumes: tpl.volumes.map((v) => volumeName(ref, v)),
    containers,
  }
}

// R5: a backup writes only into its own ref's directory (export-<ref> for an export, control for control's)
function checkDir(ref: string, dir: unknown, restore: boolean): string {
  const ok = typeof dir === 'string' && (restore
    ? RESTORE_DIR_RE.test(dir) && !dir.split('/').some((p) => p === '.' || p === '..')
    : ref === 'control' ? dir === 'control' : dir === ref || dir === `export-${ref}`)
  if (!ok) {
    refuse(400, 'invalid_dir', restore ? 'dir must be <ref>/<ts>, export-<ref>/<ts> or import/<a>/<b>' : `dir must be ${ref === 'control' ? 'control' : `${ref} or export-${ref}`}`)
  }
  return dir as string
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
  const key = type === 'backup' ? 'BACKUP_SUBDIR' : 'RESTORE_DIR'
  if (args.dir !== undefined) env[key] = args.dir
  // the other job's directory key would only confuse the script
  if (Object.hasOwn(env, type === 'backup' ? 'RESTORE_DIR' : 'BACKUP_SUBDIR')) refuse(400, 'invalid_dir', `a ${type} job takes no ${type === 'backup' ? 'RESTORE_DIR' : 'BACKUP_SUBDIR'}`)
  const dir = checkDir(ref, env[key], type === 'restore')

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
      ...hostConfig(node, name, JOB_RES, 'no', net, ['NET_RAW']),
      Init: true,
      // the only bind mount the provisioner ever writes (AC-11), and only the job's own directory of it (R5): a backup
      // never sees another org's or control's backups, a restore reads its one backup and cannot change it
      Mounts: [{ Type: 'bind', Source: `${node.backupHostDir}/${dir}`, Target: `/backups/${dir}`,
        ...(type === 'restore' ? { ReadOnly: true } : { BindOptions: { CreateMountpoint: true } }) }, ...storage],
    },
    NetworkingConfig: { EndpointsConfig: { [net]: {} } },
  }
  return seal(name, service, body, [net])
}
