import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthApiError, AuthError, AuthSessionMissingError, SupabaseAuthClient, createClient, type AuthChangeEvent, type Session } from '../src/index.ts'
import { startFakeServer, type FakeServer } from './fake-server.ts'
import { ANON_KEY, SERVICE_KEY, installBrowser, signJwt, waitFor } from './helpers.ts'

let fake: FakeServer
let n = 0
const email = () => `user${++n}-${Date.now()}@example.test`
const noBrowser = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

beforeAll(async () => {
  fake = await startFakeServer()
})
afterAll(() => fake.close())
beforeEach(() => {
  Object.assign(fake.settings, { confirmEmail: false, expiresIn: 3600, failRefresh: false, refreshErrors: [], phoneEnabled: false })
  fake.requests.length = 0
})

function recorder(client: { auth: SupabaseAuthClient }) {
  const events: AuthChangeEvent[] = []
  client.auth.onAuthStateChange((e) => void events.push(e))
  return events
}

describe('session lifecycle', () => {
  let browser: ReturnType<typeof installBrowser>
  beforeEach(() => {
    browser = installBrowser()
  })
  afterEach(() => browser.uninstall())

  it('emits INITIAL_SESSION, SIGNED_IN, SIGNED_OUT in order and persists under sb-<host>-auth-token', async () => {
    const sb = createClient(fake.url, ANON_KEY)
    const events = recorder(sb)
    const addr = email()
    await sb.auth.signUp({ email: addr, password: 'secret123' })
    expect(browser.store.has('sb-127-auth-token')).toBe(true)
    await sb.auth.signOut()
    await sb.auth.signInWithPassword({ email: addr, password: 'secret123' })
    const stored = JSON.parse(browser.store.get('sb-127-auth-token')!) as Session
    expect(stored.user.email).toBe(addr)
    expect(stored.expires_at).toBeGreaterThan(Date.now() / 1000)
    expect(events).toEqual(['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT', 'SIGNED_IN'])
  })

  it('a new client restores the stored session; getSession/getUser return it', async () => {
    const a = createClient(fake.url, ANON_KEY)
    const addr = email()
    await a.auth.signUp({ email: addr, password: 'secret123' })
    const b = createClient(fake.url, ANON_KEY)
    const { data, error } = await b.auth.getSession()
    expect(error).toBeNull()
    expect(data.session?.user.email).toBe(addr)
    const u = await b.auth.getUser()
    expect(u.data.user?.email).toBe(addr)
    const userReq = fake.requests.at(-1)!
    expect(userReq.headers.apikey).toBe(ANON_KEY)
    expect(userReq.headers.authorization).toBe(`Bearer ${data.session!.access_token}`)
  })

  it('custom storageKey is honoured', async () => {
    const sb = createClient(fake.url, ANON_KEY, { auth: { storageKey: 'custom-key' } })
    await sb.auth.signUp({ email: email(), password: 'secret123' })
    expect(browser.store.has('custom-key')).toBe(true)
  })

  it('a storage event from another tab signs in and out', async () => {
    const other = createClient(fake.url, ANON_KEY)
    const { data } = await other.auth.signUp({ email: email(), password: 'secret123' })
    browser.store.clear()
    const sb = createClient(fake.url, ANON_KEY)
    const events = recorder(sb)
    await waitFor(() => events.length === 1)
    browser.fireStorage('sb-127-auth-token', JSON.stringify(data.session))
    await waitFor(() => events.length === 2)
    expect((await sb.auth.getSession()).data.session?.access_token).toBe(data.session!.access_token)
    browser.fireStorage('sb-127-auth-token', null)
    await waitFor(() => events.length === 3)
    expect(events).toEqual(['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'])
    expect((await sb.auth.getSession()).data.session).toBeNull()
  })
})

