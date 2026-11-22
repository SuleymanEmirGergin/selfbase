import { createContext, useContext } from 'react'
import type { OrgRef, ProjectAdmin, ProjectDetail, Role, SqlResult } from '../api.ts'

export type Action = 'project.read' | 'project.write' | 'project.sql' | 'project.keys' | 'project.manage'

// Mirrors control's authz table (plan Task 10) so the UI renders only what the server would allow.
const GRANTS: Record<Role, Action[]> = {
  read_only: ['project.read'],
  developer: ['project.read', 'project.write', 'project.sql', 'project.keys'],
  administrator: ['project.read', 'project.write', 'project.sql', 'project.keys', 'project.manage'],
  owner: ['project.read', 'project.write', 'project.sql', 'project.keys', 'project.manage'],
}
// An unknown role (a newer server) grants nothing rather than crashing the project area.
export const can = (role: Role, action: Action) => (GRANTS[role] ?? []).includes(action)

const ORDER: Role[] = ['read_only', 'developer', 'administrator', 'owner']
/** The caller's role on a project: the better of the org-wide role and a role on this project (control's authz best()). */
export function projectRole(org: OrgRef | undefined, ref: string): Role {
  const roles = [org?.role, org?.projects.find((p) => p.ref === ref)?.role].filter((r): r is Role => !!r)
  return roles.reduce<Role | null>((a, r) => (a === null || ORDER.indexOf(r) > ORDER.indexOf(a) ? r : a), null) ?? 'read_only'
}

export type ProjectCtx = {
  ref: string
  project: ProjectDetail
  org: OrgRef | undefined
  api: ProjectAdmin
  can: (action: Action) => boolean
  /** Reloads the project detail (status, services, last job). */
  reload: () => void
}

// The SQL screen's last query and result per project ref. Module memory: survives page switches, not a reload, and is
// cleared on sign-out. It lives here, not in the lazily loaded SQL chunk, so sign-out can clear it.
const sqlMemory = new Map<string, { query: string; result: SqlResult | null }>()
export const sqlMemo = (ref: string) => sqlMemory.get(ref) ?? sqlMemory.set(ref, { query: 'select now();', result: null }).get(ref)!
export const clearProjectMemory = () => sqlMemory.clear()

export const Ctx = createContext<ProjectCtx | null>(null)
export const useProject = () => useContext(Ctx)!
/** The admin API of the project on screen; bound to its ref, so it follows in-app navigation. */
export const useAdmin = () => useProject().api
export const useCan = () => useProject().can
