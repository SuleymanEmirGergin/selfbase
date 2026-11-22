import type { Fetch } from './types.ts'

export class StorageError extends Error {
  protected __isStorageError = true
  constructor(message: string) {
    super(message)
    this.name = 'StorageError'
  }
}

export class StorageApiError extends StorageError {
  status: number
  statusCode: string
  constructor(message: string, status: number, statusCode: string) {
    super(message)
    this.name = 'StorageApiError'
    this.status = status
    this.statusCode = statusCode
  }
}

export class StorageUnknownError extends StorageError {
  originalError: unknown
  constructor(message: string, originalError: unknown) {
    super(message)
    this.name = 'StorageUnknownError'
    this.originalError = originalError
  }
}

type Result<T> = { data: T; error: null } | { data: null; error: StorageError }

export interface FileObject {
  name: string
  bucket_id: string
  owner: string
  id: string
  updated_at: string
  created_at: string
  last_accessed_at: string
  metadata: Record<string, any>
  buckets?: unknown
}

export interface FileOptions {
  cacheControl?: string
  contentType?: string
  upsert?: boolean
  duplex?: string
  metadata?: Record<string, any>
  headers?: Record<string, string>
}

export interface SearchOptions {
  limit?: number
  offset?: number
  sortBy?: { column?: string; order?: string }
  search?: string
}

export type FileBody =
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | File
  | FormData
  | ReadableStream<Uint8Array>
  | URLSearchParams
  | string

const finalPath = (bucket: string, path: string) => `${bucket}/${path.replace(/^\/+/, '')}`

export class StorageFileApi {
  constructor(
    protected url: string,
    protected headers: Record<string, string>,
    protected bucketId: string,
    protected fetch: Fetch,
  ) {}

  protected async request(method: string, path: string, init: { body?: BodyInit | null; json?: unknown; headers?: Record<string, string> } = {}) {
    const headers = new Headers(this.headers)
    for (const [k, v] of Object.entries(init.headers ?? {})) headers.set(k, v)
    let body = init.body
    if (init.json !== undefined) {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(init.json)
    }
    try {
      const res = await this.fetch(`${this.url}${path}`, { method, headers, body, ...(isStream(body) ? { duplex: 'half' } : {}) } as RequestInit)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let err: any = null
        try {
          err = JSON.parse(text)
        } catch {
          // non-JSON error body
        }
        return {
          res: null,
          error: new StorageApiError(err?.message ?? err?.error ?? (text || `HTTP ${res.status}`), res.status, String(err?.statusCode ?? res.status)),
        }
      }
      return { res, error: null }
    } catch (e) {
      return { res: null, error: new StorageUnknownError(e instanceof Error ? e.message : String(e), e) }
    }
  }

  async upload(path: string, fileBody: FileBody, options: FileOptions = {}): Promise<Result<{ id: string; path: string; fullPath: string }>> {
    return this.uploadOrUpdate('POST', path, fileBody, options)
  }

  protected async uploadOrUpdate(method: string, path: string, fileBody: FileBody, options: FileOptions) {
    const headers: Record<string, string> = { 'x-upsert': String(options.upsert ?? false), ...options.headers }
    let body = fileBody as BodyInit
    if (!(fileBody instanceof FormData)) {
      // raw body: the content type travels as a header, like supabase-js does for non-Blob bodies
      const blobType = typeof Blob !== 'undefined' && fileBody instanceof Blob ? fileBody.type : ''
      headers['content-type'] = options.contentType ?? (blobType || 'text/plain;charset=UTF-8')
      headers['cache-control'] = `max-age=${options.cacheControl ?? '3600'}`
    }
    const cleanPath = path.replace(/^\/+/, '')
    const { res, error } = await this.request(method, `/object/${finalPath(this.bucketId, cleanPath)}`, { body, headers })
    if (error) return { data: null, error }
    const data = await res.json().catch(() => ({}))
    return { data: { path: cleanPath, id: data.Id ?? data.id, fullPath: data.Key ?? `${this.bucketId}/${cleanPath}` }, error: null }
  }

  async remove(paths: string[]): Promise<Result<FileObject[]>> {
    const { res, error } = await this.request('DELETE', `/object/${this.bucketId}`, { json: { prefixes: paths } })
    if (error) return { data: null, error }
    return { data: await res.json().catch(() => []), error: null }
  }

  async download(path: string): Promise<Result<Blob>> {
    const { res, error } = await this.request('GET', `/object/authenticated/${finalPath(this.bucketId, path)}`)
    if (error) return { data: null, error }
    return { data: await res.blob(), error: null }
  }

  async list(path?: string, options: SearchOptions = {}): Promise<Result<FileObject[]>> {
    const json = {
      limit: 100,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' },
      ...options,
      prefix: path ?? '',
    }
    const { res, error } = await this.request('POST', `/object/list/${this.bucketId}`, { json })
    if (error) return { data: null, error }
    return { data: await res.json(), error: null }
  }

  async createSignedUrl(
    path: string,
    expiresIn: number,
    options: { download?: string | boolean } = {},
  ): Promise<Result<{ signedUrl: string }>> {
    const { res, error } = await this.request('POST', `/object/sign/${finalPath(this.bucketId, path)}`, { json: { expiresIn } })
    if (error) return { data: null, error }
    const { signedURL } = await res.json()
    return { data: { signedUrl: encodeURI(`${this.url}${signedURL}${downloadQuery(options.download, signedURL.includes('?') ? '&' : '?')}`) }, error: null }
  }

  getPublicUrl(path: string, options: { download?: string | boolean } = {}): { data: { publicUrl: string } } {
    return { data: { publicUrl: encodeURI(`${this.url}/object/public/${finalPath(this.bucketId, path)}${downloadQuery(options.download, '?')}`) } }
  }
}

function downloadQuery(download: string | boolean | undefined, sep: string) {
  if (!download) return ''
  return `${sep}download=${download === true ? '' : download}`
}

const isStream = (b: unknown) => typeof ReadableStream !== 'undefined' && b instanceof ReadableStream

export class StorageClient {
  constructor(
    protected url: string,
    protected headers: Record<string, string>,
    protected fetch: Fetch,
  ) {}

  from(bucketId: string): StorageFileApi {
    return new StorageFileApi(this.url, this.headers, bucketId, this.fetch)
  }
}
