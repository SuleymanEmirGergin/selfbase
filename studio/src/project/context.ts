import { createContext, useContext } from 'react'
import type { OrgRef, ProjectAdmin, ProjectDetail, Role } from '../api.ts'

export type Action = 'project.read' | 'project.write' | 'project.sql' | 'project.keys' | 'project.manage'

// Mirrors control's authz table (plan Task 10) so the UI renders only what the server would allow.
const GRANTS: Record<Role, Action[]> = {
  read_only: ['project.read'],
  developer: ['project.read', 'project.write', 'project.sql', 'project.keys'],
  administrator: ['project.read', 'project.write', 'project.sql', 'project.keys', 'project.manage'],
  owner: ['project.read', 'project.write', 'project.sql', 'project.keys', 'project.manage'],
}
export const can = (role: Role, action: Action) => GRANTS[role].includes(action)

export type ProjectCtx = {
  ref: string
  project: ProjectDetail
  org: OrgRef | undefined
  api: ProjectAdmin
  can: (action: Action) => boolean
  /** Reloads the project detail (status, services, last job). */
  reload: () => void
}

export const Ctx = createContext<ProjectCtx | null>(null)
export const useProject = () => useContext(Ctx)!
/** The admin API of the project on screen; bound to its ref, so it follows in-app navigation. */
export const useAdmin = () => useProject().api
export const useCan = () => useProject().can
