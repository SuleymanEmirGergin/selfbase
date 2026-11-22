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
