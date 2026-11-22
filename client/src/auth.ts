import { resolveFetch } from './fetch.ts'
import type {
  AuthChangeEvent,
  Fetch,
  Provider,
  Session,
  Subscription,
  SupportedStorage,
  User,
  UserAttributes,
  VerifyOtpParams,
} from './types.ts'

/** Refresh this long before `expires_at`. */
const EXPIRY_MARGIN_MS = 60_000
const RETRY_REFRESH_MS = 10_000

export class AuthError extends Error {
  status: number | undefined
  code: string | undefined
  protected __isAuthError = true
  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = 'AuthError'
    this.status = status
    this.code = code
  }
}

export class AuthApiError extends AuthError {
  declare status: number
  constructor(message: string, status: number, code?: string) {
    super(message, status, code)
    this.name = 'AuthApiError'
  }
}

export class AuthSessionMissingError extends AuthError {
  constructor() {
    super('Auth session missing!', 400, 'session_missing')
    this.name = 'AuthSessionMissingError'
  }
}

export class AuthRetryableFetchError extends AuthError {
  constructor(message: string, status: number) {
    super(message, status)
    this.name = 'AuthRetryableFetchError'
  }
}

export class AuthWeakPasswordError extends AuthApiError {
  reasons: string[]
  constructor(message: string, status: number, reasons: string[]) {
    super(message, status, 'weak_password')
    this.name = 'AuthWeakPasswordError'
    this.reasons = reasons
  }
}

export class AuthImplicitGrantRedirectError extends AuthError {
  details: { error: string; code: string } | null
  constructor(message: string, details: { error: string; code: string } | null = null) {
    super(message, 500, details?.code)
    this.name = 'AuthImplicitGrantRedirectError'
    this.details = details
  }
}

export const isAuthError = (error: unknown): error is AuthError =>
  typeof error === 'object' && error !== null && '__isAuthError' in error

const isRetryable = (error: AuthError) => error instanceof AuthRetryableFetchError

/** supabase-js result shape: on failure every data field is null. */
export type Result<T> = { data: T; error: null } | { data: { [K in keyof T]: null }; error: AuthError }

export interface AuthClientOptions {
  url: string
  headers: Record<string, string>
  storageKey: string
  storage?: SupportedStorage
  persistSession?: boolean
  autoRefreshToken?: boolean
  detectSessionInUrl?: boolean
  fetch?: Fetch
  hasCustomAuthorizationHeader?: boolean
}

const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined'

function defaultStorage(): SupportedStorage {
  try {
    if (isBrowser() && window.localStorage) return window.localStorage
  } catch {
    // localStorage blocked (privacy mode); fall through to memory
  }
  const mem = new Map<string, string>()
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  }
}

const unref = (t: unknown) => {
  if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref(): void }).unref()
  else if (typeof t === 'number' && typeof (globalThis as any).Deno?.unrefTimer === 'function') (globalThis as any).Deno.unrefTimer(t)
}

const nowSec = () => Math.round(Date.now() / 1000)

function toSession(data: any): Session {
  return { ...data, expires_at: data.expires_at ?? nowSec() + Number(data.expires_in) }
}

const userFrom = (data: any): User | null => data?.user ?? (data?.id ? data : null)

const parseSession = (raw: string | null | undefined): Session | null => {
  try {
    const s = raw ? JSON.parse(raw) : null
    return s?.access_token && s.user ? s : null
  } catch {
    return null
  }
}

function decodeJwtPayload(token: string): any {
  const part = token.split('.')[1] ?? ''
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
}

async function toAuthError(res: Response): Promise<AuthError> {
  const text = await res.text().catch(() => '')
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // non-JSON error body
  }
  const message = body?.msg ?? body?.message ?? body?.error_description ?? body?.error ?? (text || `HTTP ${res.status}`)
  if ([502, 503, 504].includes(res.status)) return new AuthRetryableFetchError(message, res.status)
  const code = body?.error_code ?? (typeof body?.code === 'string' ? body.code : undefined)
  if (code === 'weak_password') return new AuthWeakPasswordError(message, res.status, body?.weak_password?.reasons ?? [])
  return new AuthApiError(message, res.status, code)
}

interface RequestOptions {
  body?: unknown
  jwt?: string
  redirectTo?: string
  query?: Record<string, string | undefined>
}

