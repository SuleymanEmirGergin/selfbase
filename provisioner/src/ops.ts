// The typed operations (spec 7.5, AC-11). Every container body comes from spec.ts; nothing here takes a
// container spec from the caller. Objects are only ever addressed by sb-* names built in names.ts.
import { assertRef, containerName, networkName, ProvisionError, REF_RE, volumeName } from './names.ts'
import { assertJobRef, buildJob, buildProject, type EnsureInput, type JobType, type Sizes } from './spec.ts'
import { isObj, startOrder, type Template } from './template.ts'
import type { NodeSettings } from './settings.ts'
import { containerLogs, docker, ensureImage } from './docker.ts'

export type Ctx = { tpl: Template; sizes: Sizes; node: NodeSettings }
export type ServiceState = { service: string; exists: boolean; state: string | null; health: string | null
  specHash: string | null; templateVersion: string | null; memLimitMb: number | null; proxyAttached: boolean }

const MiB = 1024 * 1024
const SERVICE_RE = /^[a-z][a-z0-9_-]*$/
const JOB_NAME_RE = /^\/sb-[a-z]+-job-/

const refuse = (status: number, code: string, message?: string): never => {
  throw new ProvisionError(status, code, message)
}
const filters = (f: Record<string, string[]>) => encodeURIComponent(JSON.stringify(f))
const listContainers = async (f: Record<string, string[]>, all = true): Promise<any[]> =>
  (await docker('GET', `/containers/json?all=${all}&filters=${filters(f)}`)).data
const inspect = async (name: string): Promise<any> => {
  const r = await docker('GET', `/containers/${name}/json`, undefined, [404])
  return r.status === 404 ? null : r.data
}
const inspectNetwork = async (name: string): Promise<any> => {
  const r = await docker('GET', `/networks/${name}`, undefined, [404])
  return r.status === 404 ? null : r.data
}
const attached = (net: any, container: string) => Object.values(net?.Containers ?? {}).some((c: any) => c.Name === container)
const connectIfMissing = async (c: any, name: string, network: string) => {
  if (!Object.hasOwn(c.NetworkSettings?.Networks ?? {}, network)) await docker('POST', `/networks/${network}/connect`, { Container: name })
}

// Clean stop first (SIGTERM, then the container's own StopTimeout from stop_grace_period), so Postgres is
// never SIGKILLed by a recreate or a delete. True when a container was removed.
const stopAndRemove = async (name: string) => {
  await docker('POST', `/containers/${name}/stop`, undefined, [304, 404])
  return (await docker('DELETE', `/containers/${name}?force=true`, undefined, [404])).status !== 404
}

// One mutating operation per key at a time (control's reconcile and a user action can overlap).
// shortcut: one map entry per ref ever touched, fine for the few dozen projects of a node.
const locks = new Map<string, Promise<unknown>>()
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
  locks.set(key, next.catch(() => {}))
  return next
}

function serviceState(service: string, c: any, node: NodeSettings): ServiceState {
  if (!c) return { service, exists: false, state: null, health: null, specHash: null, templateVersion: null, memLimitMb: null, proxyAttached: false }
  const l = c.Config?.Labels ?? {}
  return { service, exists: true, state: c.State.Status, health: c.State.Health?.Status ?? null, specHash: l['selfbase.spec'] ?? null,
    templateVersion: l['selfbase.template'] ?? null, memLimitMb: c.HostConfig.Memory / MiB,
    proxyAttached: Object.hasOwn(c.NetworkSettings?.Networks ?? {}, node.proxyNetwork) }
}

export async function projectState(ctx: Ctx, ref: string) {
  assertRef(ref)
  const net = await inspectNetwork(networkName(ref))
  const labelled = (await listContainers({ label: [`selfbase.project=${ref}`] })).map((c) => c.Labels?.['selfbase.service'])
    .filter((s): s is string => typeof s === 'string' && SERVICE_RE.test(s) && !s.startsWith('job-'))
  const services = [...new Set([...startOrder(ctx.tpl.services), ...labelled])]
  return { ref, network: !!net, controlAttached: attached(net, ctx.node.controlContainer),
    services: await Promise.all(services.map(async (s) => serviceState(s, await inspect(containerName(ref, s)), ctx.node))) }
}

export async function listProjects(ctx: Ctx) {
  const all = await listContainers({ label: ['selfbase.managed=true'] })
  const refs = [...new Set(all.map((c) => c.Labels?.['selfbase.project']))].filter((r): r is string => typeof r === 'string' && REF_RE.test(r))
  return Promise.all(refs.sort().map(async (ref) => ({ ref, services: (await projectState(ctx, ref)).services })))
}

