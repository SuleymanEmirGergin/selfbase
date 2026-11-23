// The one client module for control's /platform API (plan Tasks 10, 13, 14). Same origin, authenticated by the
// httpOnly session cookies; nothing from the session is kept in the browser beyond them. Contract fixes go here.

export class ApiError extends Error {
  status: number
  /** control's `error` code (e.g. account_exists), when the body had one */
  code: string
  constructor(status: number, message: string, code = '') {
    super(message)
    this.status = status
    this.code = code
  }
}

let signedOut = () => {}
/** Called when a 401 survives one refresh, so the app can return to the sign-in screen. */
export const onSignedOut = (fn: () => void) => { signedOut = fn }

type Opts = { body?: unknown; raw?: Blob; contentType?: string; form?: FormData; bearer?: string; onHeaders?: (h: Headers) => void }

// Paths whose 401 is an answer, not an expired session.
const NO_REFRESH = new Set(['/login', '/refresh', '/logout', '/invitations/accept'])
let refreshing: Promise<boolean> | null = null
// Concurrent 401s share one refresh call.
const refresh = () => (refreshing ??= fetch('/platform/refresh', { method: 'POST', credentials: 'same-origin' })
  .then((r) => r.ok, () => false)
  .finally(() => { refreshing = null }))

async function send(method: string, path: string, opts: Opts) {
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.raw) {
    body = opts.raw
    headers['content-type'] = opts.contentType || 'application/octet-stream'
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers['content-type'] = 'application/json'
  }
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  try {
    return await fetch('/platform' + path, { method, headers, body, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'Sunucuya ulaşılamadı')
  }
}

/** `path` is relative to /platform. On a 401 the session is refreshed once and the call retried; then sign-out. */
export async function request<T = unknown>(method: string, path: string, opts: Opts = {}): Promise<T> {
  let res = await send(method, path, opts)
  const bare = path.split('?')[0]
  if (res.status === 401 && !opts.bearer && !NO_REFRESH.has(bare)) {
    if (await refresh()) res = await send(method, path, opts)
    if (res.status === 401) signedOut()
  }
  opts.onHeaders?.(res.headers)
  const data = await res.json().catch(() => null)
  if (!res.ok)
    throw new ApiError(res.status, (data && (data.message || data.error_description || data.msg || data.error)) || `HTTP ${res.status}`,
      typeof data?.error === 'string' ? data.error : '')
  return data as T
}

const enc = encodeURIComponent
/** Object names keep their slashes; each segment is encoded. */
const encPath = (name: string) => name.split('/').map(enc).join('/')

// ---- platform types (Task 10 / 13 / 14 shapes) ----

export type Role = 'owner' | 'administrator' | 'developer' | 'read_only'
/** `role` is the org-wide role (null with only project memberships); `projects` the project-scoped roles (Task 10). */
export type OrgRef = { id: string; slug: string; name: string; role: Role | null; projects: { ref: string; role: Role }[] }
export type Me = { id: string; email: string; organizations: OrgRef[] }
export type Size = 'micro' | 'small' | 'medium'
export type Project = {
  id: string; ref: string; organization_id: string; name: string; region: string; status: string; created_at: string
  database: { host: string; version: string; postgres_engine: string; release_channel: string }
  size?: Size; certificate?: 'ok' | 'pending'
}
export type Job = {
  id: string; type: string; status: 'pending' | 'running' | 'succeeded' | 'failed'; step: number; steps: string[]
  error: string | null; events: { at: string; event: string }[]
}
export type Capacity = {
  budget_mb: number; reserved_mb: number; job_slot_mb: number; used_mb: number; free_mb: number
  projects: { ref: string; name: string; size: Size; cap_mb: number; status: string; mem_usage_mb: number | null }[]
  new_hosts_this_week: number; max_new_hosts_per_week: number
}
/** One row per membership: a user can have an org-wide and project-scoped rows; `id` addresses the row. */
export type Member = { id: string; user_id: string; email: string; role: Role; project_ref: string | null }
export type AccessToken = { id: string; name: string; created_at: string; last_used_at: string | null; expires_at: string | null }
export type AuditRow = {
  id: number | string; at: string; actor: string; org_id: string | null; project_id: string | null
  action: string; target: string | null; ip: string | null; details: { status?: number; body_keys?: string[] } | null
}
// Task 13 / 14 shapes for the project screens. ServiceState is the provisioner's; memUsageMb is our addition (null
// when unknown) so the home screen can show memory use next to the limit.
export type ServiceState = {
  service: string; exists: boolean; state: string; health: string; specHash: string; templateVersion: string
  memLimitMb: number; proxyAttached: boolean; memUsageMb?: number | null
}
export type JobRef = { id: string; type: string; status: Job['status']; step: number; error: string | null }
export type ProjectDetail = Project & {
  size: Size; template_version: string; current_template_version: string; urls: { api: string | null; legacy: string[] }
  certificate: 'ok' | 'pending'; smtp_configured: boolean; services: ServiceState[]; last_job: JobRef | null
}
/** The masked list: anon is a public key and comes in full; service_role is masked until revealed. */
export type ApiKey = { name: 'anon' | 'service_role'; api_key: string; type?: string }
export type Domain = { hostname: string; kind: 'default' | 'legacy' | 'custom' }
export type Backup = {
  id: string; kind: string; status: string; started_at: string; finished_at: string | null; size_bytes: number | null; location: string | null
}
export type LogService = 'db' | 'rest' | 'core' | 'fn' | 'pooler'
export type LogLine = { ts: string; msg: string }
export type ImportResult = { project: Project; job_id: string; ignored: string[]; unknown: string[] }

