import type { Fetch } from './types.ts'

export class FunctionsError extends Error {
  context: any
  constructor(message: string, name = 'FunctionsError', context?: any) {
    super(message)
    this.name = name
    this.context = context
  }
}

/** `context` is the raw Response, so callers can read `context.status` and `await context.json()`. */
export class FunctionsHttpError extends FunctionsError {
  constructor(context: Response) {
    super('Edge Function returned a non-2xx status code', 'FunctionsHttpError', context)
  }
}

export class FunctionsRelayError extends FunctionsError {
  constructor(context: Response) {
    super('Relay Error invoking the Edge Function', 'FunctionsRelayError', context)
  }
}

export class FunctionsFetchError extends FunctionsError {
  constructor(context: unknown) {
    super('Failed to send a request to the Edge Function', 'FunctionsFetchError', context)
  }
}

export interface FunctionInvokeOptions {
  headers?: Record<string, string>
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE'
  body?: File | Blob | ArrayBuffer | FormData | ReadableStream<Uint8Array> | Record<string, any> | string
  signal?: AbortSignal
}

export type FunctionsResponse<T> = { data: T; error: null; response?: Response } | { data: null; error: FunctionsError; response?: Response }

export class FunctionsClient {
  constructor(
    protected url: string,
    protected headers: Record<string, string>,
    protected fetch: Fetch,
  ) {}

  async invoke<T = any>(functionName: string, options: FunctionInvokeOptions = {}): Promise<FunctionsResponse<T>> {
    const headers = new Headers(this.headers)
    let body: BodyInit | undefined
    const b = options.body
    if (b !== undefined) {
      if (typeof Blob !== 'undefined' && b instanceof Blob) {
        headers.set('Content-Type', b.type || 'application/octet-stream')
        body = b
      } else if (b instanceof ArrayBuffer) {
        headers.set('Content-Type', 'application/octet-stream')
        body = b
      } else if (typeof b === 'string') {
        headers.set('Content-Type', 'text/plain')
        body = b
      } else if (b instanceof FormData || (typeof ReadableStream !== 'undefined' && b instanceof ReadableStream)) {
        body = b as BodyInit
      } else {
        headers.set('Content-Type', 'application/json')
        body = JSON.stringify(b)
      }
    }
    for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v)

    let response: Response
    try {
      response = await this.fetch(`${this.url}/${functionName}`, {
        method: options.method ?? 'POST',
        headers,
        body,
        signal: options.signal,
      })
    } catch (e) {
      return { data: null, error: new FunctionsFetchError(e) }
    }
    if (response.headers.get('x-relay-error') === 'true') return { data: null, error: new FunctionsRelayError(response), response }
    if (!response.ok) return { data: null, error: new FunctionsHttpError(response), response }

    const type = (response.headers.get('Content-Type') ?? 'text/plain').split(';')[0].trim()
    let data: any
    if (type === 'application/json') data = await response.json()
    else if (type === 'application/octet-stream' || type === 'application/pdf') data = await response.blob()
    else if (type === 'text/event-stream') data = response
    else if (type === 'multipart/form-data') data = await response.formData()
    else data = await response.text()
    return { data, error: null, response }
  }
}
