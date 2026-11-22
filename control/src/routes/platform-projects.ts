// Projects for Studio (/platform, cookie or bearer): lifecycle, keys, domains, jobs, logs, capacity, and the
// forwarding of a project's admin API. The project lookups and JSON shapes here are shared with /v1 (v1.ts).
import { Hono } from 'hono'
import type { Context } from 'hono'
import { admit, capacity, RUNNING_STATUSES, type Size } from '../admission.ts'
import { authorize } from '../authz.ts'
import type { Action } from '../authz.ts'
import { largeBodyRoutes } from '../audit.ts'
import { config } from '../config.ts'
import { pool } from '../db.ts'
import { ApiError } from '../errors.ts'
import { forwardAdmin } from '../forward.ts'
import { addDomain, newHostsThisWeek, removeDomain } from '../hosts.ts'
import { REF_RE } from '../ids.ts'
import { createProject, enqueue, enqueueIfIdle, stepsOf, type Project } from '../jobs/index.ts'
import { LOG_SERVICES, projectLogs } from '../logs.ts'
import { projectConfig } from '../project-env.ts'
import { provisioner } from '../provisioner.ts'
import { getSecrets } from '../secrets.ts'
import { projectCapMb } from '../sizes.ts'
import type { Env } from '../session.ts'

export const platformProjects = new Hono<Env>()

export type ProjectRow = Project & { org_slug: string; created_at: Date; certificate: 'ok' | 'pending' }

const SIZES: Size[] = ['micro', 'small', 'medium']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const SERVICES = ['db', 'rest', 'core', 'fn', 'pooler']