const org = (slug: string) => `/organizations/${enc(slug)}`
const prj = (ref: string) => `/projects/${enc(ref)}`

export const platform = {
  login: (email: string, password: string) => request<{ email: string }>('POST', '/login', { body: { email, password } }),
  logout: () => request('POST', '/logout'),
  me: () => request<Me>('GET', '/me'),
  recover: (email: string) => request('POST', '/auth/v1/recover', { body: { email } }),
  /** Sets a new password with the access token of a recovery link. */
  setPassword: (accessToken: string, password: string) => request('PUT', '/auth/v1/user', { body: { password }, bearer: accessToken }),
  /** Without a password: an address that already has an account, accepted while signed in as it. */
  acceptInvitation: (token: string, password?: string) =>
    request('POST', '/invitations/accept', { body: password === undefined ? { token } : { token, password } }),

  projects: (slug: string) => request<Project[]>('GET', `/projects?organization_slug=${enc(slug)}`),
  createProject: (p: { organization_slug: string; name: string; size: Size }) =>
    request<{ project: Project; job_id: string }>('POST', '/projects', { body: p }),
  importProject: (form: FormData) => request<ImportResult>('POST', '/projects/import', { form }),
  job: (id: string) => request<Job>('GET', `/jobs/${enc(id)}`),
  capacity: () => request<Capacity>('GET', '/capacity'),

  members: (slug: string) => request<Member[]>('GET', `${org(slug)}/members`),
  // without membershipId the user must have exactly one membership in the organization (else 409 ambiguous_membership)
  setRole: (slug: string, userId: string, role: Role, membershipId?: string) =>
    request('PATCH', `${org(slug)}/members/${enc(userId)}${membershipId ? `?membership_id=${enc(membershipId)}` : ''}`, { body: { role } }),
  removeMember: (slug: string, userId: string, membershipId?: string) =>
    request('DELETE', `${org(slug)}/members/${enc(userId)}${membershipId ? `?membership_id=${enc(membershipId)}` : ''}`),
  invite: (slug: string, inv: { email: string; role: Role; project_ref?: string }) =>
    request<{ id: string; expires_at: string; link?: string }>('POST', `${org(slug)}/invitations`, { body: inv }),

  tokens: () => request<AccessToken[]>('GET', '/access-tokens'),
  createToken: (name: string) => request<{ id: string; name: string; token: string }>('POST', '/access-tokens', { body: { name } }),
  deleteToken: (id: string) => request('DELETE', `/access-tokens/${enc(id)}`),

  project: (ref: string) => request<ProjectDetail>('GET', prj(ref)),
  pause: (ref: string) => request<{ job_id: string }>('POST', `${prj(ref)}/pause`),
  restore: (ref: string) => request<{ job_id: string }>('POST', `${prj(ref)}/restore`),
  upgrade: (ref: string) => request<{ job_id: string }>('POST', `${prj(ref)}/upgrade`),
  deleteProject: (ref: string, confirm_name: string) => request<{ job_id?: string }>('DELETE', prj(ref), { body: { confirm_name } }),
  apiKeys: (ref: string) => request<ApiKey[]>('GET', `${prj(ref)}/api-keys`),
  revealKey: (ref: string, name: ApiKey['name']) => request<{ api_key: string }>('POST', `${prj(ref)}/api-keys/reveal`, { body: { name } }),
  domains: (ref: string) => request<Domain[]>('GET', `${prj(ref)}/domains`),
  addDomain: (ref: string, d: { hostname: string; kind: 'legacy' | 'custom' }) => request<{ job_id: string }>('POST', `${prj(ref)}/domains`, { body: d }),
  removeDomain: (ref: string, hostname: string) => request<{ job_id: string }>('DELETE', `${prj(ref)}/domains`, { body: { hostname } }),
  backups: (ref: string) => request<Backup[]>('GET', `${prj(ref)}/backups`),
  backupNow: (ref: string) => request<{ job_id: string }>('POST', `${prj(ref)}/backups`),
  exportProject: (ref: string, passphrase: string) => request<{ job_id: string }>('POST', `${prj(ref)}/export`, { body: { passphrase } }),
  /** Newest first; `fromContainer` when control fell back to the container tail (x-selfbase-log-source: container). */
  logs: async (ref: string, service: LogService, limit = 200) => {
    let source = ''
    const lines = await request<LogLine[]>('GET', `${prj(ref)}/logs?service=${service}&limit=${limit}`, { onHeaders: (h) => { source = h.get('x-selfbase-log-source') ?? '' } })
    return { lines, fromContainer: source === 'container' }
  },

  auditLog: (slug: string, q: { limit: number; before?: string }) =>
    request<AuditRow[]>('GET', `${org(slug)}/audit-log?limit=${q.limit}${q.before ? `&before=${enc(q.before)}` : ''}`),
}

