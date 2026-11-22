// Client of the provisioner HTTP API (Task 7, spec 7.5): one method per route, same shapes. A failure becomes
// ProvisionerError(code, message) built from the provisioner's {error, message} only; a request body (it carries
// the project env) is never part of an error.
import { ApiError } from './errors.ts'

export type ServiceState = { service: string; exists: boolean; state: string | null; health: string | null
  specHash: string | null; templateVersion: string | null; memLimitMb: number | null; proxyAttached: boolean
  /** the container's address on sb-<ref> (core-addr.ts) */
  projectIp: string | null }
export type ProjectState = { ref: string; network: boolean; controlAttached: boolean; services: ServiceState[] }
export type EnsureInput = { ref: string; templateVersion: string; size: string; subnet: string; hosts: string[]
  env: Record<string, string> }
export type JobState = { status: 'running' | 'succeeded' | 'failed'; exitCode: number | null; tail: string }

export interface Provisioner {
  list(): Promise<{ ref: string; services: ServiceState[] }[]>
  inspect(ref: string): Promise<ProjectState>
  ensure(input: EnsureInput & { recreate?: string[] }): Promise<ProjectState>
  start(ref: string, services?: string[]): Promise<ProjectState>
  stop(ref: string, services?: string[]): Promise<ProjectState>
  remove(ref: string, volumes: boolean): Promise<{ removed: { containers: string[]; volumes: string[]; network: boolean } }>
  attachProxy(ref: string): Promise<ProjectState>
  runJob(ref: string, type: string, args: Record<string, unknown>, env: Record<string, string>): Promise<{ id: string }>
  /** A finished job is removed by the read that reports it: its terminal status is seen once. */
  jobStatus(ref: string, type: string): Promise<JobState>
  logs(ref: string, service: string, tail: number): Promise<string>
  stats(ref: string, service: string): Promise<{ mem_usage_mb: number; mem_limit_mb: number; cpu_percent: number }>
}

let current: Provisioner | undefined
/** The provisioner the HTTP routes use: server.ts sets the real one, tests a fake. */
export const setProvisioner = (p: Provisioner) => { current = p }
export const provisioner = (): Provisioner => {
  if (!current) throw new Error('provisioner: not set')
  return current
}

/** Always 502 to control's callers: the provisioner's own status (409 job_running, 404, ...) is in `upstream`. */
export class ProvisionerError extends ApiError {
  upstream: number
  constructor(code: string, message: string, upstream = 0) {
    super(502, code, message)
    this.upstream = upstream
  }
  /**
   * A refusal that the same request gets again (400 invalid_env from a render failure, invalid_service, invalid_dir,
   * 404 project_not_found or job_not_found, 409 subnet_conflict or backup_dir_unset, 501): a job step does not retry
   * it. 409 job_running (another job is still running) and transport failures (upstream 0) may pass.
   */
  get permanent(): boolean {
    return (this.upstream >= 400 && this.upstream < 500 && this.code !== 'job_running') || this.upstream === 501
  }
}

// The provisioner holds its jobs lock through an image pull (up to 120 s) and stops services one by one, each
// with its stop_grace_period; these bounds sit above both.
// reads of project state can wait behind the provisioner's per-ref and jobs locks
const STATE_MS = 180_000
const READ_MS = 60_000
const JOB_MS = 180_000
const MUTATE_MS = 600_000

export function httpProvisioner(url: string, token: string): Provisioner {
  const base = url.replace(/\/+$/, '')
  const seg = encodeURIComponent
  async function call<T>(method: string, path: string, ms: number, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      })
    } catch (e) {
      // name only: a fetch error's cause can carry the request
      const timeout = (e as Error).name === 'TimeoutError'
      throw new ProvisionerError(timeout ? 'provisioner_timeout' : 'provisioner_unreachable',
        timeout ? `provisioner did not answer ${method} ${path} within ${ms / 1000} s` : `provisioner unreachable (${(e as Error).name})`)
    }
    const text = await res.text()
    if (!res.ok) {
      let err: { error?: unknown; message?: unknown } = {}
      try { err = JSON.parse(text) } catch { /* not JSON: code from the status */ }
      throw new ProvisionerError(typeof err.error === 'string' ? err.error : `http_${res.status}`,
        typeof err.message === 'string' ? err.message : `provisioner answered ${res.status}`, res.status)
    }
    return (res.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text) as T
  }
  const p = (ref: string) => `/projects/${seg(ref)}`
  return {
    list: () => call('GET', '/projects', STATE_MS),
    inspect: (ref) => call('GET', p(ref), STATE_MS),
    ensure: ({ ref, ...body }) => call('POST', `${p(ref)}/ensure`, MUTATE_MS, body),
    start: (ref, services) => call('POST', `${p(ref)}/start`, MUTATE_MS, services ? { services } : {}),
    stop: (ref, services) => call('POST', `${p(ref)}/stop`, MUTATE_MS, services ? { services } : {}),
    remove: (ref, volumes) => call('DELETE', `${p(ref)}?volumes=${volumes}`, MUTATE_MS),
    attachProxy: (ref) => call('POST', `${p(ref)}/attach-proxy`, MUTATE_MS),
    runJob: (ref, type, args, env) => call('POST', `${p(ref)}/jobs`, JOB_MS, { type, args, env }),
    jobStatus: (ref, type) => call('GET', `${p(ref)}/jobs/${seg(type)}`, JOB_MS),
    logs: (ref, service, tail) => call('GET', `${p(ref)}/services/${seg(service)}/logs?tail=${tail}`, READ_MS),
    stats: (ref, service) => call('GET', `${p(ref)}/services/${seg(service)}/stats`, READ_MS),
  }
}
