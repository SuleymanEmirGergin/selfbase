// In-memory Provisioner: records every call, models ensure's idempotence (a container is created only when
// missing, changed or listed in recreate), and can be told to fail or to report states.
import { createHash } from 'node:crypto'
import type { EnsureInput, Provisioner, ProjectState, ServiceState } from '../src/provisioner.ts'
import { ProvisionerError } from '../src/provisioner.ts'

export const SERVICES = ['db', 'rest', 'core', 'fn', 'pooler']
type P = { network: boolean; controlAttached: boolean; services: Map<string, ServiceState> }

const missing = (service: string): ServiceState => ({ service, exists: false, state: null, health: null, specHash: null,
  templateVersion: null, memLimitMb: null, proxyAttached: false })

export class FakeProvisioner implements Provisioner {
  calls: { method: string; args: any[] }[] = []
  created = { networks: [] as string[], containers: [] as string[] }
  projects = new Map<string, P>()
  health: string | null = 'healthy'
  private failing = new Map<string, number>()
  private after = new Map<string, () => Promise<void> | void>()

  /** The next `times` calls of `method` throw a ProvisionerError. */
  fail(method: string, times = 1) { this.failing.set(method, times) }
  /** Runs once, after the next successful call of `method` (before it returns). */
  once(method: string, fn: () => Promise<void> | void) { this.after.set(method, fn) }
  callsOf(method: string) { return this.calls.filter((c) => c.method === method) }

  private async rec(method: string, args: any[]) {
    this.calls.push({ method, args })
    const n = this.failing.get(method) ?? 0
    if (n > 0) {
      this.failing.set(method, n - 1)
      throw new ProvisionerError('docker_refused', `fake ${method} failure`, 502)
    }
  }
  private async done(method: string) {
    const fn = this.after.get(method)
    this.after.delete(method)
    await fn?.()
  }
  state(ref: string): ProjectState {
    const p = this.projects.get(ref)
    return p
      ? { ref, network: p.network, controlAttached: p.controlAttached, services: SERVICES.map((s) => ({ ...(p.services.get(s) ?? missing(s)) })) }
      : { ref, network: false, controlAttached: false, services: SERVICES.map(missing) }
  }
  /** Changes one reported service (tests set states directly). */
  set(ref: string, service: string, patch: Partial<ServiceState>) {
    const p = this.projects.get(ref) ?? { network: true, controlAttached: true, services: new Map() }
    this.projects.set(ref, p)
    p.services.set(service, { ...(p.services.get(service) ?? missing(service)), ...patch })
  }
  /** A project as a successful ensure leaves it. */
  running(ref: string, templateVersion: string) {
    for (const s of SERVICES) this.set(ref, s, { exists: true, state: 'running', health: 'healthy', specHash: 'h', templateVersion, proxyAttached: s === 'core' })
  }

  async list() {
    await this.rec('list', [])
    return [...this.projects.keys()].sort().map((ref) => ({ ref, services: this.state(ref).services }))
  }
  async inspect(ref: string) {
    await this.rec('inspect', [ref])
    // the snapshot is taken first: a hook models a change that happens after the caller's read
    const s = this.state(ref)
    await this.done('inspect')
    return s
  }
  async ensure(input: EnsureInput & { recreate?: string[] }) {
    await this.rec('ensure', [input])
    const { ref, recreate = [] } = input
    let p = this.projects.get(ref)
    if (!p?.network) {
      this.created.networks.push(`sb-${ref}`)
      p = { network: true, controlAttached: false, services: p?.services ?? new Map() }
      this.projects.set(ref, p)
    }
    const hash = createHash('sha256').update(JSON.stringify({ ...input, recreate: undefined })).digest('hex')
    for (const s of SERVICES) {
      const cur = p.services.get(s)
      if (!cur?.exists || cur.specHash !== hash || recreate.includes(s)) {
        this.created.containers.push(`sb-${ref}-${s}`)
        p.services.set(s, { service: s, exists: true, state: 'running', health: this.health, specHash: hash,
          templateVersion: input.templateVersion, memLimitMb: null, proxyAttached: s === 'core' })
      } else {
        cur.state = 'running'
        if (s === 'core') cur.proxyAttached = true
      }
    }
    p.controlAttached = true
    await this.done('ensure')
    return this.state(ref)
  }
  private async setState(method: string, ref: string, services: string[] | undefined, state: string) {
    await this.rec(method, [ref, services])
    const p = this.projects.get(ref)
    for (const s of services ?? SERVICES) {
      const cur = p?.services.get(s)
      if (cur?.exists) cur.state = state
    }
    await this.done(method)
    return this.state(ref)
  }
  start(ref: string, services?: string[]) { return this.setState('start', ref, services, 'running') }
  stop(ref: string, services?: string[]) { return this.setState('stop', ref, services, 'exited') }
  async remove(ref: string, volumes: boolean) {
    await this.rec('remove', [ref, volumes])
    const p = this.projects.get(ref)
    this.projects.delete(ref)
    return { removed: { containers: p ? [...p.services.keys()].map((s) => `sb-${ref}-${s}`) : [], volumes: [], network: !!p?.network } }
  }
  async attachProxy(ref: string) {
    await this.rec('attachProxy', [ref])
    const core = this.projects.get(ref)?.services.get('core')
    if (core) core.proxyAttached = true
    return this.state(ref)
  }
  async runJob(ref: string, type: string, args: Record<string, unknown>, env: Record<string, string>) {
    await this.rec('runJob', [ref, type, args, env])
    return { id: `job-${type}` }
  }
  async jobStatus(ref: string, type: string) {
    await this.rec('jobStatus', [ref, type])
    return { status: 'succeeded' as const, exitCode: 0, tail: '' }
  }
  async logs(ref: string, service: string, tail: number) {
    await this.rec('logs', [ref, service, tail])
    return ''
  }
  async stats(ref: string, service: string) {
    await this.rec('stats', [ref, service])
    return { mem_usage_mb: 0, mem_limit_mb: 0, cpu_percent: 0 }
  }
}