/** GoTrue HTTP helper shared by the user and admin APIs. Never throws for HTTP or network errors. */
class AuthHttp {
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
    readonly fetch: Fetch,
  ) {}

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<{ data: any; error: AuthError | null }> {
    const url = new URL(this.url + path)
    if (opts.redirectTo) url.searchParams.set('redirect_to', opts.redirectTo)
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v)
    const headers = new Headers(this.headers)
    if (opts.jwt) headers.set('Authorization', `Bearer ${opts.jwt}`)
    if (opts.body !== undefined) headers.set('Content-Type', 'application/json;charset=UTF-8')
    let res: Response
    try {
      res = await this.fetch(url.href, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
    } catch (e) {
      return { data: null, error: new AuthRetryableFetchError(e instanceof Error ? e.message : String(e), 0) }
    }
    if (!res.ok) return { data: null, error: await toAuthError(res) }
    const text = await res.text()
    try {
      return { data: text ? JSON.parse(text) : {}, error: null }
    } catch {
      return { data: {}, error: null }
    }
  }
}

export class AuthAdminApi {
  constructor(private http: AuthHttp) {}

  async deleteUser(id: string, shouldSoftDelete = false): Promise<Result<{ user: User | null }>> {
    const { data, error } = await this.http.request('DELETE', `/admin/users/${encodeURIComponent(id)}`, {
      body: { should_soft_delete: shouldSoftDelete },
    })
    return error ? { data: { user: null }, error } : { data: { user: userFrom(data) }, error: null }
  }

  // shortcut: pagination metadata is derived from the page itself, not from link/x-total-count headers; read headers if a caller pages through users
  async listUsers(params: { page?: number; perPage?: number } = {}): Promise<
    | { data: { users: User[]; aud: string; nextPage: number | null; lastPage: number; total: number }; error: null }
    | { data: { users: [] }; error: AuthError }
  > {
    const { data, error } = await this.http.request('GET', '/admin/users', {
      query: { page: params.page?.toString(), per_page: params.perPage?.toString() },
    })
    if (error) return { data: { users: [] }, error }
    const users: User[] = data.users ?? []
    return { data: { users, aud: data.aud ?? 'authenticated', nextPage: null, lastPage: 0, total: users.length }, error: null }
  }
}

export class SelfbaseAuthClient {
  admin: AuthAdminApi
  protected http: AuthHttp
  protected storage: SupportedStorage
  protected storageKey: string
  protected persistSession: boolean
  protected autoRefreshToken: boolean
  protected detectSessionInUrl: boolean
  protected hasCustomAuthorizationHeader: boolean
  protected session: Session | null = null
  protected subscribers = new Map<string, Subscription>()
  protected initializePromise: Promise<unknown>
  protected initError: AuthError | null = null
  protected refreshTimer: ReturnType<typeof setTimeout> | undefined
  protected refreshing: Promise<{ session: Session | null; error: AuthError | null }> | null = null

  constructor(options: AuthClientOptions) {
    this.http = new AuthHttp(options.url, options.headers, resolveFetch(options.fetch))
    this.admin = new AuthAdminApi(this.http)
    this.storageKey = options.storageKey
    this.storage = options.storage ?? defaultStorage()
    this.persistSession = options.persistSession ?? true
    this.autoRefreshToken = options.autoRefreshToken ?? true
    this.detectSessionInUrl = options.detectSessionInUrl ?? true
    this.hasCustomAuthorizationHeader = options.hasCustomAuthorizationHeader ?? false
    this.initializePromise = this.initialize()
    if (this.persistSession && isBrowser() && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', (e) => void this.onStorageEvent(e))
    }
  }