export const bad = (message: string) => new ApiError(400, 'validation_failed', message)
const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`)
export const body = async (c: Context): Promise<Record<string, any>> => {
  const b = await c.req.json().catch(() => null)
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {}
}

// the caller reaches a project through an org-wide membership or one on that project
const VISIBLE = `p.status <> 'REMOVED' and exists (select 1 from control.memberships m
  where m.org_id = p.org_id and m.user_id = $1 and (m.project_id is null or m.project_id = p.id))`
// issued once a create or import got past its certificate step; a project that never had to wait for one (it ran
// before) counts as issued. Read from the rows, not probed, so a list is one query.
const CERTIFICATE = `case when p.status not in ('COMING_UP', 'INIT_FAILED', 'RESTORING') or exists (
  select 1 from control.jobs j join control.job_events e on e.job_id = j.id
   where j.project_id = p.id and e.step = 'certificate' and e.status = 'succeeded') then 'ok' else 'pending' end`
const SELECT = `select p.*, o.slug as org_slug, ${CERTIFICATE} as certificate
  from control.projects p join control.organizations o on o.id = p.org_id`

/** Every project the caller can see, optionally of one organization. */
export async function visibleProjects(c: Context<Env>, orgId?: string): Promise<ProjectRow[]> {
  return (await pool.query(`${SELECT} where ${VISIBLE} and ($2::uuid is null or p.org_id = $2) order by p.created_at, p.ref`,
    [c.get('user').id, orgId ?? null])).rows
}

/** The project of `:ref` the caller can see; an unknown ref and a foreign one are the same 404. */
async function memberProject(c: Context<Env>, ref: string): Promise<ProjectRow> {
  const p = REF_RE.test(ref) ? (await pool.query(`${SELECT} where p.ref = $2 and ${VISIBLE}`, [c.get('user').id, ref])).rows[0] : null
  if (!p) throw notFound('project')
  return p
}

/** memberProject, then the role check for the action (403). */
export async function projectFor(c: Context<Env>, action: Action, ref = c.req.param('ref') ?? ''): Promise<ProjectRow> {
  const p = await memberProject(c, ref)
  await authorize(c, action, { orgId: p.org_id, projectId: p.id })
  c.set('audit', { ...c.get('audit'), target: p.ref })
  return p
}

/** The organization of `slug` when the caller has any membership in it; unknown and foreign slugs are the same 404. */
async function memberOrg(c: Context<Env>, slug: unknown): Promise<{ id: string; slug: string }> {
  if (typeof slug !== 'string' || !slug) throw bad('organization_slug is required')
  const org = (await pool.query(
    `select o.id, o.slug from control.organizations o
      where o.slug = $1 and exists (select 1 from control.memberships m where m.org_id = o.id and m.user_id = $2)`,
    [slug, c.get('user').id],
  )).rows[0]
  if (!org) throw notFound('organization')
  return org
}

/** memberOrg, then the org-level role check (project-scoped memberships do not count). */
export async function orgFor(c: Context<Env>, slug: unknown, action: Action): Promise<{ id: string; slug: string }> {
  const org = await memberOrg(c, slug)
  await authorize(c, action, { orgId: org.id })
  return org
}

/** The Management API's project object. Supabase's organization id is its slug (as in /v1/organizations). */
export const v1Project = (p: ProjectRow) => ({
  id: p.ref, ref: p.ref, organization_id: p.org_slug, organization_slug: p.org_slug, name: p.name, region: config.nodeName,
  status: p.status, created_at: p.created_at,
  database: { host: 'db', version: '17', postgres_engine: '17', release_channel: 'ga' },
})
// Studio matches organization_id against /platform/me's organization ids
const platformProject = (p: ProjectRow) => ({ ...v1Project(p), organization_id: p.org_id, size: p.size, certificate: p.certificate })

export function projectName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw bad('name must be 1 to 100 characters')
  return name.trim()
}
export function projectSize(size: unknown): Size {
  if (!SIZES.includes(size as Size)) throw bad(`size must be one of ${SIZES.join(', ')}`)
  return size as Size
}

/** One lifecycle job, when the status allows it and no other job is pending or running. */
export async function lifecycle(c: Context<Env>, p: ProjectRow, type: string, allowed: (status: string) => boolean,
  payload: Record<string, unknown> = {}): Promise<string> {
  if (!allowed(p.status)) throw new ApiError(409, 'invalid_status', `this cannot be done while the project is ${p.status}`)
  const id = await enqueueIfIdle(pool, { type, projectId: p.id, payload, createdBy: c.get('user').id })
  if (!id) throw new ApiError(409, 'project_busy', 'another operation is running on this project; try again when it ends')
  return id
}
export const canPause = (s: string) => !['INACTIVE', 'REMOVE_FAILED'].includes(s)
export const canRestore = (s: string) => ['INACTIVE', 'RESTORE_FAILED'].includes(s)
/** Restore is admitted again by its job; this answers a refusal at once instead of as a failed job. */
export const preAdmit = (p: ProjectRow) => admit(pool, { size: p.size as Size, excludeProjectId: p.id })

export const mask = (key: string) => `${key.slice(0, 20)}••••••••`
export async function legacyKeys(p: ProjectRow) {
  const s = await getSecrets(pool, p)
  return { anon: s.ANON_KEY, service_role: s.SERVICE_ROLE_KEY }
}

// ---- projects ----

// any membership may list: a project-scoped member sees the projects it reaches
platformProjects.get('/projects', async (c) => {
  const org = await memberOrg(c, c.req.query('organization_slug'))
  return c.json((await visibleProjects(c, org.id)).map(platformProject))
})

platformProjects.post('/projects', async (c) => {
  const b = await body(c)
  const name = projectName(b.name)
  const size = projectSize(b.size)
  const poolName = b.pool ?? 'project'
  if (poolName !== 'project' && poolName !== 'test') throw bad('pool must be project or test')
  const org = await orgFor(c, b.organization_slug, 'project.manage')
  const { project, jobId } = await createProject(pool, { orgId: org.id, name, size, pool: poolName, createdBy: c.get('user').id })
  c.set('audit', { ...c.get('audit'), projectId: project.id, target: project.ref })
  return c.json({ project: platformProject({ ...project, org_slug: org.slug, certificate: 'pending' } as ProjectRow), job_id: jobId }, 201)
})

platformProjects.get('/projects/:ref', async (c) => {
  const p = await projectFor(c, 'project.read')
  const [domains, settings, cfg, lastJob, services] = await Promise.all([
    pool.query(`select hostname, kind from control.project_domains where project_id = $1 order by kind <> 'default', hostname`, [p.id]),
    pool.query(`select value from control.settings where key = 'current_template_version'`),
    projectConfig(pool, p.id),
    pool.query(`select id, type, status, step, error from control.jobs where project_id = $1 order by created_at desc limit 1`, [p.id]),
    serviceStates(p.ref),
  ])
  const job = lastJob.rows[0]
  const urls = domains.rows.map((d) => `https://${d.hostname}`)
  return c.json({
    ...platformProject(p),
    template_version: p.template_version,
    current_template_version: settings.rows[0]?.value ?? config.templateVersion,
    urls: { api: urls[0] ?? null, legacy: urls.slice(1) },
    smtp_configured: !!cfg.SMTP_HOST,
    services,
    last_job: job ? { ...job, step: Number(job.step) } : null,
  })
})

