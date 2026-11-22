import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createHmac, randomInt, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { SignJWT } from 'jose'
import { app } from '../src/app.ts'
import { pool } from '../src/db.ts'
import { config } from '../src/config.ts'
import { verify } from '../src/jwt.ts'
import { safeRedirect } from '../src/auth/redirect.ts'

const PW = 'correct-horse-battery'
const anonKey = process.env.ANON_KEY!
const saved = structuredClone({ confirm: config.authConfirmEmail, phone: config.authPhoneEnabled, google: config.google,
  allow: config.authRedirectAllowlist, fnUrl: config.fnUrl, hook: config.authSmsHookSecret })
afterEach(() => {
  Object.assign(config, { authConfirmEmail: saved.confirm, authPhoneEnabled: saved.phone, google: { ...saved.google },
    authRedirectAllowlist: saved.allow, fnUrl: saved.fnUrl, authSmsHookSecret: saved.hook })
})

const email = () => `f-${randomUUID()}@example.test`
const call = (method: string, path: string, body?: unknown, token = anonKey) =>
  app.request(`/auth/v1${path}`, {
    method,
    headers: { apikey: anonKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Mails are sent in the background: poll mail_log until `count` mails to `to` exist. */
async function mails(to: string, count = 1) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query('select * from selfbase.mail_log where to_email = $1 order by id', [to])
    if (rows.length >= count) return rows
    await sleep(20)
  }
  throw new Error(`expected ${count} mail(s) to ${to}`)
}
const mailCount = async (to: string) =>
  (await pool.query('select count(*)::int as n from selfbase.mail_log where to_email = $1', [to])).rows[0].n
const linkIn = (html: string) => html.match(/href="([^"]+)"/)![1].replaceAll('&amp;', '&')
const open = (link: string) => {
  const u = new URL(link)
  return app.request(u.pathname + u.search)
}
const fragment = (res: Response) => new URLSearchParams(res.headers.get('location')!.split('#')[1])

async function signUpConfirmOn(e = email()) {
  config.authConfirmEmail = true
  const res = await call('POST', '/signup', { email: e, password: PW })
  expect(res.status).toBe(200)
  return (await mails(e))[0]
}
async function session(e = email()) {
  config.authConfirmEmail = false
  const s = await (await call('POST', '/signup', { email: e, password: PW })).json()
  config.authConfirmEmail = true
  return s
}

