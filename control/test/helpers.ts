// Shared by the account, authz and audit tests: a clean slate of dashboard data, and signed-in callers.
import { app } from '../src/app.ts'
import { pool } from '../src/db.ts'
import { config } from '../src/config.ts'

export const ORIGIN = new URL(config.publicUrl).origin

/** Removes every dashboard user, organization, token, invitation and audit row (cascades to memberships). */
export async function resetDashboard(): Promise<void> {
  await pool.query(`truncate auth.users, control.organizations, control.audit_log, selfbase.mail_log cascade`)
}

/** Cookie header from a response's Set-Cookie lines (name=value pairs only). */
export const cookiesOf = (res: Response) =>
  res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ')

export async function login(email: string, password: string): Promise<string> {
  const res = await app.request('/platform/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 200) throw new Error(`login ${email}: ${res.status} ${await res.text()}`)
  return cookiesOf(res)
}

/** A request as a signed-in Studio user (cookie + same-origin). */
export const as = (cookie: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { cookie, origin: ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

/** A request with a personal access token. */
export const withToken = (token: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

// ---- projects (Task 13 tests) ----

export const PASSWORD = 'correct-horse-battery'
let subnetN = 0

/** A dashboard user with a personal access token. */
export async function user(email: string) {
  const { createConfirmedUser } = await import('../src/routes/platform-auth.ts')
  const { newAccessToken } = await import('../src/ids.ts')
  const u = await createConfirmedUser(email, PASSWORD)
  const { token, hash } = newAccessToken()
  await pool.query(`insert into control.access_tokens (user_id, name, token_hash) values ($1, 'test', $2)`, [u.id, hash])
  return { ...u, token }
}

export const org = async (slug: string) =>
  (await pool.query(`insert into control.organizations (slug, name) values ($1, $1) returning id, slug`, [slug])).rows[0] as { id: string; slug: string }

export const join = (orgId: string, userId: string, role: string, projectId: string | null = null) =>
  pool.query(`insert into control.memberships (org_id, user_id, role, project_id) values ($1, $2, $3, $4)`, [orgId, userId, role, projectId])

/** A project row as a finished create leaves it: secrets, a default domain, the given status, no job. */
export async function project(orgId: string, o: { name?: string; status?: string; size?: string } = {}) {
  const { newRef } = await import('../src/ids.ts')
  const { generateProjectSecrets } = await import('../src/project-secrets.ts')
  const { putSecret } = await import('../src/secrets.ts')
  const ref = newRef()
  const n = subnetN++
  const p = (await pool.query(
    `insert into control.projects (ref, org_id, name, status, size, template_version, subnet, node_id)
     values ($1, $2, $3, $4, $5, 'test', $6, (select id from control.nodes where name = $7)) returning *`,
    [ref, orgId, o.name ?? ref, o.status ?? 'ACTIVE_HEALTHY', o.size ?? 'micro', `10.251.${Math.floor(n / 8)}.${(n % 8) * 32}/27`, config.nodeName],
  )).rows[0]
  const secrets = generateProjectSecrets(ref)
  for (const [k, v] of Object.entries(secrets)) await putSecret(pool, p, k, 'platform', v)
  await pool.query(`insert into control.project_domains (project_id, hostname, kind) values ($1, $2, 'default')`, [p.id, `${ref}.${config.baseDomain}`])
  return { ...p, secrets } as { id: string; ref: string; name: string; status: string; secrets: Record<string, string> }
}