export async function ensure(ctx: Ctx, ref: string, body: unknown) {
  assertRef(ref)
  if (!isObj(body)) refuse(400, 'invalid_body', 'body must be a JSON object')
  const { recreate = [], ...input } = body as Record<string, unknown>
  const spec = buildProject({ ...input, ref } as EnsureInput, ctx.tpl, ctx.sizes, ctx.node)
  if (!Array.isArray(recreate) || !recreate.every((s) => spec.containers.some((c) => c.service === s))) {
    refuse(400, 'invalid_recreate', 'recreate must list template services')
  }
  const current = await Promise.all(spec.containers.map((c) => inspect(c.name)))
  const fresh = spec.containers.filter((c, i) => !current[i] || current[i].Config?.Labels?.['selfbase.spec'] !== c.specHash
    || (recreate as string[]).includes(c.service))
  // before anything changes: an image Coolify's nightly prune removed is pulled again here
  for (const image of new Set(fresh.map((c) => c.body.Image as string))) await ensureImage(image)

  const existing = await inspectNetwork(spec.network.name)
  if (!existing) await docker('POST', '/networks/create', spec.network.body)
  // a network keeps its subnet; another one would mean two projects claim one /27 (control allocates them)
  else if (existing.IPAM?.Config?.[0]?.Subnet !== (input as { subnet: string }).subnet) {
    refuse(409, 'subnet_conflict', `${spec.network.name} exists with another subnet`)
  }
  for (const v of spec.volumes) {
    if ((await docker('GET', `/volumes/${v}`, undefined, [404])).status === 404) {
      await docker('POST', '/volumes/create', { Name: v, Labels: { 'selfbase.managed': 'true', 'selfbase.project': ref } })
    }
  }
  for (const [i, c] of spec.containers.entries()) {
    let cur = current[i]
    if (fresh.includes(c)) {
      if (cur) await stopAndRemove(c.name)
      await docker('POST', `/containers/create?name=${c.name}`, c.body)
      cur = await inspect(c.name)
    }
    for (const n of c.networks.slice(1)) await connectIfMissing(cur, c.name, n)
    if (!cur.State.Running) await docker('POST', `/containers/${c.name}/start`, undefined, [304])
  }
  const net = await inspectNetwork(spec.network.name)
  if (!attached(net, ctx.node.controlContainer)) {
    await docker('POST', `/networks/${spec.network.name}/connect`, { Container: ctx.node.controlContainer })
  }
  return projectState(ctx, ref)
}

function pick(ctx: Ctx, body: unknown): string[] {
  const all = startOrder(ctx.tpl.services)
  const s = isObj(body) ? body.services : undefined
  if (s === undefined) return all
  if (!Array.isArray(s) || !s.every((x) => all.includes(x))) refuse(400, 'invalid_services', 'services must list template services')
  return all.filter((x) => (s as string[]).includes(x))
}

export async function startStop(ctx: Ctx, ref: string, action: 'start' | 'stop', body: unknown) {
  assertRef(ref)
  const list = pick(ctx, body)
  for (const s of action === 'start' ? list : list.reverse()) {
    const r = await docker('POST', `/containers/${containerName(ref, s)}/${action}`, undefined, [304, 404])
    if (r.status === 404 && action === 'start') refuse(404, 'service_not_found', `${s} is not created; run ensure`)
  }
  return projectState(ctx, ref)
}

export async function remove(ctx: Ctx, ref: string, volumes: boolean) {
  assertRef(ref)
  const prefix = `/sb-${ref}-`
  const labelled = (await listContainers({ label: [`selfbase.project=${ref}`] })).flatMap((c) => c.Names as string[])
    .filter((n) => n.startsWith(prefix)).map((n) => n.slice(1))
  const removed = { containers: [] as string[], volumes: [] as string[], network: false }
  // reverse start order, then anything else labelled for this ref (jobs)
  for (const n of new Set([...startOrder(ctx.tpl.services).reverse().map((s) => containerName(ref, s)), ...labelled])) {
    if (await stopAndRemove(n)) removed.containers.push(n)
  }
  const name = networkName(ref)
  const net = await inspectNetwork(name)
  if (net) {
    if (attached(net, ctx.node.controlContainer)) {
      await docker('POST', `/networks/${name}/disconnect`, { Container: ctx.node.controlContainer, Force: true }, [404])
    }
    removed.network = (await docker('DELETE', `/networks/${name}`, undefined, [404])).status !== 404
  }
  if (volumes) {
    for (const v of ctx.tpl.volumes.map((x) => volumeName(ref, x))) {
      if ((await docker('DELETE', `/volumes/${v}`, undefined, [404])).status !== 404) removed.volumes.push(v)
    }
  }
  return { removed }
}