  /** Resolves once the session from the URL or storage is loaded. */
  async initialize(): Promise<{ error: AuthError | null }> {
    if (this.initializePromise) {
      await this.initializePromise
      return { error: this.initError }
    }
    try {
      if (this.detectSessionInUrl && isBrowser() && /(^#|&)(access_token|error|error_description)=/.test(window.location.hash)) {
        await this.sessionFromUrl()
        return { error: this.initError }
      }
      await this.recoverSession()
    } catch (e) {
      console.error('selfbase auth: initialize failed', e)
    }
    return { error: this.initError }
  }

  protected async sessionFromUrl() {
    const params = new URLSearchParams(window.location.hash.slice(1))
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    const error = params.get('error')
    if (error || params.get('error_description')) {
      this.initError = new AuthImplicitGrantRedirectError(params.get('error_description') ?? error ?? 'Error in URL', {
        error: error ?? 'unspecified_error',
        code: params.get('error_code') ?? 'unspecified_error',
      })
      await this.removeSession() // supabase-js parity: an error redirect drops the stored session
      return
    }
    const access_token = params.get('access_token')!
    const { data, error: userError } = await this.http.request('GET', '/user', { jwt: access_token })
    if (userError) {
      this.initError = userError
      await this.removeSession()
      return
    }
    const expiresIn = Number(params.get('expires_in') ?? 3600)
    const session: Session = {
      access_token,
      refresh_token: params.get('refresh_token') ?? '',
      expires_in: expiresIn,
      expires_at: params.get('expires_at') ? Number(params.get('expires_at')) : nowSec() + expiresIn,
      token_type: 'bearer',
      provider_token: params.get('provider_token'),
      provider_refresh_token: params.get('provider_refresh_token'),
      user: userFrom(data)!,
    }
    await this.saveSession(session)
    const event: AuthChangeEvent = params.get('type') === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN'
    setTimeout(() => void this.notify(event, session), 0)
  }

  protected async recoverSession() {
    const raw = await this.storage.getItem(this.storageKey)
    if (!raw) return
    const stored = parseSession(raw)
    if (!stored) {
      await this.removeSession()
      return
    }
    this.session = stored
    if (this.expiresSoon(stored) && this.autoRefreshToken) await this.callRefresh(stored.refresh_token)
    else this.scheduleRefresh(stored)
  }

  protected expiresSoon(s: Session) {
    return (s.expires_at ?? 0) * 1000 - Date.now() < EXPIRY_MARGIN_MS
  }

  protected async saveSession(session: Session) {
    this.session = session
    if (this.persistSession) await this.storage.setItem(this.storageKey, JSON.stringify(session))
    this.scheduleRefresh(session)
  }

  protected async removeSession() {
    this.session = null
    clearTimeout(this.refreshTimer)
    await this.storage.removeItem(this.storageKey)
  }

  protected scheduleRefresh(session: Session, delay?: number) {
    clearTimeout(this.refreshTimer)
    if (!this.autoRefreshToken) return
    const ms = delay ?? Math.max(0, (session.expires_at ?? 0) * 1000 - EXPIRY_MARGIN_MS - Date.now())
    this.refreshTimer = setTimeout(async () => {
      if (this.session !== session) return
      const { error } = await this.callRefresh(session.refresh_token)
      if (error && isRetryable(error) && this.session === session) this.scheduleRefresh(session, RETRY_REFRESH_MS)
    }, ms)
    unref(this.refreshTimer)
  }

  /** One refresh at a time, across tabs too (Web Locks), so a rotated refresh token is never reused. */
  protected callRefresh(refreshToken: string) {
    if (this.refreshing) return this.refreshing
    const run = async () => {
      if (this.persistSession) {
        // another tab may have refreshed while we waited for the lock
        const raw = await this.storage.getItem(this.storageKey)
        const stored = parseSession(raw)
        if (stored && stored.refresh_token !== refreshToken && !this.expiresSoon(stored)) {
          await this.saveSession(stored)
          await this.notify('TOKEN_REFRESHED', stored)
          return { session: stored, error: null }
        }
      }
      const { data, error } = await this.http.request('POST', '/token', {
        query: { grant_type: 'refresh_token' },
        body: { refresh_token: refreshToken },
      })
      if (error) {
        if (!isRetryable(error)) {
          const hadSession = this.session !== null
          await this.removeSession()
          if (hadSession) await this.notify('SIGNED_OUT', null)
        }
        return { session: null, error }
      }
      const session = toSession(data)
      await this.saveSession(session)
      await this.notify('TOKEN_REFRESHED', session)
      return { session, error: null }
    }
    const locks = (globalThis as any).navigator?.locks
    this.refreshing = (locks?.request ? (locks.request(`lock:${this.storageKey}`, run) as ReturnType<typeof run>) : run()).finally(
      () => (this.refreshing = null),
    )
    return this.refreshing
  }

  protected async onStorageEvent(e: StorageEvent) {
    if (e.key !== this.storageKey) return
    const next = parseSession(e.newValue)
    const prev = this.session
    if (!next) {
      if (!prev) return
      this.session = null
      clearTimeout(this.refreshTimer)
      await this.notify('SIGNED_OUT', null)
      return
    }
    this.session = next
    this.scheduleRefresh(next)
    await this.notify(prev?.user?.id === next.user?.id ? 'TOKEN_REFRESHED' : 'SIGNED_IN', next)
  }

  protected async notify(event: AuthChangeEvent, session: Session | null) {
    await Promise.all(
      [...this.subscribers.values()].map(async (s) => {
        try {
          await s.callback(event, session)
        } catch (e) {
          console.error(e)
        }
      }),
    )
  }

  onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void | Promise<void>): {
    data: { subscription: Subscription }
  } {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
    const subscription: Subscription = { id, callback, unsubscribe: () => void this.subscribers.delete(id) }
    this.subscribers.set(id, subscription)
    void (async () => {
      await this.initializePromise
      const { data } = await this.getSession()
      if (!this.subscribers.has(id)) return
      try {
        await callback('INITIAL_SESSION', data.session)
      } catch (e) {
        console.error(e)
      }
    })()
    return { data: { subscription } }
  }