// ---- per-project admin API (v1's api object, forwarded by control to the project's core) ----

export type Column = { name: string; type: string; nullable: boolean; default: string | null; is_pk: boolean }
/** relkind is pg_class.relkind: r table, p partitioned table, v view, m materialized view, f foreign table. */
export type Relation = { schema: string; name: string; relkind: string; rls_enabled: boolean; row_estimate: number; columns: Column[] }
export type Row = Record<string, unknown>
export type Policy = {
  name: string; schema: string; table: string; command: string; roles: string[]
  using: string | null; check: string | null; permissive: boolean
}
export type SqlResult =
  | { columns: string[]; rows: unknown[][]; rowCount: number | null; durationMs: number; truncated?: boolean }
  | { error: { message: string; position: number | null; hint: string | null } }
export type User = {
  id: string; email: string; phone: string; email_confirmed_at: string | null; last_sign_in_at: string | null
  created_at: string; banned_until: string | null; identities: { provider: string }[]
}
export type Bucket = { id: string; name: string; public: boolean; created_at: string }
export type FileEntry = {
  name: string; id: string | null; updated_at: string | null
  metadata: { size?: number; mimetype?: string } | null
}

/** v1's admin methods (sign-in ones excluded: the platform session covers them) bound to /platform/projects/<ref>/admin. */
export function projectAdmin(ref: string) {
  const base = `/projects/${enc(ref)}/admin`
  const r = <T = unknown>(method: string, path: string, opts?: Opts) => request<T>(method, base + path, opts)
  return {
    schemas: () => r<string[]>('GET', '/schemas'),
    tables: (schema: string) => r<Relation[]>('GET', `/tables?schema=${enc(schema)}`),
    rows: (schema: string, table: string, q: { limit: number; offset: number; order?: string; filter?: string }) => {
      const p = new URLSearchParams({ limit: String(q.limit), offset: String(q.offset) })
      if (q.order) p.set('order', q.order)
      if (q.filter) p.set('filter', q.filter)
      return r<{ rows: Row[]; total: number }>('GET', `/rows/${enc(schema)}/${enc(table)}?${p}`)
    },
    insertRow: (schema: string, table: string, values: Row) =>
      r<Row>('POST', `/rows/${enc(schema)}/${enc(table)}`, { body: { values } }),
    updateRow: (schema: string, table: string, pk: Row, values: Row) =>
      r<Row>('PATCH', `/rows/${enc(schema)}/${enc(table)}`, { body: { pk, values } }),
    deleteRow: (schema: string, table: string, pk: Row) =>
      r<Row>('DELETE', `/rows/${enc(schema)}/${enc(table)}`, { body: { pk } }),

    policies: (schema: string) => r<Policy[]>('GET', `/policies?schema=${enc(schema)}`),
    createPolicy: (p: { schema: string; table: string; name: string; command: string; roles: string[]; using?: string; check?: string }) =>
      r('POST', '/policies', { body: p }),
    dropPolicy: (schema: string, table: string, name: string) => r('DELETE', '/policies', { body: { schema, table, name } }),
    setRls: (schema: string, table: string, enabled: boolean) => r('POST', '/rls', { body: { schema, table, enabled } }),

    sql: (query: string) => r<SqlResult>('POST', '/sql', { body: { query } }),

    users: (search: string, limit: number, offset: number) =>
      r<{ users: User[]; total: number }>('GET', `/users?search=${enc(search)}&limit=${limit}&offset=${offset}`),
    updateUser: (id: string, patch: { banned_until?: string | null; email_confirmed?: true }) =>
      r<User>('PATCH', `/users/${enc(id)}`, { body: patch }),
    deleteUser: (id: string) => r('DELETE', `/users/${enc(id)}`),

    buckets: () => r<Bucket[]>('GET', '/buckets'),
    createBucket: (id: string, isPublic: boolean) => r<Bucket>('POST', '/buckets', { body: { id, public: isPublic } }),
    files: (bucket: string, prefix: string) => r<FileEntry[]>('GET', `/files/${enc(bucket)}?prefix=${enc(prefix)}`),
    fileUrl: (bucket: string, name: string) => `/platform${base}/files/${enc(bucket)}/${encPath(name)}`,
    upload: (bucket: string, name: string, file: File) =>
      r('POST', `/files/${enc(bucket)}/${encPath(name)}`, { raw: file, contentType: file.type || 'application/octet-stream' }),
    deleteFile: (bucket: string, name: string) => r('DELETE', `/files/${enc(bucket)}/${encPath(name)}`),
  }
}

export type ProjectAdmin = ReturnType<typeof projectAdmin>

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
