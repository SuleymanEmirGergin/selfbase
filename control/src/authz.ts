// Organization roles (spec 8.6): what each role may do, and the membership check routes call.
import type { Context } from 'hono'
import { pool } from './db.ts'
import { ApiError } from './errors.ts'
import type { Env } from './session.ts'

export type Role = 'owner' | 'administrator' | 'developer' | 'read_only'
export type Action =
  | 'project.read' | 'project.write' | 'project.sql' | 'project.keys' | 'project.manage'
  | 'org.members' | 'org.tokens' | 'org.owner'

export const ROLES: Role[] = ['read_only', 'developer', 'administrator', 'owner']
// each role has everything of the roles before it in ROLES
const LEAST: Record<Action, Role> = {
  'project.read': 'read_only',
  'org.tokens': 'read_only', // every member, for their own tokens
  'project.write': 'developer',
  'project.sql': 'developer',
  'project.keys': 'developer',
  'project.manage': 'administrator',
  'org.members': 'administrator',
  'org.owner': 'owner',
}

export const can = (role: Role, action: Action): boolean => ROLES.indexOf(role) >= ROLES.indexOf(LEAST[action])

/** The better of two roles (an org-wide and a project membership can both apply). */
export const best = (roles: Role[]): Role | null =>
  roles.reduce<Role | null>((a, r) => (a === null || ROLES.indexOf(r) > ROLES.indexOf(a) ? r : a), null)

/**
 * The caller's role in the organization (on the project, when given) if it allows the action; 403 otherwise.
 * A membership with project_id applies only to that project, never to organization-level actions.
 */
export async function authorize(c: Context<Env>, action: Action, scope: { orgId: string; projectId?: string }): Promise<Role> {
  c.set('audit', { ...c.get('audit'), orgId: scope.orgId, projectId: scope.projectId })
  const { rows } = await pool.query(
    `select role from control.memberships where org_id = $1 and user_id = $2 and (project_id is null or project_id = $3)`,
    [scope.orgId, c.get('user').id, scope.projectId ?? null],
  )
  const role = best(rows.map((r) => r.role))
  if (!role || !can(role, action)) throw new ApiError(403, 'forbidden', 'Forbidden')
  return role
}