  async getSession(): Promise<Result<{ session: Session | null }>> {
    await this.initializePromise
    const s = this.session
    if (!s || !this.expiresSoon(s)) return { data: { session: s }, error: null }
    const { session, error } = await this.callRefresh(s.refresh_token)
    return error ? { data: { session: null }, error } : { data: { session }, error: null }
  }

  async getUser(jwt?: string): Promise<Result<{ user: User | null }>> {
    let token = jwt
    if (!token) {
      const { data, error } = await this.getSession()
      if (error) return { data: { user: null }, error }
      token = data.session?.access_token
      if (!token && !this.hasCustomAuthorizationHeader) return { data: { user: null }, error: new AuthSessionMissingError() }
    }
    const { data, error } = await this.http.request('GET', '/user', { jwt: token })
    return error ? { data: { user: null }, error } : { data: { user: userFrom(data) }, error: null }
  }

  protected async sessionResult(data: any, event: AuthChangeEvent = 'SIGNED_IN') {
    const session = data?.access_token ? toSession(data) : null
    if (session) {
      await this.saveSession(session)
      await this.notify(event, session)
    }
    return { data: { user: session?.user ?? userFrom(data), session }, error: null }
  }

  async signUp(credentials: {
    email?: string
    phone?: string
    password: string
    options?: { emailRedirectTo?: string; data?: object; captchaToken?: string }
  }): Promise<Result<{ user: User | null; session: Session | null }>> {
    await this.initializePromise
    const { email, phone, password, options } = credentials
    const { data, error } = await this.http.request('POST', '/signup', {
      body: { email, phone, password, data: options?.data ?? {} },
      redirectTo: options?.emailRedirectTo,
    })
    if (error) return { data: { user: null, session: null }, error }
    return this.sessionResult(data)
  }

  async signInWithPassword(credentials: {
    email?: string
    phone?: string
    password: string
    options?: { captchaToken?: string }
  }): Promise<Result<{ user: User | null; session: Session | null }>> {
    await this.initializePromise
    const { email, phone, password } = credentials
    const { data, error } = await this.http.request('POST', '/token', {
      query: { grant_type: 'password' },
      body: { email, phone, password },
    })
    if (error) return { data: { user: null, session: null }, error }
    return this.sessionResult(data)
  }

  async signInWithOAuth(credentials: {
    provider: Provider
    options?: { redirectTo?: string; scopes?: string; queryParams?: Record<string, string>; skipBrowserRedirect?: boolean }
  }): Promise<Result<{ provider: Provider; url: string }>> {
    await this.initializePromise
    const { provider, options } = credentials
    const url = new URL(`${this.http.url}/authorize`)
    url.searchParams.set('provider', provider)
    if (options?.redirectTo) url.searchParams.set('redirect_to', options.redirectTo)
    if (options?.scopes) url.searchParams.set('scopes', options.scopes)
    for (const [k, v] of Object.entries(options?.queryParams ?? {})) url.searchParams.set(k, v)
    if (isBrowser() && !options?.skipBrowserRedirect) window.location.assign(url.href)
    return { data: { provider, url: url.href }, error: null }
  }

  async signInWithOtp(credentials: {
    email?: string
    phone?: string
    options?: { emailRedirectTo?: string; shouldCreateUser?: boolean; data?: object; captchaToken?: string }
  }): Promise<Result<{ user: null; session: null }>> {
    await this.initializePromise
    const { email, phone, options } = credentials
    const { error } = await this.http.request('POST', '/otp', {
      body: { email, phone, data: options?.data ?? {}, create_user: options?.shouldCreateUser ?? true },
      redirectTo: options?.emailRedirectTo,
    })
    return error ? { data: { user: null, session: null }, error } : { data: { user: null, session: null }, error: null }
  }