describe('email links', () => {
  beforeAll(async () => {
    await pool.query(`
      create table if not exists public.t3_confirm_updates (user_id uuid);
      create or replace function public.t3_count_confirm() returns trigger language plpgsql as $$
        begin insert into public.t3_confirm_updates values (new.id); return new; end $$;
      drop trigger if exists t3_count_confirm on auth.users;
      create trigger t3_count_confirm after update of email_confirmed_at on auth.users
        for each row execute function public.t3_count_confirm();`)
  })
  afterAll(async () => {
    await pool.query(`drop trigger if exists t3_count_confirm on auth.users;
      drop function if exists public.t3_count_confirm(); drop table if exists public.t3_confirm_updates;`)
  })

  it('signup link confirms the email, fires the users UPDATE trigger and signs in via the hash', async () => {
    const e = email()
    const mail = await signUpConfirmOn(e)
    expect(mail.subject).toBeTruthy()
    expect(mail.html).toContain(e)
    const link = linkIn(mail.html)
    expect(link.startsWith(`${config.publicUrl}/auth/v1/verify?`)).toBe(true)

    const res = await open(link)
    expect(res.status).toBe(302)
    const loc = res.headers.get('location')!
    expect(loc.startsWith(config.siteUrl)).toBe(true)
    const h = fragment(res)
    expect(h.get('type')).toBe('signup')
    expect(h.get('token_type')).toBe('bearer')
    expect(h.get('expires_in')).toBe('3600')
    expect(h.get('refresh_token')).toBeTruthy()
    const claims = await verify(h.get('access_token')!)
    const row = (await pool.query('select id, email_confirmed_at from auth.users where email = $1', [e])).rows[0]
    expect(claims.sub).toBe(row.id)
    expect(row.email_confirmed_at).toBeTruthy()
    expect((await pool.query('select 1 from public.t3_confirm_updates where user_id = $1', [row.id])).rowCount).toBeGreaterThan(0)
    // token stored hashed, never in clear
    const token = new URL(link).searchParams.get('token')!
    expect((await pool.query('select 1 from auth.one_time_tokens where token_hash = $1', [token])).rowCount).toBe(0)

    const again = await open(link)
    expect(again.status).toBe(302)
    expect(fragment(again).get('error_code')).toBe('otp_expired')
    expect(fragment(again).get('error')).toBe('access_denied')
    expect(fragment(again).get('access_token')).toBeNull()
  })

  it('an expired link is otp_expired', async () => {
    const e = email()
    const link = linkIn((await signUpConfirmOn(e)).html)
    await pool.query(`update auth.one_time_tokens set created_at = now() - interval '2 hours'
      where user_id = (select id from auth.users where email = $1)`, [e])
    expect(fragment(await open(link)).get('error_code')).toBe('otp_expired')
  })

  it('redirect_to outside the allowlist falls back to SITE_URL; an allowed one is kept', async () => {
    const s = await session()
    expect((await call('POST', '/recover?redirect_to=https://evil.example/x', { email: s.user.email })).status).toBe(200)
    const res = await open(linkIn((await mails(s.user.email))[0].html))
    expect(res.headers.get('location')!.startsWith(config.siteUrl)).toBe(true)
    expect(res.headers.get('location')).not.toContain('evil.example')

    // tampering the link itself does not help either
    await pool.query(`update auth.users set recovery_sent_at = null where id = $1`, [s.user.id])
    await call('POST', '/recover', { email: s.user.email })
    const u = new URL(linkIn((await mails(s.user.email, 2))[1].html))
    u.searchParams.set('redirect_to', 'https://evil.example')
    expect((await open(u.href)).headers.get('location')!.startsWith(`${config.siteUrl}#`)).toBe(true)

    await pool.query(`update auth.users set recovery_sent_at = null where id = $1`, [s.user.id])
    await call('POST', `/recover?redirect_to=${encodeURIComponent('http://localhost:5173/reset')}`, { email: s.user.email })
    const ok = await open(linkIn((await mails(s.user.email, 3))[2].html))
    expect(ok.headers.get('location')!.startsWith('http://localhost:5173/reset#')).toBe(true)
  })

  it('recovery link signs in with type=recovery', async () => {
    const s = await session()
    expect(await (await call('POST', '/recover', { email: s.user.email })).json()).toEqual({})
    const res = await open(linkIn((await mails(s.user.email))[0].html))
    expect(fragment(res).get('type')).toBe('recovery')
    expect((await verify(fragment(res).get('access_token')!)).sub).toBe(s.user.id)
  })

  it('/recover and /otp for an unknown email are 200 and send nothing', async () => {
    const e = email()
    expect((await call('POST', '/recover', { email: e })).status).toBe(200)
    expect((await call('POST', '/otp', { email: e, create_user: false })).status).toBe(200)
    await sleep(300)
    expect(await mailCount(e)).toBe(0)
    expect((await pool.query('select 1 from auth.users where email = $1', [e])).rowCount).toBe(0)
  })

  it('/otp sends a magic link that signs in with type=magiclink', async () => {
    const s = await session()
    expect((await call('POST', '/otp', { email: s.user.email, create_user: false })).status).toBe(200)
    const res = await open(linkIn((await mails(s.user.email))[0].html))
    expect(fragment(res).get('type')).toBe('magiclink')
    expect((await verify(fragment(res).get('access_token')!)).sub).toBe(s.user.id)
  })

  it('a link only verifies as its own type', async () => {
    const s = await session()
    await call('POST', '/recover', { email: s.user.email })
    const u = new URL(linkIn((await mails(s.user.email))[0].html))
    u.searchParams.set('type', 'magiclink')
    expect(fragment(await open(u.href)).get('error_code')).toBe('otp_expired')
  })

  it('/resend re-sends the signup mail, 429 inside the 60 s window', async () => {
    const e = email()
    await signUpConfirmOn(e)
    const r1 = await call('POST', '/resend', { type: 'signup', email: e })
    expect(r1.status).toBe(429)
    expect(await r1.json()).toMatchObject({ code: 429, error_code: 'over_email_send_rate_limit' })
    await pool.query(`update auth.users set confirmation_sent_at = now() - interval '61 seconds' where email = $1`, [e])
    expect((await call('POST', '/resend', { type: 'signup', email: e })).status).toBe(200)
    const both = await mails(e, 2)
    // the new link replaces the old one
    expect(fragment(await open(linkIn(both[0].html))).get('error_code')).toBe('otp_expired')
    expect(fragment(await open(linkIn(both[1].html))).get('access_token')).toBeTruthy()
    // a confirmed or unknown email gets a plain 200 and no mail
    expect((await call('POST', '/resend', { type: 'signup', email: e })).status).toBe(200)
    expect((await call('POST', '/resend', { type: 'signup', email: email() })).status).toBe(200)
    expect((await call('POST', '/resend', { type: 'nope', email: e })).status).toBe(400)
  })

  it('repeat signup of an unconfirmed email resends the confirmation, rate limited', async () => {
    const e = email()
    await signUpConfirmOn(e)
    expect((await call('POST', '/signup', { email: e, password: PW })).status).toBe(200)
    await sleep(300)
    expect(await mailCount(e)).toBe(1)
    await pool.query(`update auth.users set confirmation_sent_at = now() - interval '61 seconds' where email = $1`, [e])
    expect((await call('POST', '/signup', { email: e, password: PW })).status).toBe(200)
    await mails(e, 2)
  })

  it('repeat signup of a confirmed email sends nothing', async () => {
    const s = await session()
    expect((await call('POST', '/signup', { email: s.user.email, password: PW })).status).toBe(200)
    await sleep(300)
    expect(await mailCount(s.user.email)).toBe(0)
  })

  it('PUT /user with a new email sends a link to the new address that applies the change', async () => {
    const s = await session()
    const next = email()
    const res = await call('PUT', '/user', { email: next }, s.access_token)
    expect(res.status).toBe(200)
    expect((await res.json()).email).toBe(s.user.email)
    const link = linkIn((await mails(next))[0].html)
    expect(new URL(link).searchParams.get('type')).toBe('email_change')
    const v = await open(link)
    expect(fragment(v).get('type')).toBe('email_change')
    const row = (await pool.query('select email, email_change from auth.users where id = $1', [s.user.id])).rows[0]
    expect(row).toEqual({ email: next, email_change: '' })
    const ident = (await pool.query(`select identity_data->>'email' as e from auth.identities where user_id = $1 and provider = 'email'`, [s.user.id])).rows[0]
    expect(ident.e).toBe(next)
  })
})