describe('auto refresh (fake time)', () => {
  let browser: ReturnType<typeof installBrowser>
  beforeEach(() => {
    browser = installBrowser()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    browser.uninstall()
  })

  it('refreshes 50-60 s before expiry (0-10 s jitter) and emits TOKEN_REFRESHED', async () => {
    fake.settings.expiresIn = 120
    const sb = createClient(fake.url, ANON_KEY)
    const events = recorder(sb)
    const { data } = await sb.auth.signUp({ email: email(), password: 'secret123' })
    const first = data.session!.access_token
    await vi.advanceTimersByTimeAsync(59_000)
    expect(events).not.toContain('TOKEN_REFRESHED')
    await vi.advanceTimersByTimeAsync(11_000)
    await waitFor(() => events.includes('TOKEN_REFRESHED'))
    const stored = JSON.parse(browser.store.get('sb-127-auth-token')!) as Session
    expect(stored.access_token).not.toBe(first)
    expect(fake.requests.some((r) => r.path === '/auth/v1/token?grant_type=refresh_token')).toBe(true)
  })

  it('a 400 from refresh removes the session and emits SIGNED_OUT', async () => {
    fake.settings.expiresIn = 120
    const sb = createClient(fake.url, ANON_KEY)
    const events = recorder(sb)
    await sb.auth.signUp({ email: email(), password: 'secret123' })
    fake.settings.failRefresh = true
    await vi.advanceTimersByTimeAsync(71_000)
    await waitFor(() => events.includes('SIGNED_OUT'))
    expect(browser.store.has('sb-127-auth-token')).toBe(false)
    expect((await sb.auth.getSession()).data.session).toBeNull()
  })

  it('a 500 from refresh keeps the session and retries; the retry succeeds', async () => {
    fake.settings.expiresIn = 120
    const sb = createClient(fake.url, ANON_KEY)
    const events = recorder(sb)
    await sb.auth.signUp({ email: email(), password: 'secret123' })
    fake.settings.refreshErrors = [500]
    await vi.advanceTimersByTimeAsync(71_000)
    await waitFor(() => fake.settings.refreshErrors.length === 0)
    await new Promise((r) => setImmediate(r))
    expect(events).not.toContain('SIGNED_OUT')
    expect(browser.store.has('sb-127-auth-token')).toBe(true)
    await vi.advanceTimersByTimeAsync(11_000)
    await waitFor(() => events.includes('TOKEN_REFRESHED'))
    expect(events).not.toContain('SIGNED_OUT')
  })

  it('getSession refreshes an expired stored session first', async () => {
    fake.settings.expiresIn = 30
    const a = createClient(fake.url, ANON_KEY, { auth: { autoRefreshToken: false } })
    const { data } = await a.auth.signUp({ email: email(), password: 'secret123' })
    const b = createClient(fake.url, ANON_KEY, { auth: { autoRefreshToken: false } })
    const s = (await b.auth.getSession()).data.session!
    expect(s.access_token).not.toBe(data.session!.access_token)
  })
})

describe('session in URL', () => {
  afterEach(() => (globalThis as any).window && delete (globalThis as any).window)

  it.each([
    ['signup', 'SIGNED_IN'],
    // a contested unconfirmed account has no password: its confirmation link carries type=recovery
    ['recovery', 'PASSWORD_RECOVERY'],
  ] as const)('a signup confirmation link with type=%s emits %s', async (type, expected) => {
    fake.settings.confirmEmail = true
    const seed = createClient(fake.url, ANON_KEY, noBrowser)
    const { data } = await seed.auth.signUp({ email: email(), password: 'secret123' })
    const user = fake.users.get(data.user!.id)!
    user.confirmed = true // what GET /verify does before redirecting
    const s = (await seed.auth.signInWithPassword({ email: user.email, password: 'secret123' })).data.session!
    const browser = installBrowser(`http://localhost:5173/#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&token_type=bearer&type=${type}`)
    const sb = createClient(fake.url, ANON_KEY)
    const events = recorder(sb)
    await waitFor(() => events.includes(expected))
    expect(events).not.toContain(expected === 'SIGNED_IN' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN')
    expect(browser.location.hash).toBe('')
    browser.uninstall()
  })

  it('parses #access_token, clears the hash and emits PASSWORD_RECOVERY for type=recovery', async () => {
    const seed = createClient(fake.url, ANON_KEY, noBrowser)
    const { data } = await seed.auth.signUp({ email: email(), password: 'secret123' })
    const s = data.session!
    const browser = installBrowser(
      `http://localhost:5173/reset-password?x=1#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&token_type=bearer&type=recovery`,
    )
    const sb = createClient(fake.url, ANON_KEY)
    const events = recorder(sb)
    await waitFor(() => events.includes('PASSWORD_RECOVERY'))
    expect(browser.location.hash).toBe('')
    expect(browser.location.href).toBe('http://localhost:5173/reset-password?x=1')
    expect((await sb.auth.getSession()).data.session?.user.id).toBe(s.user.id)
    expect(browser.store.has('sb-127-auth-token')).toBe(true)
    browser.uninstall()
  })

  it('parses #error=… into an AuthError with the code, clears the hash, no session', async () => {
    const browser = installBrowser(
      'http://localhost:5173/login#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    )
    const sb = createClient(fake.url, ANON_KEY)
    const { error } = await sb.auth.initialize()
    expect(error).toBeInstanceOf(AuthError)
    expect(error?.code).toBe('otp_expired')
    expect(error?.message).toBe('Email link is invalid or has expired')
    expect(browser.location.hash).toBe('')
    expect((await sb.auth.getSession()).data.session).toBeNull()
    browser.uninstall()
  })

  it('signInWithOAuth sends the browser to /auth/v1/authorize', async () => {
    const browser = installBrowser()
    const sb = createClient(fake.url, ANON_KEY)
    const { data, error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: 'http://localhost:5173/events' } })
    expect(error).toBeNull()
    expect(data.url).toBe(`${fake.url}/auth/v1/authorize?provider=google&redirect_to=http%3A%2F%2Flocalhost%3A5173%2Fevents`)
    expect(browser.location.assigned).toEqual([data.url])
    browser.uninstall()
  })
})