/** The provisioner's view plus each running container's memory use; [] when the provisioner cannot answer. */
async function serviceStates(ref: string) {
  const state = await provisioner().inspect(ref).catch(() => null)
  return Promise.all((state?.services ?? []).map(async (s) => ({
    ...s,
    memUsageMb: s.state === 'running' ? await provisioner().stats(ref, s.service).then((x) => x.mem_usage_mb, () => null) : null,
  })))
}

platformProjects.post('/projects/:ref/pause', async (c) => {
  const p = await projectFor(c, 'project.manage')
  return c.json({ job_id: await lifecycle(c, p, 'project.pause', canPause) }, 202)
})

platformProjects.post('/projects/:ref/restore', async (c) => {
  const p = await projectFor(c, 'project.manage')
  if (canRestore(p.status)) await preAdmit(p)
  return c.json({ job_id: await lifecycle(c, p, 'project.restore', canRestore) }, 202)
})

platformProjects.post('/projects/:ref/upgrade', async (c) => {
  const p = await projectFor(c, 'project.manage')
  return c.json({ job_id: await lifecycle(c, p, 'project.upgrade', (s) => s === 'ACTIVE_HEALTHY' || s === 'ACTIVE_UNHEALTHY') }, 202)
})

platformProjects.delete('/projects/:ref', async (c) => {
  const p = await projectFor(c, 'project.manage')
  if ((await body(c)).confirm_name !== p.name) throw bad('confirm_name must be the project name')
  return c.json({ job_id: await lifecycle(c, p, 'project.delete', () => true) }, 202)
})

// ---- api keys ----

platformProjects.get('/projects/:ref/api-keys', async (c) => {
  const keys = await legacyKeys(await projectFor(c, 'project.read'))
  // anon is public (it ships in every app); service_role only through reveal
  return c.json([{ name: 'anon', api_key: keys.anon, type: 'legacy' }, { name: 'service_role', api_key: mask(keys.service_role), type: 'legacy' }])
})

platformProjects.post('/projects/:ref/api-keys/reveal', async (c) => {
  const p = await projectFor(c, 'project.keys')
  const { name } = await body(c)
  if (name !== 'anon' && name !== 'service_role') throw bad('name must be anon or service_role')
  c.set('audit', { ...c.get('audit'), target: name })
  return c.json({ api_key: (await legacyKeys(p))[name as 'anon' | 'service_role'] })
})

// ---- domains: a change recreates core with the new router rule ----

platformProjects.get('/projects/:ref/domains', async (c) => {
  const p = await projectFor(c, 'project.read')
  return c.json((await pool.query(
    `select hostname, kind from control.project_domains where project_id = $1 order by kind <> 'default', hostname`, [p.id])).rows)
})

const applyCore = (c: Context<Env>, p: ProjectRow) =>
  enqueue(pool, { type: 'project.apply', projectId: p.id, payload: { recreate: ['core'] }, createdBy: c.get('user').id })

platformProjects.post('/projects/:ref/domains', async (c) => {
  const p = await projectFor(c, 'project.manage')
  const { hostname, kind } = await body(c)
  if (typeof hostname !== 'string') throw bad('hostname is required')
  if (kind !== 'legacy' && kind !== 'custom') throw bad('kind must be legacy or custom')
  c.set('audit', { ...c.get('audit'), target: hostname })
  await addDomain(pool, p.id, hostname, kind)
  return c.json({ job_id: await applyCore(c, p) }, 202)
})