describe('safeRedirect', () => {
  it('allows exact, trailing * and ** patterns and rejects host tricks', () => {
    config.authRedirectAllowlist = ['https://allowed.example/**', 'http://localhost:8099/app/*', 'myapp://callback', 'https://exact.example/cb']
    const site = config.siteUrl
    expect(safeRedirect(undefined)).toBe(site)
    expect(safeRedirect('')).toBe(site)
    expect(safeRedirect('myapp://callback')).toBe('myapp://callback')
    expect(safeRedirect('https://exact.example/cb')).toBe('https://exact.example/cb')
    expect(safeRedirect('https://exact.example/cb2')).toBe(site)
    expect(safeRedirect('https://allowed.example/')).toBe('https://allowed.example/')
    expect(safeRedirect('https://allowed.example/a/b?c=1')).toBe('https://allowed.example/a/b?c=1')
    expect(safeRedirect('http://localhost:8099/app/x/y')).toBe('http://localhost:8099/app/x/y')
    for (const bad of [
      'https://allowed.example.evil.com/',
      'https://evil.com/?https://allowed.example/',
      'https://allowed.example@evil.com/',
      'https://user:pw@allowed.example/',
      'http://allowed.example/',
      'https://allowed.example:444/',
      'http://localhost:8099/other',
      'http://localhost:80990/app/x',
      'javascript:alert(1)//allowed.example/',
      '//evil.com',
      'not a url',
    ]) expect(safeRedirect(bad), bad).toBe(site)
  })
})

// --- Google OAuth against a local fake -----------------------------------------------------------

let fake: Server
let fakeUrl: string
let lastTokenRequest: URLSearchParams | null = null
let googleUser: Record<string, unknown> = {}
let tokenStatus = 200
const readAll = async (req: IncomingMessage) => {
  let s = ''
  for await (const chunk of req) s += chunk
  return s
}
const hookCalls: { headers: IncomingMessage['headers']; body: string }[] = []