export async function attachProxy(ctx: Ctx, ref: string) {
  assertRef(ref)
  const name = containerName(ref, 'core')
  await connectIfMissing((await inspect(name)) ?? refuse(404, 'service_not_found', 'core is not created'), name, ctx.node.proxyNetwork)
  return projectState(ctx, ref)
}

// Jobs run for a project ref or for the control stack itself ('control', backup only).
export async function runJob(ctx: Ctx, ref: string, body: unknown) {
  assertJobRef(ref, isObj(body) ? body.type : undefined)
  if (!isObj(body)) refuse(400, 'invalid_body', 'body must be a JSON object')
  const b = body as Record<string, unknown>
  const spec = buildJob({ ref, type: b.type as JobType, args: (b.args ?? {}) as { dir?: string }, env: (b.env ?? {}) as Record<string, string> }, ctx.node)
  // a deleted project gets no job (server.ts runs jobs under the ref's lock too, so a delete cannot overlap)
  if (ref !== 'control' && !(await inspectNetwork(networkName(ref)))) refuse(404, 'project_not_found', `${ref} has no network; run ensure`)
  const running = await listContainers({ status: ['running'] }, false)
  if (running.some((c) => (c.Names as string[]).some((n) => JOB_NAME_RE.test(n)))) refuse(409, 'job_running', 'another job is running')
  // an earlier finished job of this type whose result was never read
  await docker('DELETE', `/containers/${spec.name}?force=true`, undefined, [404])
  await ensureImage(spec.body.Image as string)
  const created = await docker('POST', `/containers/create?name=${spec.name}`, spec.body)
  await docker('POST', `/containers/${spec.name}/start`)
  return { id: created.data.Id as string }
}

export async function jobStatus(ref: string, type: string) {
  assertJobRef(ref, type)
  if (!SERVICE_RE.test(type)) refuse(400, 'invalid_job_type')
  const name = containerName(ref, `job-${type}`)
  const c = (await inspect(name)) ?? refuse(404, 'job_not_found', `no ${type} job`)
  const tail = await containerLogs(name, 50, 'job_not_found')
  if (c.State.Running) return { status: 'running', exitCode: null, tail }
  await docker('DELETE', `/containers/${name}?force=true`, undefined, [404])
  // still 'created' means its start failed: it never ran
  const exitCode: number | null = c.State.Status === 'created' ? null : c.State.ExitCode
  return { status: exitCode === 0 ? 'succeeded' : 'failed', exitCode, tail }
}

// Template services only: never a job container or anything else that happens to be named sb-<ref>-*.
function serviceName(ctx: Ctx, ref: string, service: string) {
  assertRef(ref)
  if (!Object.hasOwn(ctx.tpl.services, service)) refuse(400, 'invalid_service', 'service must be a template service')
  return containerName(ref, service)
}

export async function serviceLogs(ctx: Ctx, ref: string, service: string, tail: string | null) {
  const name = serviceName(ctx, ref, service)
  const n = tail === null ? 200 : Number(tail)
  if (!Number.isInteger(n) || n < 1 || n > 5000) refuse(400, 'invalid_tail', 'tail must be 1..5000')
  return containerLogs(name, n)
}

export async function serviceStats(ctx: Ctx, ref: string, service: string) {
  const r = await docker('GET', `/containers/${serviceName(ctx, ref, service)}/stats?stream=false`, undefined, [404])
  if (r.status === 404) refuse(404, 'service_not_found')
  const { memory_stats: m = {}, cpu_stats: cpu = {}, precpu_stats: pre = {} } = r.data
  const cpuDelta = (cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0)
  const sysDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0)
  const round = (v: number) => Math.round(v * 100) / 100
  return { mem_usage_mb: round(((m.usage ?? 0) - (m.stats?.inactive_file ?? 0)) / MiB), mem_limit_mb: round((m.limit ?? 0) / MiB),
    cpu_percent: sysDelta > 0 ? round((cpuDelta / sysDelta) * (cpu.online_cpus ?? 1) * 100) : 0 }
}
