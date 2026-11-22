// Thin client for the core's Admin API (core/src/admin). Same origin, authenticated by the httpOnly panel cookie;
// nothing from the session is kept in the browser beyond that cookie.

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let unauthorized = () => {}
/** Called on any 401 from a route other than /admin/login, so the app can return to the login screen. */
export const onUnauthorized = (fn: () => void) => { unauthorized = fn }

type Opts = { body?: unknown; raw?: Blob; contentType?: string }

export async function request<T = unknown>(method: string, path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (opts.raw) {
    body = opts.raw
    headers['content-type'] = opts.contentType || 'application/octet-stream'
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers['content-type'] = 'application/json'
  }
  let res: Response
  try {
    res = await fetch('/admin' + path, { method, headers, body, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'Sunucuya ulaşılamadı')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') unauthorized()
    throw new ApiError(res.status, (data && (data.error || data.message)) || `HTTP ${res.status}`)
  }
  return data as T
}

const enc = encodeURIComponent
/** Object names keep their slashes; each segment is encoded. */
const encPath = (name: string) => name.split('/').map(enc).join('/')

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

export const api = {
  login: (email: string, password: string) => request<{ email: string }>('POST', '/login', { body: { email, password } }),
  logout: () => request('POST', '/logout'),
  me: () => request<{ email: string }>('GET', '/me'),

  schemas: () => request<string[]>('GET', '/schemas'),
  tables: (schema: string) => request<Relation[]>('GET', `/tables?schema=${enc(schema)}`),
  rows: (schema: string, table: string, q: { limit: number; offset: number; order?: string; filter?: string }) => {
    const p = new URLSearchParams({ limit: String(q.limit), offset: String(q.offset) })
    if (q.order) p.set('order', q.order)
    if (q.filter) p.set('filter', q.filter)
    return request<{ rows: Row[]; total: number }>('GET', `/rows/${enc(schema)}/${enc(table)}?${p}`)
  },
  insertRow: (schema: string, table: string, values: Row) =>
    request<Row>('POST', `/rows/${enc(schema)}/${enc(table)}`, { body: { values } }),
  updateRow: (schema: string, table: string, pk: Row, values: Row) =>
    request<Row>('PATCH', `/rows/${enc(schema)}/${enc(table)}`, { body: { pk, values } }),
  deleteRow: (schema: string, table: string, pk: Row) =>
    request<Row>('DELETE', `/rows/${enc(schema)}/${enc(table)}`, { body: { pk } }),

  policies: (schema: string) => request<Policy[]>('GET', `/policies?schema=${enc(schema)}`),
  createPolicy: (p: { schema: string; table: string; name: string; command: string; roles: string[]; using?: string; check?: string }) =>
    request('POST', '/policies', { body: p }),
  dropPolicy: (schema: string, table: string, name: string) => request('DELETE', '/policies', { body: { schema, table, name } }),
  setRls: (schema: string, table: string, enabled: boolean) => request('POST', '/rls', { body: { schema, table, enabled } }),

  sql: (query: string) => request<SqlResult>('POST', '/sql', { body: { query } }),

  users: (search: string, limit: number, offset: number) =>
    request<{ users: User[]; total: number }>('GET', `/users?search=${enc(search)}&limit=${limit}&offset=${offset}`),
  updateUser: (id: string, patch: { banned_until?: string | null; email_confirmed?: true }) =>
    request<User>('PATCH', `/users/${enc(id)}`, { body: patch }),
  deleteUser: (id: string) => request('DELETE', `/users/${enc(id)}`),

  buckets: () => request<Bucket[]>('GET', '/buckets'),
  createBucket: (id: string, isPublic: boolean) => request<Bucket>('POST', '/buckets', { body: { id, public: isPublic } }),
  files: (bucket: string, prefix: string) => request<FileEntry[]>('GET', `/files/${enc(bucket)}?prefix=${enc(prefix)}`),
  fileUrl: (bucket: string, name: string) => `/admin/files/${enc(bucket)}/${encPath(name)}`,
  upload: (bucket: string, name: string, file: File) =>
    request('POST', `/files/${enc(bucket)}/${encPath(name)}`, { raw: file, contentType: file.type || 'application/octet-stream' }),
  deleteFile: (bucket: string, name: string) => request('DELETE', `/files/${enc(bucket)}/${encPath(name)}`),
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