beforeAll(async () => {
  fake = createServer(async (req, res) => {
    const body = await readAll(req)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/token') {
      lastTokenRequest = new URLSearchParams(body)
      res.statusCode = tokenStatus
      res.end(JSON.stringify(tokenStatus === 200 ? { access_token: 'fake-google-access', token_type: 'Bearer' } : { error: 'invalid_grant' }))
    } else if (req.url === '/userinfo') {
      res.statusCode = req.headers.authorization === 'Bearer fake-google-access' ? 200 : 401
      res.end(JSON.stringify(googleUser))
    } else if (req.url === '/send-phone-otp-hook') {
      hookCalls.push({ headers: req.headers, body })
      res.end('{}')
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`
})
afterAll(() => new Promise<void>((r) => fake.close(() => r())))

const GOOGLE_SECRET = 'test-google-client-secret'
function useFakeGoogle() {
  config.google = { clientId: 'test-client-id', clientSecret: GOOGLE_SECRET, authUrl: `${fakeUrl}/auth`,
    tokenUrl: `${fakeUrl}/token`, userinfoUrl: `${fakeUrl}/userinfo` }
}
async function authorize(redirectTo = 'http://localhost:5173/after') {
  const res = await app.request(`/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`)
  expect(res.status).toBe(302)
  return new URL(res.headers.get('location')!)
}
const callback = (qs: string) => app.request(`/auth/v1/callback?${qs}`)

describe('google oauth', () => {
  it('authorize redirects to Google with a signed state and no secret', async () => {
    useFakeGoogle()
    const loc = await authorize()
    expect(loc.origin + loc.pathname).toBe(`${fakeUrl}/auth`)
    expect(loc.searchParams.get('client_id')).toBe('test-client-id')
    expect(loc.searchParams.get('redirect_uri')).toBe(`${config.publicUrl}/auth/v1/callback`)
    expect(loc.searchParams.get('response_type')).toBe('code')
    expect(loc.searchParams.get('scope')).toContain('email')
    expect(loc.searchParams.get('state')).toBeTruthy()
    expect(loc.href).not.toContain(GOOGLE_SECRET)
  })

  it('unsupported or unconfigured provider is 400', async () => {
    expect((await app.request('/auth/v1/authorize?provider=github')).status).toBe(400)
    config.google = { ...config.google, clientId: '' }
    expect((await app.request('/auth/v1/authorize?provider=google')).status).toBe(400)
  })

  it('callback creates a confirmed user with a google identity; the second login is the same user', async () => {
    useFakeGoogle()
    const e = email()
    const sub = String(randomInt(1e9, 9e9))
    googleUser = { sub, email: e, email_verified: true, name: 'Ayşe Test', picture: 'https://example.test/p.png' }
    const state = (await authorize()).searchParams.get('state')!
    const res = await callback(`code=abc&state=${encodeURIComponent(state)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')!.startsWith('http://localhost:5173/after#')).toBe(true)
    const h = fragment(res)
    expect(h.get('refresh_token')).toBeTruthy()
    expect(h.get('token_type')).toBe('bearer')
    const claims = await verify(h.get('access_token')!)
    expect(lastTokenRequest!.get('code')).toBe('abc')
    expect(lastTokenRequest!.get('client_secret')).toBe(GOOGLE_SECRET)
    expect(lastTokenRequest!.get('redirect_uri')).toBe(`${config.publicUrl}/auth/v1/callback`)

    const user = (await pool.query('select * from auth.users where email = $1', [e])).rows[0]
    expect(user.id).toBe(claims.sub)
    expect(user.email_confirmed_at).toBeTruthy()
    expect(user.raw_user_meta_data).toMatchObject({ name: 'Ayşe Test', email: e })
    const ids = (await pool.query('select * from auth.identities where user_id = $1', [user.id])).rows
    expect(ids).toHaveLength(1)
    expect(ids[0]).toMatchObject({ provider: 'google', provider_id: sub })

    const state2 = (await authorize()).searchParams.get('state')!
    const again = await callback(`code=def&state=${encodeURIComponent(state2)}`)
    expect((await verify(fragment(again).get('access_token')!)).sub).toBe(user.id)
    expect((await pool.query('select 1 from auth.identities where user_id = $1', [user.id])).rowCount).toBe(1)
  })

  it('callback links an existing email user and drops an unconfirmed password', async () => {
    useFakeGoogle()
    const e = email()
    await signUpConfirmOn(e) // unconfirmed, with a password nobody proved owning the email for
    googleUser = { sub: String(randomInt(1e9, 9e9)), email: e, email_verified: true, name: 'B' }
    const state = (await authorize()).searchParams.get('state')!
    const res = await callback(`code=x&state=${encodeURIComponent(state)}`)
    const user = (await pool.query('select * from auth.users where email = $1', [e])).rows[0]
    expect((await verify(fragment(res).get('access_token')!)).sub).toBe(user.id)
    expect(user.email_confirmed_at).toBeTruthy()
    expect(user.encrypted_password).toBeNull()
    expect(user.raw_app_meta_data.providers).toEqual(['email', 'google'])
  })

  it('unverified Google email is refused', async () => {
    useFakeGoogle()
    const e = email()
    googleUser = { sub: String(randomInt(1e9, 9e9)), email: e, email_verified: false }
    const state = (await authorize()).searchParams.get('state')!
    const res = await callback(`code=x&state=${encodeURIComponent(state)}`)
    expect(fragment(res).get('error')).toBeTruthy()
    expect((await pool.query('select 1 from auth.users where email = $1', [e])).rowCount).toBe(0)
  })

  it('missing, unsigned, tampered or expired state is 400', async () => {
    useFakeGoogle()
    const state = (await authorize()).searchParams.get('state')!
    const [h, p] = state.split('.')
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
    const evil = Buffer.from(JSON.stringify({ ...payload, redirect_to: 'https://evil.example' })).toString('base64url')
    const key = (s: string) => new TextEncoder().encode(s)
    const expired = await new SignJWT({ ...payload, exp: Math.floor(Date.now() / 1000) - 10 })
      .setProtectedHeader({ alg: 'HS256' }).sign(key(config.jwtSecret))
    const otherKey = await new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).sign(key('another-secret-that-is-32-chars-long!!'))
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`
    for (const s of [null, '', 'garbage', `${h}.${evil}.${state.split('.')[2]}`, expired, otherKey, unsigned, anonKey]) {
      const res = await callback(s === null ? 'code=x' : `code=x&state=${encodeURIComponent(s)}`)
      expect(res.status, String(s)).toBe(400)
      expect(await res.text()).not.toContain(GOOGLE_SECRET)
    }
  })

  it('a failing token exchange redirects with an error and never shows the secret', async () => {
    useFakeGoogle()
    tokenStatus = 400
    try {
      const state = (await authorize()).searchParams.get('state')!
      const res = await callback(`code=x&state=${encodeURIComponent(state)}`)
      expect(res.status).toBe(302)
      expect(fragment(res).get('error')).toBeTruthy()
      expect(res.headers.get('location')).not.toContain(GOOGLE_SECRET)
      expect(await res.text()).not.toContain(GOOGLE_SECRET)
    } finally {
      tokenStatus = 200
    }
  })
})

describe('phone', () => {
  const phone = () => `9055${randomInt(1e7, 9e7)}`

  it('is 422 phone_provider_disabled while AUTH_PHONE_ENABLED=false', async () => {
    const s = await session()
    const put = await call('PUT', '/user', { phone: phone() }, s.access_token)
    expect(put.status).toBe(422)
    expect(await put.json()).toMatchObject({ error_code: 'phone_provider_disabled' })
    const v = await call('POST', '/verify', { type: 'phone_change', phone: phone(), token: '123456' })
    expect(v.status).toBe(422)
    expect(await v.json()).toMatchObject({ error_code: 'phone_provider_disabled' })
  })

  it('when enabled: signed hook gets a 6-digit OTP, /verify phone_change sets phone and phone_confirmed_at', async () => {
    const secret = Buffer.from('test-hook-secret-bytes').toString('base64')
    Object.assign(config, { authPhoneEnabled: true, fnUrl: fakeUrl, authSmsHookSecret: `v1,whsec_${secret}` })
    const s = await session()
    const p = phone()
    hookCalls.length = 0
    expect((await call('PUT', '/user', { phone: p }, s.access_token)).status).toBe(200)
    expect(hookCalls).toHaveLength(1)
    const { headers, body } = hookCalls[0]
    const expected = createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64')
    expect(headers['webhook-signature']).toBe(`v1,${expected}`)
    const payload = JSON.parse(body)
    expect(payload.user.id).toBe(s.user.id)
    expect(payload.sms.otp).toMatch(/^\d{6}$/)

    const wrong = await call('POST', '/verify', { type: 'phone_change', phone: p, token: payload.sms.otp === '000000' ? '111111' : '000000' })
    expect(wrong.status).toBe(403)
    expect(await wrong.json()).toMatchObject({ error_code: 'otp_expired' })

    const ok = await call('POST', '/verify', { type: 'phone_change', phone: p, token: payload.sms.otp })
    expect(ok.status).toBe(200)
    const sess = await ok.json()
    expect((await verify(sess.access_token)).sub).toBe(s.user.id)
    const row = (await pool.query('select phone, phone_confirmed_at, phone_change from auth.users where id = $1', [s.user.id])).rows[0]
    expect(row.phone).toBe(p)
    expect(row.phone_confirmed_at).toBeTruthy()
    expect(row.phone_change).toBe('')
    expect((await call('POST', '/verify', { type: 'phone_change', phone: p, token: payload.sms.otp })).status).toBe(403)
  })
})
