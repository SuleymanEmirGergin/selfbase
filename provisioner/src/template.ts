// The project template: template/compose.yml baked to JSON at image build (scripts/bake-template.mjs, D-3),
// validated here as a strict subset of compose (AC-4). Anything not listed below is refused, naming the key.
//   top level:   services, volumes (names only, no options)
//   per service: image, command (list), environment (map of scalars), volumes (`<declared name>:<abs path>[:ro]`),
//                depends_on (list), healthcheck {test, interval, timeout, retries, start_period}, init, user,
//                stop_grace_period
// Interpolation (render): ${VAR}, ${VAR:-default}, ${VAR:?message} and $$ for a literal $. Anything else
// with a $ is refused, and so is an unset ${VAR}.
// CLI (tests and CI only, needs the yaml devDependency): node src/template.ts --check <compose.yml>
//   validates the file and builds a project for every size from the sizes.json next to it.

export class TemplateError extends Error {}
/** A variable the template needs is not in the render env: the caller's input, not the template, is at fault. */
export class MissingVarError extends TemplateError {}
const missing = (name: string, why: string): never => {
  throw new MissingVarError(`${name}: ${why}`)
}

export type TemplateService = {
  image: string
  command?: string[]
  environment: Record<string, string>
  volumes: { name: string; path: string; readOnly: boolean }[]
  depends_on: string[]
  healthcheck?: { test: string[]; interval?: string; timeout?: string; retries?: number; start_period?: string }
  init?: boolean
  user?: string
  stop_grace_period?: string
}
export type Template = { services: Record<string, TemplateService>; volumes: string[] }

const SERVICE_KEYS = new Set(['image', 'command', 'environment', 'volumes', 'depends_on', 'healthcheck', 'init', 'user', 'stop_grace_period'])
const HEALTH_KEYS = new Set(['test', 'interval', 'timeout', 'retries', 'start_period'])
const NAME_RE = /^[a-z][a-z0-9_-]*$/
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const DURATION_RE = /^(\d+(ms|s|m|h))+$/
const MOUNT_RE = /^([a-z][a-z0-9_-]*):(\/[A-Za-z0-9._/-]*)(:ro)?$/

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function fail(key: string, why: string): never {
  throw new TemplateError(`${key}: ${why}`)
}

function onlyKeys(o: Record<string, unknown>, allowed: Set<string>, prefix: string) {
  for (const k of Object.keys(o)) if (!allowed.has(k)) fail(prefix ? `${prefix}.${k}` : k, 'is not allowed')
}

function strList(v: unknown, key: string): string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string') ? v : fail(key, 'must be a list of strings')
}

// A rendered value inside code that a shell or interpreter runs (sh -c, node -e) could change the command;
// arguments of any other program (postgres -c name=${VAR}) stay one argv entry each. Every item before the
// first exact -c/-e is checked, so wrappers (tini --, su-exec u, busybox, env) cannot hide the interpreter.
// shortcut: a name-based deny-list; an interpreter under another name (a symlink, a script) passes, so a
// template with one needs its own check (templates are ours, reviewed with the code).
const INTERPRETER_RE = /^(.*\/)?(sh|bash|ash|dash|zsh|busybox|node|deno|bun|python[0-9.]*|perl|ruby|php|env|xargs)$/
function noCodeInterp(argv: string[], key: string): string[] {
  const end = argv.findIndex((a) => a === '-c' || a === '-e')
  const head = end < 0 ? argv : argv.slice(0, end)
  if (head.some((a) => INTERPRETER_RE.test(a)) && argv.some((a) => a.includes('${'))) fail(key, 'an interpreter command must not interpolate')
  return argv
}

function duration(v: unknown, key: string): string | undefined {
  if (v === undefined) return undefined
  return typeof v === 'string' && DURATION_RE.test(v) ? v : fail(key, 'must be a duration like 5s')
}