  async verifyOtp(params: VerifyOtpParams): Promise<Result<{ user: User | null; session: Session | null }>> {
    await this.initializePromise
    const { options, ...body } = params
    const { data, error } = await this.http.request('POST', '/verify', { body, redirectTo: options?.redirectTo })
    if (error) return { data: { user: null, session: null }, error }
    return this.sessionResult(data, params.type === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN')
  }

  async resend(params: {
    type: 'signup' | 'email_change' | 'sms' | 'phone_change'
    email?: string
    phone?: string
    options?: { emailRedirectTo?: string; captchaToken?: string }
  }): Promise<Result<{ user: null; session: null }>> {
    await this.initializePromise
    const { options, ...body } = params
    const { error } = await this.http.request('POST', '/resend', { body, redirectTo: options?.emailRedirectTo })
    return error ? { data: { user: null, session: null }, error } : { data: { user: null, session: null }, error: null }
  }

  async resetPasswordForEmail(
    email: string,
    options: { redirectTo?: string; captchaToken?: string } = {},
  ): Promise<{ data: {}; error: null } | { data: null; error: AuthError }> {
    await this.initializePromise
    const { error } = await this.http.request('POST', '/recover', { body: { email }, redirectTo: options.redirectTo })
    return error ? { data: null, error } : { data: {}, error: null }
  }

  async updateUser(
    attributes: UserAttributes,
    options: { emailRedirectTo?: string } = {},
  ): Promise<Result<{ user: User | null }>> {
    const { data: sessionData, error: sessionError } = await this.getSession()
    if (sessionError) return { data: { user: null }, error: sessionError }
    const session = sessionData.session
    if (!session) return { data: { user: null }, error: new AuthSessionMissingError() }
    const { data, error } = await this.http.request('PUT', '/user', {
      body: attributes,
      jwt: session.access_token,
      redirectTo: options.emailRedirectTo,
    })
    if (error) return { data: { user: null }, error }
    const user = userFrom(data)!
    const updated = { ...session, user }
    await this.saveSession(updated)
    await this.notify('USER_UPDATED', updated)
    return { data: { user }, error: null }
  }

  async refreshSession(current?: { refresh_token: string }): Promise<
    Result<{ user: User | null; session: Session | null }>
  > {
    await this.initializePromise
    const refreshToken = current?.refresh_token ?? this.session?.refresh_token
    if (!refreshToken) return { data: { user: null, session: null }, error: new AuthSessionMissingError() }
    const { session, error } = await this.callRefresh(refreshToken)
    return error
      ? { data: { user: null, session: null }, error }
      : { data: { user: session!.user, session }, error: null }
  }

  async setSession(current: { access_token: string; refresh_token: string }): Promise<
    Result<{ user: User | null; session: Session | null }>
  > {
    await this.initializePromise
    let exp = 0
    try {
      exp = Number(decodeJwtPayload(current.access_token).exp)
    } catch {
      return { data: { user: null, session: null }, error: new AuthError('Invalid JWT', 400, 'bad_jwt') }
    }
    if (exp * 1000 - Date.now() < EXPIRY_MARGIN_MS) return this.refreshSession({ refresh_token: current.refresh_token })
    const { data, error } = await this.http.request('GET', '/user', { jwt: current.access_token })
    if (error) return { data: { user: null, session: null }, error }
    const session: Session = {
      access_token: current.access_token,
      refresh_token: current.refresh_token,
      token_type: 'bearer',
      expires_in: exp - nowSec(),
      expires_at: exp,
      user: userFrom(data)!,
    }
    await this.saveSession(session)
    await this.notify('SIGNED_IN', session)
    return { data: { user: session.user, session }, error: null }
  }

  async signOut(options: { scope?: 'global' | 'local' | 'others' } = {}): Promise<{ error: AuthError | null }> {
    await this.initializePromise
    const scope = options.scope ?? 'global'
    const token = this.session?.access_token
    if (token) {
      const { error } = await this.http.request('POST', '/logout', { jwt: token, query: { scope } })
      // supabase-js parity: an already-gone session still signs out locally
      if (error && !(error instanceof AuthApiError && [401, 403, 404].includes(error.status))) return { error }
    }
    if (scope !== 'others') {
      await this.removeSession()
      await this.notify('SIGNED_OUT', null)
    }
    return { error: null }
  }
}