platformProjects.delete('/projects/:ref/domains', async (c) => {
  const p = await projectFor(c, 'project.manage')
  const { hostname } = await body(c)
  if (typeof hostname !== 'string') throw bad('hostname is required')
  c.set('audit', { ...c.get('audit'), target: hostname })
  if (!(await removeDomain(pool, p.id, hostname))) throw notFound('domain')
  return c.json({ job_id: await applyCore(c, p) }, 202)
})

// ---- jobs ----

platformProjects.get('/projects/:ref/jobs', async (c) => {
  const p = await projectFor(c, 'project.read')
  const { rows } = await pool.query(
    `select id, type, status, step, error, created_at, updated_at from control.jobs where project_id = $1 order by created_at desc limit 50`, [p.id])
  return c.json(rows.map((j) => ({ ...j, step: Number(j.step) })))
})

platformProjects.get('/jobs/:id', async (c) => {
  const id = c.req.param('id')
  const job = UUID_RE.test(id)
    ? (await pool.query(`select j.*, p.ref from control.jobs j join control.projects p on p.id = j.project_id where j.id = $1`, [id])).rows[0]
    : null
  if (!job) throw notFound('job')
  // a job of a project the caller cannot see is the same 404
  await projectFor(c, 'project.read', job.ref).catch((e) => { throw e instanceof ApiError && e.status === 404 ? notFound('job') : e })
  const events = (await pool.query(`select at, status, step, message from control.job_events where job_id = $1 order by id`, [id])).rows
  return c.json({
    id: job.id, type: job.type, status: job.status, step: Number(job.step), steps: stepsOf(job.type), error: job.error,
    events: events.map((e) => ({ at: e.at, event: e.status === 'succeeded' ? e.step : `${e.status} ${e.step}${e.message ? `: ${e.message}` : ''}` })),
  })
})

// ---- logs ----

platformProjects.get('/projects/:ref/logs', async (c) => {
  const p = await projectFor(c, 'project.read')
  const service = c.req.query('service') ?? ''
  if (!LOG_SERVICES.includes(service)) throw bad(`service must be one of ${LOG_SERVICES.join(', ')}`)
  const rawLimit = c.req.query('limit') ?? '200'
  const limit = /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : 0
  if (limit < 1 || limit > 1000) throw bad('limit must be 1 to 1000')
  const start = c.req.query('start')
  if (start !== undefined && (!ISO_RE.test(start) || Number.isNaN(Date.parse(start)))) throw bad('start must be an ISO 8601 timestamp')
  const { lines, source } = await projectLogs(p.ref, service, limit, start)
  if (source === 'container') c.header('x-selfbase-log-source', 'container')
  return c.json(lines)
})

// ---- capacity: the server's numbers; the project rows are the caller's ----

platformProjects.get('/capacity', async (c) => {
  const [cap, projects, newHosts] = await Promise.all([capacity(pool), visibleProjects(c), newHostsThisWeek(pool)])
  const rows = await Promise.all(projects.map(async (p) => ({
    ref: p.ref, name: p.name, size: p.size, cap_mb: projectCapMb(p.size), status: p.status,
    mem_usage_mb: RUNNING_STATUSES.includes(p.status) ? await memUsage(p.ref) : 0,
  })))
  return c.json({ ...cap, projects: rows, new_hosts_this_week: newHosts, max_new_hosts_per_week: config.maxNewHostsPerWeek })
})

/** Sum over the project's containers; null when the provisioner cannot say. */
const memUsage = (ref: string) =>
  Promise.all(SERVICES.map((s) => provisioner().stats(ref, s))).then((all) => all.reduce((sum, x) => sum + x.mem_usage_mb, 0), () => null)

// ---- the project's admin API ----

const ADMIN = '/projects/:ref/admin/:path{.+}'
// uploads stream through; forwardAdmin applies the project's own upload limit (JSON stays capped by bodyCap)
largeBodyRoutes.add(`/platform${ADMIN}`)
// named methods, not all(): apiRoute (bodyCap, audit) ignores ALL routes
platformProjects.on(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], ADMIN, async (c) => {
  const ref = c.req.param('ref')
  // the role check depends on the path: forwardAdmin authorizes
  const p = await memberProject(c, ref)
  c.set('audit', { ...c.get('audit'), orgId: p.org_id, projectId: p.id, target: p.ref })
  return forwardAdmin(c, p)
})