export function validateTemplate(json: unknown): Template {
  if (!isObj(json)) fail('template', 'must be a mapping')
  onlyKeys(json, new Set(['services', 'volumes']), '')
  const vols = json.volumes ?? {}
  if (!isObj(vols)) fail('volumes', 'must be a mapping')
  for (const [k, v] of Object.entries(vols)) {
    if (!NAME_RE.test(k)) fail(`volumes.${k}`, 'is not a valid name')
    if (v !== null) fail(`volumes.${k}`, 'options are not allowed')
  }
  const volumes = Object.keys(vols)
  if (!isObj(json.services) || !Object.keys(json.services).length) fail('services', 'must be a non-empty mapping')

  const services: Record<string, TemplateService> = {}
  for (const [name, raw] of Object.entries(json.services)) {
    const p = `services.${name}`
    // sb-<ref>-job-<type> is a job container's name
    if (!NAME_RE.test(name) || name.startsWith('job-')) fail(p, 'is not a valid service name')
    if (!isObj(raw)) fail(p, 'must be a mapping')
    onlyKeys(raw, SERVICE_KEYS, p)
    if (typeof raw.image !== 'string') fail(`${p}.image`, 'is required')

    const env = raw.environment ?? {}
    if (!isObj(env)) fail(`${p}.environment`, 'must be a mapping')
    const environment: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_KEY_RE.test(k)) fail(`${p}.environment.${k}`, 'is not a valid name')
      if (!['string', 'number', 'boolean'].includes(typeof v)) fail(`${p}.environment.${k}`, 'must be a scalar')
      environment[k] = String(v)
    }

    const mounts = raw.volumes === undefined ? [] : strList(raw.volumes, `${p}.volumes`)
    const svc: TemplateService = {
      image: raw.image,
      environment,
      volumes: mounts.map((v, i) => {
        const m = MOUNT_RE.exec(v)
        if (!m || !volumes.includes(m[1])) fail(`${p}.volumes[${i}]`, 'only named volumes declared at top level are allowed')
        return { name: m[1], path: m[2], readOnly: !!m[3] }
      }),
      depends_on: raw.depends_on === undefined ? [] : strList(raw.depends_on, `${p}.depends_on`),
    }
    if (raw.command !== undefined) svc.command = noCodeInterp(strList(raw.command, `${p}.command`), `${p}.command`)
    if (raw.init !== undefined) svc.init = typeof raw.init === 'boolean' ? raw.init : fail(`${p}.init`, 'must be a boolean')
    if (raw.user !== undefined) svc.user = typeof raw.user === 'string' && !raw.user.includes('$') ? raw.user : fail(`${p}.user`, 'must be a fixed string')
    svc.stop_grace_period = duration(raw.stop_grace_period, `${p}.stop_grace_period`)
    if (raw.healthcheck !== undefined) {
      const h = raw.healthcheck
      const hp = `${p}.healthcheck`
      if (!isObj(h)) fail(hp, 'must be a mapping')
      onlyKeys(h, HEALTH_KEYS, hp)
      const test = strList(h.test, `${hp}.test`)
      if (!['CMD', 'CMD-SHELL', 'NONE'].includes(test[0])) fail(`${hp}.test`, 'must start with CMD, CMD-SHELL or NONE')
      // a rendered value inside a shell string could change the command
      if (test[0] === 'CMD-SHELL' && test.some((t) => t.includes('${'))) fail(`${hp}.test`, 'CMD-SHELL must not interpolate')
      if (test[0] === 'CMD') noCodeInterp(test.slice(1), `${hp}.test`)
      const retries = h.retries
      if (retries !== undefined && !(Number.isInteger(retries) && (retries as number) >= 0)) fail(`${hp}.retries`, 'must be a whole number')
      svc.healthcheck = { test, interval: duration(h.interval, `${hp}.interval`), timeout: duration(h.timeout, `${hp}.timeout`),
        retries: retries as number | undefined, start_period: duration(h.start_period, `${hp}.start_period`) }
    }
    services[name] = svc
  }
  for (const [name, s] of Object.entries(services)) {
    for (const d of s.depends_on) if (!Object.hasOwn(services, d)) fail(`services.${name}.depends_on`, `unknown service ${d}`)
  }
  startOrder(services)
  return { services, volumes }
}

// Services ordered so that each comes after everything it depends on; a cycle is refused.
export function startOrder(services: Record<string, TemplateService>): string[] {
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (s: string, path: string[]) => {
    if (state.get(s) === 'done') return
    if (state.get(s) === 'visiting') fail(`services.${s}.depends_on`, `cycle ${[...path, s].join(' -> ')}`)
    state.set(s, 'visiting')
    for (const d of services[s].depends_on) visit(d, [...path, s])
    state.set(s, 'done')
    order.push(s)
  }
  for (const s of Object.keys(services)) visit(s, [])
  return order
}

const VAR_RE = /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|:\?)([^}$]*))?\})/g

export function render(value: string, env: Record<string, string>): string {
  if (value.replace(VAR_RE, '').includes('$')) throw new TemplateError(`unsupported interpolation in "${value}"`)
  return value.replace(VAR_RE, (whole, name: string, op: string | undefined, arg: string) => {
    if (whole === '$$') return '$'
    const v = Object.hasOwn(env, name) ? env[name] : undefined
    if (op === ':-') return v || arg
    if (op === ':?') return v || missing(name, arg)
    return v ?? missing(name, 'is not set')
  })
}

// Not top-level await: spec.ts imports this module, which must finish evaluating first.
if (import.meta.main && process.argv[2] === '--check') void check(process.argv[3])

async function check(file: string) {
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { parse } = await import('yaml')
  const { buildProject, dryRunEnv } = await import('./spec.ts')
  try {
    const tpl = validateTemplate(parse(readFileSync(file, 'utf8'), { maxAliasCount: 0 }))
    const sizes = JSON.parse(readFileSync(join(dirname(file), 'sizes.json'), 'utf8'))
    const env = dryRunEnv(tpl)
    const node = { registry: 'registry.invalid/selfbase', templateVersion: 'check', proxyNetwork: 'proxy', entrypointHttp: 'http',
      entrypointHttps: 'https', certResolver: 'le', logSyslogAddr: '', cgroupParent: '', backupHostDir: '',
      subnetPool: '10.207.0.0/16', controlContainer: 'selfbase-control', controlNetwork: 'selfbase', proxyContainer: 'coolify-proxy' }
    const all = ['micro', 'small', 'medium'] as const
    for (const size of all) {
      buildProject({ ref: 'checkcheckcheckcheck', templateVersion: 'check', size, subnet: '10.207.0.0/27',
        hosts: ['check.invalid'], env }, tpl, sizes, node)
    }
    console.log(`template ok: ${Object.keys(tpl.services).join(', ')}; rendered for ${all.join(', ')}`)
  } catch (e) {
    console.error(`template check failed: ${(e as Error).message}`)
    process.exit(1)
  }
}