describe('auth methods without a browser', () => {
  it('wrong password: {data, error} with AuthApiError status/code/message, never throws', async () => {
    const sb = createClient(fake.url, ANON_KEY, noBrowser)
    const { data, error } = await sb.auth.signInWithPassword({ email: 'nobody@example.test', password: 'x' })
    expect(data).toEqual({ user: null, session: null })
    expect(error).toBeInstanceOf(AuthApiError)
    expect(error).toMatchObject({ status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' })
  })

  it('unconfirmed email: signUp returns user without session; sign in gives email_not_confirmed', async () => {
    fake.settings.confirmEmail = true
    const sb = createClient(fake.url, ANON_KEY, noBrowser)
    const addr = email()
    const { data, error } = await sb.auth.signUp({ email: addr, password: 'secret123', options: { emailRedirectTo: 'http://localhost:5173/x', data: { full_name: 'A' } } })
    expect(error).toBeNull()
    expect(data.session).toBeNull()
    expect(data.user?.email).toBe(addr)
    expect(fake.requests.at(-1)!.path).toBe('/auth/v1/signup?redirect_to=http%3A%2F%2Flocalhost%3A5173%2Fx')
    expect(JSON.parse(fake.requests.at(-1)!.body).data).toEqual({ full_name: 'A' })
    const again = await sb.auth.signUp({ email: addr, password: 'secret123' })
    expect(again.data.user?.identities).toEqual([])
    const signIn = await sb.auth.signInWithPassword({ email: addr, password: 'secret123' })
    expect(signIn.error?.code).toBe('email_not_confirmed')
  })

  it('weak password surfaces code weak_password', async () => {
    const sb = createClient(fake.url, ANON_KEY, noBrowser)
    const { error } = await sb.auth.signUp({ email: email(), password: '123' })
    expect(error).toMatchObject({ status: 422, code: 'weak_password' })
  })

  it('network failure returns an error instead of throwing', async () => {
    const sb = createClient('http://127.0.0.1:1', ANON_KEY, noBrowser)
    const { error } = await sb.auth.signInWithPassword({ email: 'a@example.test', password: 'secret123' })
    expect(error).toBeInstanceOf(AuthError)
    expect(error?.status).toBe(0)
  })

  it('getUser without a session is AuthSessionMissingError; getUser(jwt) uses the given token', async () => {
    const sb = createClient(fake.url, ANON_KEY, noBrowser)
    const missing = await sb.auth.getUser()
    expect(missing.error).toBeInstanceOf(AuthSessionMissingError)
    const { data } = await createClient(fake.url, ANON_KEY, noBrowser).auth.signUp({ email: email(), password: 'secret123' })
    const viaJwt = await sb.auth.getUser(data.session!.access_token)
    expect(viaJwt.data.user?.id).toBe(data.user!.id)
  })

  it('getUser() with a global Authorization header and no session asks the server with that header', async () => {
    const { data } = await createClient(fake.url, ANON_KEY, noBrowser).auth.signUp({ email: email(), password: 'secret123' })
    const sb = createClient(fake.url, ANON_KEY, { ...noBrowser, global: { headers: { Authorization: `Bearer ${data.session!.access_token}` } } })
    const { data: u, error } = await sb.auth.getUser()
    expect(error).toBeNull()
    expect(u.user?.id).toBe(data.user!.id)
  })

  it('updateUser merges metadata and emits USER_UPDATED; phone change is refused while phone is disabled', async () => {
    const sb = createClient(fake.url, ANON_KEY, noBrowser)
    const events = recorder(sb)
    await sb.auth.signUp({ email: email(), password: 'secret123', options: { data: { a: 1 } } })
    const { data, error } = await sb.auth.updateUser({ data: { b: 2 } })
    expect(error).toBeNull()
    expect(data.user?.user_metadata).toEqual({ a: 1, b: 2 })
    expect(events.at(-1)).toBe('USER_UPDATED')
    expect((await sb.auth.getSession()).data.session?.user.user_metadata).toEqual({ a: 1, b: 2 })
    const phone = await sb.auth.updateUser({ phone: '+900000000000' })
    expect(phone.error?.code).toBe('phone_provider_disabled')
    const verify = await sb.auth.verifyOtp({ type: 'phone_change', token: '123456', phone: '+900000000000' })
    expect(verify.error).toMatchObject({ status: 422, code: 'phone_provider_disabled' })
  })

  it('updateUser without a session is AuthSessionMissingError', async () => {
    const { error } = await createClient(fake.url, ANON_KEY, noBrowser).auth.updateUser({ data: { x: 1 } })
    expect(error).toBeInstanceOf(AuthSessionMissingError)
  })

  it('otp, recover and resend hit the GoTrue paths with redirect_to', async () => {
    const sb = createClient(fake.url, ANON_KEY, noBrowser)
    const r = 'http://localhost:5173/cb'
    expect((await sb.auth.signInWithOtp({ email: 'a@example.test', options: { shouldCreateUser: false, emailRedirectTo: r } })).error).toBeNull()
    expect((await sb.auth.resetPasswordForEmail('a@example.test', { redirectTo: r })).error).toBeNull()
    expect((await sb.auth.resend({ type: 'signup', email: 'a@example.test', options: { emailRedirectTo: r } })).error).toBeNull()
    const q = `?redirect_to=${encodeURIComponent(r)}`
    expect(fake.requests.map((x) => x.path)).toEqual([`/auth/v1/otp${q}`, `/auth/v1/recover${q}`, `/auth/v1/resend${q}`])
    expect(JSON.parse(fake.requests[0].body)).toMatchObject({ email: 'a@example.test', create_user: false })
    expect(JSON.parse(fake.requests[2].body)).toEqual({ type: 'signup', email: 'a@example.test' })
  })

  it('refreshSession rotates; reusing the old refresh token fails', async () => {
    const sb = createClient(fake.url, ANON_KEY, noBrowser)
    const events = recorder(sb)
    const { data } = await sb.auth.signUp({ email: email(), password: 'secret123' })
    const r = await sb.auth.refreshSession()
    expect(r.error).toBeNull()
    expect(r.data.session?.refresh_token).not.toBe(data.session!.refresh_token)
    expect(events).toContain('TOKEN_REFRESHED')
    const reuse = await createClient(fake.url, ANON_KEY, noBrowser).auth.refreshSession({ refresh_token: data.session!.refresh_token })
    expect(reuse.error?.status).toBe(400)
  })

  it('setSession with a valid token loads the user and emits SIGNED_IN', async () => {
    const { data } = await createClient(fake.url, ANON_KEY, noBrowser).auth.signUp({ email: email(), password: 'secret123' })
    const sb = createClient(fake.url, ANON_KEY, noBrowser)
    const events = recorder(sb)
    const r = await sb.auth.setSession({ access_token: data.session!.access_token, refresh_token: data.session!.refresh_token })
    expect(r.error).toBeNull()
    expect(r.data.user?.id).toBe(data.user!.id)
    expect(events).toContain('SIGNED_IN')
  })

  it('admin.listUsers / admin.deleteUser need the service key', async () => {
    const { data } = await createClient(fake.url, ANON_KEY, noBrowser).auth.signUp({ email: email(), password: 'secret123' })
    const anon = createClient(fake.url, ANON_KEY, noBrowser)
    expect((await anon.auth.admin.deleteUser(data.user!.id)).error?.status).toBe(403)
    const admin = createClient(fake.url, SERVICE_KEY, noBrowser)
    const list = await admin.auth.admin.listUsers({ perPage: 1000 })
    expect(list.data.users.some((u) => u.id === data.user!.id)).toBe(true)
    const total = fake.users.size
    expect(list.data).toMatchObject({ total, lastPage: 1, nextPage: null })
    const paged = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
    expect(paged.data).toMatchObject({ total, lastPage: total, nextPage: total > 1 ? 2 : null })
    expect(paged.data.users).toHaveLength(1)
    const del = await admin.auth.admin.deleteUser(data.user!.id)
    expect(del).toEqual({ data: { user: null }, error: null })
    expect(fake.requests.at(-1)!.body).toBe('')
    expect(fake.users.has(data.user!.id)).toBe(false)
    expect(fake.requests.at(-1)!.headers.authorization).toBe(`Bearer ${SERVICE_KEY}`)
  })

  it('signOut without a session still emits SIGNED_OUT and returns no error', async () => {
    const sb = createClient(fake.url, ANON_KEY, noBrowser)
    const events = recorder(sb)
    expect((await sb.auth.signOut()).error).toBeNull()
    await waitFor(() => events.length === 2)
    expect(events).toEqual(['INITIAL_SESSION', 'SIGNED_OUT'])
  })

  it('an expired token in setSession is refreshed instead', async () => {
    const { data } = await createClient(fake.url, ANON_KEY, noBrowser).auth.signUp({ email: email(), password: 'secret123' })
    const sb = createClient(fake.url, ANON_KEY, noBrowser)
    const expired = signJwt({ sub: data.user!.id, role: 'authenticated' }, -10)
    const r = await sb.auth.setSession({ access_token: expired, refresh_token: data.session!.refresh_token })
    expect(r.error).toBeNull()
    expect(r.data.session?.access_token).not.toBe(expired)
  })

  it('verifyOtp phone_change sends the session token; without a session it fails without calling the server', async () => {
    fake.settings.phoneEnabled = true
    const sb = createClient(fake.url, ANON_KEY, noBrowser)
    const before = fake.requests.length
    const none = await sb.auth.verifyOtp({ type: 'phone_change', token: '123456', phone: '+900000000000' })
    expect(none.error).toBeInstanceOf(AuthSessionMissingError)
    expect(fake.requests.length).toBe(before)
    const { data } = await sb.auth.signUp({ email: email(), password: 'secret123' })
    const r = await sb.auth.verifyOtp({ type: 'phone_change', token: '123456', phone: '+900000000000' })
    expect(r.error).toMatchObject({ status: 403, code: 'otp_expired' })
    const req = fake.requests.at(-1)!
    expect(req.path).toBe('/auth/v1/verify')
    expect(req.headers.authorization).toBe(`Bearer ${data.session!.access_token}`)
  })

  it('signOut refreshes an expiring token first so the server sees a valid one', async () => {
    fake.settings.expiresIn = 30
    const sb = createClient(fake.url, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data } = await sb.auth.signUp({ email: email(), password: 'secret123' })
    expect((await sb.auth.signOut()).error).toBeNull()
    const paths = fake.requests.slice(-2).map((r) => r.path)
    expect(paths).toEqual(['/auth/v1/token?grant_type=refresh_token', '/auth/v1/logout?scope=global'])
    expect(fake.requests.at(-1)!.headers.authorization).not.toBe(`Bearer ${data.session!.access_token}`)
  })

  it('a refresh still in flight when signOut runs is discarded', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let refreshStarted = false
    const slowFetch: typeof fetch = async (input, init) => {
      if (String(input).includes('grant_type=refresh_token')) {
        refreshStarted = true
        await gate
      }
      return fetch(input, init)
    }
    const sb = createClient(fake.url, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: slowFetch } })
    const events = recorder(sb)
    await sb.auth.signUp({ email: email(), password: 'secret123' })
    const pending = sb.auth.refreshSession()
    await waitFor(() => refreshStarted)
    await sb.auth.signOut()
    release()
    const r = await pending
    expect(r.data.session).toBeNull()
    expect(r.error).toBeInstanceOf(AuthSessionMissingError)
    expect((await sb.auth.getSession()).data.session).toBeNull()
    expect(events.slice(events.indexOf('SIGNED_OUT'))).toEqual(['SIGNED_OUT'])
  })

  it('a body stream error on a 2xx becomes {data: null, error}, not a throw', async () => {
    const broken: typeof fetch = async () =>
      new Response(new ReadableStream({ start: (c) => c.error(new Error('stream broke')) }), { status: 200 })
    const sb = createClient(fake.url, ANON_KEY, { ...noBrowser, global: { fetch: broken } })
    const { data, error } = await sb.auth.getUser('some.jwt.token')
    expect(data.user).toBeNull()
    expect(error).toBeInstanceOf(AuthError)
  })
})
