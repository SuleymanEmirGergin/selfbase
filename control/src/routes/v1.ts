// Management-API-shaped project routes (spec 7.8), bearer only, mounted at /v1. Every route names the operationId of
// docs/reference/management-api.json it implements (checked by test/openapi.test.ts).
import { Hono } from 'hono'
import type { Context, Handler } from 'hono'
import { AdmissionError } from '../admission.ts'
import { writeAudit } from '../audit.ts'
import { pool } from '../db.ts'
import { ApiError } from '../errors.ts'
import { adminSql } from '../forward.ts'
import { HEALTH_SERVICES, servicesHealth } from '../health.ts'
import { createProject } from '../jobs/index.ts'
import { projectConfig } from '../project-env.ts'
import { provisioner } from '../provisioner.ts'
import type { Env } from '../session.ts'
import {
  bad, body, canPause, canRestore, legacyKeys, lifecycle, mask, orgFor, preAdmit, projectFor, projectName, projectSize, v1Project,
  visibleProjects,
} from './platform-projects.ts'

export const v1 = new Hono<Env>()
/** 'METHOD /v1/path' → operationId, for every /v1 route */
export const operations: Record<string, string> = {}

/** Registers a /v1 route under the operationId it implements. */
export function op(router: Hono<Env>, method: 'get' | 'post' | 'delete', path: string, operationId: string, handler: Handler<Env>) {
  operations[`${method.toUpperCase()} /v1${path}`] = operationId
  router[method](path, handler)
}

// Supabase's db_pass is the superuser password; it ends up in connection strings, so URL-safe characters only
const DB_PASS_RE = /^[A-Za-z0-9._~-]{12,128}$/

op(v1, 'get', '/projects', 'v1-list-all-projects', async (c) => c.json((await visibleProjects(c)).map(v1Project)))

op(v1, 'post', '/projects', 'v1-create-a-project', async (c) => {
  const b = await body(c)
  const name = projectName(b.name)
  // region, plan and the rest have no meaning here and are ignored
  const size = projectSize(b.desired_instance_size ?? 'micro')
  if (b.db_pass !== undefined && (typeof b.db_pass !== 'string' || !DB_PASS_RE.test(b.db_pass)))
    throw bad('db_pass must be 12 to 128 URL-safe characters (letters, digits, . _ ~ -)')
  // our organization id is its slug, so both name the same thing
  const org = await orgFor(c, b.organization_slug ?? b.organization_id, 'project.manage')
  const { project } = await createProject(pool, { orgId: org.id, name, size, pool: 'project', createdBy: c.get('user').id, dbPass: b.db_pass })
  c.set('audit', { ...c.get('audit'), projectId: project.id, target: project.ref })
  return c.json(v1Project({ ...project, org_slug: org.slug } as Parameters<typeof v1Project>[0]), 201)
})

op(v1, 'get', '/projects/:ref', 'v1-get-project', async (c) => {
  const p = await projectFor(c, 'project.read')
  // selfbase's addition, as on /platform: the auth mails need it
  return c.json({ ...v1Project(p), smtp_configured: !!(await projectConfig(pool, p.id)).SMTP_HOST })
})

op(v1, 'delete', '/projects/:ref', 'v1-delete-a-project', async (c) => {
  const p = await projectFor(c, 'project.manage')
  await lifecycle(c, p, 'project.delete', () => true)
  // Supabase's numeric project id has no counterpart: a neutral 0
  return c.json({ id: 0, ref: p.ref, name: p.name })
})

op(v1, 'post', '/projects/:ref/pause', 'v1-pause-a-project', async (c) => {
  await lifecycle(c, await projectFor(c, 'project.manage'), 'project.pause', canPause)
  return c.body(null, 200)
})

op(v1, 'post', '/projects/:ref/restore', 'v1-restore-a-project', async (c) => {
  const p = await projectFor(c, 'project.manage')
  try {
    if (canRestore(p.status)) await preAdmit(p)
  } catch (e) {
    if (e instanceof AdmissionError) throw new ApiError(400, e.code, e.message)
    throw e
  }
  await lifecycle(c, p, 'project.restore', canRestore)
  return c.body(null, 200)
})

op(v1, 'get', '/projects/:ref/health', 'v1-get-services-health', async (c) => {
  const p = await projectFor(c, 'project.read')
  const names = (c.req.query('services') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!names.length || names.some((n) => !HEALTH_SERVICES.includes(n))) throw bad(`services must list some of ${HEALTH_SERVICES.join(', ')}`)
  return c.json(servicesHealth(await provisioner().inspect(p.ref), names))
})

op(v1, 'get', '/projects/:ref/api-keys', 'v1-get-project-api-keys', async (c: Context<Env>) => {
  const reveal = c.req.query('reveal') === 'true'
  const keys = await legacyKeys(await projectFor(c, reveal ? 'project.keys' : 'project.read'))
  if (reveal) {
    // a GET is not audited by the middleware; this one hands out service_role (the name is recorded, never the key)
    c.set('audit', { ...c.get('audit'), target: 'service_role' })
    await writeAudit(c, { status: 200, reveal: true })
  }
  // anon is public (the CLI reads it here); service_role only with reveal
  return c.json([{ name: 'anon', api_key: keys.anon, type: 'legacy' },
    { name: 'service_role', api_key: reveal ? keys.service_role : mask(keys.service_role), type: 'legacy' }])
})

op(v1, 'post', '/projects/:ref/database/query', 'v1-run-a-query', async (c) => {
  const p = await projectFor(c, 'project.sql')
  const { query } = await body(c)
  if (typeof query !== 'string' || !query.trim()) throw bad('query is required')
  const out = await adminSql(p, c.get('user').email, query)
  if (out.error) throw new ApiError(400, 'query_failed', out.error.message)
  const columns = out.columns ?? []
  return c.json((out.rows ?? []).map((r) => Object.fromEntries(columns.map((col, i) => [col, r[i]]))), 201)
})
