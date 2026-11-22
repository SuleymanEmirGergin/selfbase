// Supabase's per-service health (v1-get-services-health) from container health: auth, realtime and storage all live
// in core.
import type { ProjectState } from './provisioner.ts'

const CONTAINER: Record<string, string> = { db: 'db', rest: 'rest', auth: 'core', realtime: 'core', storage: 'core', pooler: 'pooler' }
export const HEALTH_SERVICES = Object.keys(CONTAINER)

export function servicesHealth(state: ProjectState, names: string[]) {
  return names.map((name) => {
    const s = state.services.find((x) => x.service === CONTAINER[name])
    const running = !!s?.exists && s.state === 'running'
    // null / 'none': the container has no health check, running is all we know
    const healthy = running && (s!.health === null || s!.health === 'none' || s!.health === 'healthy')
    const status = healthy ? 'ACTIVE_HEALTHY' : running && s!.health === 'starting' ? 'COMING_UP' : 'UNHEALTHY'
    return { name, healthy, status }
  })
}
