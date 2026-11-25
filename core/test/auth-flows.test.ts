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
    const claims = await verify(fragment(res).get('access_token')!)
    expect(claims.sub).toBe(s.user.id)
    // GoTrue's amr: what proved the session; control's password route reads it
    expect(claims.amr).toEqual([{ method: 'recovery', timestamp: expect.any(Number) }])
    // a password sign-in is no recovery session
    const pw = await (await call('POST', '/token?grant_type=password', { email: s.user.email, password: PW })).json()
    expect(JSON.stringify((await verify(pw.access_token)).amr ?? [])).not.toContain('recovery')
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
    const claims = await verify(fragment(res).get('access_token')!)
    expect(claims.sub).toBe(s.user.id)
    expect(claims.amr).toEqual([{ method: 'magiclink', timestamp: expect.any(Number) }])
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

  // contested unconfirmed account: nobody's password survives, the mailbox owner sets one after the link
  const signupAs = (e: string, password: string, who: string) =>
    call('POST', '/signup', { email: e, password, data: { who } })
  const passwordOk = async (e: string, password: string) =>
    (await call('POST', '/token?grant_type=password', { email: e, password })).status === 200
  const hashOf = async (e: string) =>
    (await pool.query('select encrypted_password from auth.users where email = $1', [e])).rows[0].encrypted_password
  /** Waits for background work, then the owner opens the (only) confirmation link and gets a session. */
  async function ownerConfirms(e: string) {
    await sleep(300)
    const res = await open(linkIn((await mails(e))[0].html))
    expect(fragment(res).get('access_token')).toBeTruthy()
    return fragment(res).get('type')
  }

  for (const [label, first, second] of [['attacker first', 'attacker', 'owner'], ['owner first', 'owner', 'attacker']]) {
    it(`contested signup (${label}): no password survives, the link gives type=recovery`, async () => {
      config.authConfirmEmail = true
      const e = email()
      const pw = { attacker: 'attacker-password', owner: 'owner-password' } as Record<string, string>
      expect((await signupAs(e, pw[first], first)).status).toBe(200)
      expect((await signupAs(e, pw[second], second)).status).toBe(200)
      expect(await ownerConfirms(e)).toBe('recovery')
      expect(await hashOf(e)).toBeNull()
      expect(await passwordOk(e, pw.attacker)).toBe(false)
      expect(await passwordOk(e, pw.owner)).toBe(false)
      // metadata becomes the latest signup's (GoTrue), not what the first one stored
      expect((await pool.query('select raw_user_meta_data from auth.users where email = $1', [e])).rows[0].raw_user_meta_data).toEqual({ who: second })
    })
  }

  it('AUTH_SET_PASSWORD_URL: a contested signup lands there (allowlisted) with type=recovery; a normal one keeps redirect_to', async () => {
    const saved = config.authSetPasswordUrl
    config.authConfirmEmail = true
    config.authSetPasswordUrl = 'http://localhost:5173/reset-password'
    try {
      const e = email()
      const signupTo = (pw: string) => app.request(`/auth/v1/signup?redirect_to=${encodeURIComponent('http://localhost:5173/welcome')}`, {
        method: 'POST', headers: { apikey: anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: pw }),
      })
      await signupTo('first-password')
      await signupTo('second-password')
      await sleep(300)
      const res = await open(linkIn((await mails(e))[0].html))
      expect(res.headers.get('location')!.split('#')[0]).toBe('http://localhost:5173/reset-password')
      expect(fragment(res).get('type')).toBe('recovery')

      const plain = email()
      const r = await app.request(`/auth/v1/signup?redirect_to=${encodeURIComponent('http://localhost:5173/welcome')}`, {
        method: 'POST', headers: { apikey: anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ email: plain, password: PW }),
      })
      expect(r.status).toBe(200)
      const ok = await open(linkIn((await mails(plain))[0].html))
      expect(ok.headers.get('location')!.split('#')[0]).toBe('http://localhost:5173/welcome')

      // outside the allowlist it falls back to SITE_URL like any redirect
      config.authSetPasswordUrl = 'https://evil.example.test/reset'
      const e2 = email()
      await signupAs(e2, 'first-password', 'a')
      await signupAs(e2, 'second-password', 'b')
      await sleep(300)
      const bad = await open(linkIn((await mails(e2))[0].html))
      expect(bad.headers.get('location')!.split('#')[0]).toBe(config.siteUrl)
    } finally {
      config.authSetPasswordUrl = saved
    }
  })

  it('looping repeat signups inside the window send no more mail and keep the hash null', async () => {
    config.authConfirmEmail = true
    const e = email()
    await signupAs(e, 'owner-password', 'owner')
    await mails(e)
    for (let i = 0; i < 5; i++) expect((await signupAs(e, `attacker-${i}-password`, 'attacker')).status).toBe(200)
    await sleep(300)
    expect(await mailCount(e)).toBe(1)
    expect(await hashOf(e)).toBeNull()
  })

  it('a double submit with the same password changes nothing and the link gives type=signup', async () => {
    config.authConfirmEmail = true
    const e = email()
    await signupAs(e, PW, 'owner')
    await mails(e)
    const before = await hashOf(e)
    await signupAs(e, PW, 'owner')
    await sleep(300)
    expect(await hashOf(e)).toBe(before)
    expect(await ownerConfirms(e)).toBe('signup')
    expect(await passwordOk(e, PW)).toBe(true)
  })

  it('magic link and recovery on an unconfirmed user drop the unproven password; signup link keeps it', async () => {
    for (const path of ['/otp', '/recover']) {
      const e = email()
      await signUpConfirmOn(e)
      await pool.query(`update auth.users set confirmation_sent_at = null where email = $1`, [e])
      await call('POST', path, { email: e, create_user: false })
      const res = await open(linkIn((await mails(e, 2))[1].html))
      expect(fragment(res).get('access_token'), path).toBeTruthy()
      const row = (await pool.query('select email_confirmed_at, encrypted_password from auth.users where email = $1', [e])).rows[0]
      expect(row.email_confirmed_at, path).toBeTruthy()
      expect(row.encrypted_password, path).toBeNull()
    }
    const e = email()
    await open(linkIn((await signUpConfirmOn(e)).html))
    expect((await pool.query('select encrypted_password from auth.users where email = $1', [e])).rows[0].encrypted_password).toBeTruthy()
  })

  it('two concurrent uses of one link: exactly one signs in', async () => {
    const link = linkIn((await signUpConfirmOn()).html)
    const results = await Promise.all([open(link), open(link)])
    expect(results.filter((r) => fragment(r).get('access_token')).length).toBe(1)
    expect(results.filter((r) => fragment(r).get('error_code') === 'otp_expired').length).toBe(1)
  })

  it('repeat signup of a confirmed email sends nothing', async () => {
    const s = await session()
    expect((await call('POST', '/signup', { email: s.user.email, password: PW })).status).toBe(200)
    await sleep(300)
    expect(await mailCount(s.user.email)).toBe(0)
  })

  const emailOf = async (id: string) => (await pool.query('select email, email_change from auth.users where id = $1', [id])).rows[0]
  /** PUT /user {email} and the two links: [to the new address, to the current one] */
  async function requestChange(s: { access_token: string; user: { id: string; email: string } }, next: string, count = 1) {
    const res = await call('PUT', '/user', { email: next }, s.access_token)
    expect(res.status).toBe(200)
    expect((await res.json()).email).toBe(s.user.email)
    return [linkIn((await mails(next, count)).at(-1).html), linkIn((await mails(s.user.email, count)).at(-1).html)]
  }

  it('AUTH_SECURE_EMAIL_CHANGE=false: one link to the new address applies the change', async () => {
    const saved = config.authSecureEmailChange
    config.authSecureEmailChange = false
    try {
      const s = await session()
      const next = email()
      const res = await call('PUT', '/user', { email: next }, s.access_token)
      expect(res.status).toBe(200)
      expect((await res.json()).email).toBe(s.user.email)
      const link = linkIn((await mails(next))[0].html)
      expect(new URL(link).searchParams.get('type')).toBe('email_change')
      await sleep(200)
      expect(await mailCount(s.user.email)).toBe(0)
      const v = await open(link)
      expect(fragment(v).get('type')).toBe('email_change')
      expect(await emailOf(s.user.id)).toEqual({ email: next, email_change: '' })
      const ident = (await pool.query(`select identity_data->>'email' as e from auth.identities where user_id = $1 and provider = 'email'`, [s.user.id])).rows[0]
      expect(ident.e).toBe(next)
    } finally {
      config.authSecureEmailChange = saved
    }
  })

  for (const order of ['new first', 'current first']) {
    it(`secure email change (${order}): applies only once both links are used`, async () => {
      const s = await session()
      const next = email()
      const [toNew, toCurrent] = await requestChange(s, next)
      const [first, second] = order === 'new first' ? [toNew, toCurrent] : [toCurrent, toNew]
      const step = await open(first)
      expect(fragment(step).get('access_token')).toBeNull()
      expect(fragment(step).get('message')).toMatch(/other email/)
      expect(await emailOf(s.user.id)).toEqual({ email: s.user.email, email_change: next })
      expect(fragment(await open(first)).get('error_code')).toBe('otp_expired') // single use
      const done = await open(second)
      expect(fragment(done).get('type')).toBe('email_change')
      expect(fragment(done).get('access_token')).toBeTruthy()
      expect(await emailOf(s.user.id)).toEqual({ email: next, email_change: '' })
    })
  }

  it('secure email change: one link alone, or with the other expired, changes nothing', async () => {
    const s = await session()
    const next = email()
    const [toNew, toCurrent] = await requestChange(s, next)
    await open(toNew)
    expect(await emailOf(s.user.id)).toEqual({ email: s.user.email, email_change: next })
    await pool.query(`update auth.one_time_tokens set created_at = now() - interval '2 hours' where user_id = $1`, [s.user.id])
    expect(fragment(await open(toCurrent)).get('error_code')).toBe('otp_expired')
    expect((await emailOf(s.user.id)).email).toBe(s.user.email)
  })

  it('secure email change: a new request invalidates both earlier links', async () => {
    const s = await session()
    const next = email()
    const [oldNew, oldCurrent] = await requestChange(s, next)
    await pool.query(`update auth.users set email_change_sent_at = now() - interval '61 seconds' where id = $1`, [s.user.id])
    const [toNew, toCurrent] = await requestChange(s, next, 2)
    expect(fragment(await open(oldNew)).get('error_code')).toBe('otp_expired')
    expect(fragment(await open(oldCurrent)).get('error_code')).toBe('otp_expired')
    await open(toCurrent)
    await open(toNew)
    expect(await emailOf(s.user.id)).toEqual({ email: next, email_change: '' })
  })
})

describe('safeRedirect', () => {
  it('allows exact, trailing * and ** patterns and rejects host tricks', () => {
    config.authRedirectAllowlist = ['https://allowed.example/**', 'http://localhost:8099/app/*', 'myapp://callback', 'https://exact.example/cb', 'http://localhost:3000']
    const site = config.siteUrl
    expect(safeRedirect(undefined)).toBe(site)
    expect(safeRedirect('')).toBe(site)
    expect(safeRedirect('myapp://callback')).toBe('myapp://callback')
    expect(safeRedirect('https://exact.example/cb')).toBe('https://exact.example/cb')
    expect(safeRedirect('https://exact.example/cb2')).toBe(site)
    expect(safeRedirect('https://allowed.example/')).toBe('https://allowed.example/')
    expect(safeRedirect('https://allowed.example/a/b?c=1')).toBe('https://allowed.example/a/b?c=1')
    expect(safeRedirect('http://localhost:8099/app/x/y')).toBe('http://localhost:8099/app/x/y')
    // an entry without a path is that origin's root, with or without the slash
    expect(safeRedirect('http://localhost:3000')).toBe('http://localhost:3000')
    expect(safeRedirect('http://localhost:3000/')).toBe('http://localhost:3000/')
    for (const bad of [
      'http://localhost:3000/x',
      'http://localhost:3000/?x=1',
      'http://localhost:3000.evil.com/',
      'http://localhost:3000@evil.com/',
      'http://localhost:30001/',
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
let hookStatus = 200
let redirectHits = 0
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
      if (hookStatus === 200) hookCalls.push({ headers: req.headers, body })
      res.statusCode = hookStatus
      if (hookStatus === 302) res.setHeader('location', `${fakeUrl}/redirected`)
      res.end('{}')
    } else if (req.url === '/redirected') {
      redirectHits++
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
let lastCookie = '' // the nonce cookie set by the last authorize(), "name=value"
let lastSetCookie = ''
async function authorize(redirectTo = 'http://localhost:5173/after') {
  const res = await app.request(`/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`)
  expect(res.status).toBe(302)
  lastSetCookie = res.headers.get('set-cookie') ?? ''
  lastCookie = lastSetCookie.split(';')[0]
  return new URL(res.headers.get('location')!)
}
const callback = (qs: string, cookie = lastCookie) => app.request(`/auth/v1/callback?${qs}`, { headers: { cookie } })
/** authorize + callback in one, with this flow's own cookie (safe to run concurrently). */
async function googleLogin(code = 'x') {
  const res = await app.request(`/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent('http://localhost:5173/after')}`)
  const state = new URL(res.headers.get('location')!).searchParams.get('state')!
  return callback(`code=${code}&state=${encodeURIComponent(state)}`, res.headers.get('set-cookie')!.split(';')[0])
}

describe('google oauth', () => {
  it('authorize redirects to Google with a signed state and no secret', async () => {
    useFakeGoogle()
    const loc = await authorize()
    expect(lastSetCookie).toMatch(/^sb-oauth-nonce=[\w-]+;/)
    expect(lastSetCookie).toContain('Path=/auth/v1/callback')
    expect(lastSetCookie).toContain('HttpOnly')
    expect(lastSetCookie).toContain('SameSite=Lax')
    expect(lastSetCookie).toContain('Max-Age=600')
    expect(lastSetCookie).not.toContain('Secure') // PUBLIC_URL is plain http://localhost in tests
    expect(lastCookie.split('=')[1]).toBe(JSON.parse(Buffer.from(loc.searchParams.get('state')!.split('.')[1], 'base64url').toString()).nonce)
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

  it('callback without this browser\'s nonce cookie is refused (login CSRF)', async () => {
    useFakeGoogle()
    const e = email()
    googleUser = { sub: String(randomInt(1e9, 9e9)), email: e, email_verified: true }
    const state = (await authorize()).searchParams.get('state')!
    const right = lastCookie
    const qs = `code=x&state=${encodeURIComponent(state)}`
    for (const cookie of ['', 'sb-oauth-nonce=someone-elses-nonce']) {
      const res = await callback(qs, cookie)
      expect(res.status).toBe(302)
      expect(fragment(res).get('error')).toBe('access_denied')
      expect(fragment(res).get('access_token')).toBeNull()
    }
    expect((await pool.query('select 1 from auth.users where email = $1', [e])).rowCount).toBe(0)
    const ok = await callback(qs, right)
    expect(fragment(ok).get('access_token')).toBeTruthy()
    expect(ok.headers.get('set-cookie')).toMatch(/^sb-oauth-nonce=;.*Max-Age=0/) // cleared
  })

  it('a confirmed password user keeps the password and gets the Google identity linked', async () => {
    useFakeGoogle()
    const s = await session()
    const before = (await pool.query('select encrypted_password from auth.users where id = $1', [s.user.id])).rows[0].encrypted_password
    googleUser = { sub: String(randomInt(1e9, 9e9)), email: s.user.email, email_verified: true }
    const res = await googleLogin()
    expect((await verify(fragment(res).get('access_token')!)).sub).toBe(s.user.id)
    const row = (await pool.query('select encrypted_password from auth.users where id = $1', [s.user.id])).rows[0]
    expect(row.encrypted_password).toBe(before)
    const providers = (await pool.query('select provider from auth.identities where user_id = $1 order by provider', [s.user.id])).rows
    expect(providers.map((r) => r.provider)).toEqual(['email', 'google'])
    config.authConfirmEmail = true
    expect((await call('POST', '/token?grant_type=password', { email: s.user.email, password: PW })).status).toBe(200)
  })

  it('a banned email user is refused before anything is linked or confirmed', async () => {
    useFakeGoogle()
    const e = email()
    await signUpConfirmOn(e)
    await pool.query(`update auth.users set banned_until = now() + interval '1 day' where email = $1`, [e])
    googleUser = { sub: String(randomInt(1e9, 9e9)), email: e, email_verified: true }
    const res = await googleLogin()
    expect(fragment(res).get('error_code')).toBe('user_banned')
    const row = (await pool.query('select id, email_confirmed_at, encrypted_password from auth.users where email = $1', [e])).rows[0]
    expect(row.email_confirmed_at).toBeNull()
    expect(row.encrypted_password).toBeTruthy()
    expect((await pool.query(`select 1 from auth.identities where user_id = $1 and provider = 'google'`, [row.id])).rowCount).toBe(0)
  })

  it('two concurrent first logins of one Google account end in the same user', async () => {
    useFakeGoogle()
    const e = email()
    googleUser = { sub: String(randomInt(1e9, 9e9)), email: e, email_verified: true }
    const [a, b] = await Promise.all([googleLogin('a'), googleLogin('b')])
    const subA = (await verify(fragment(a).get('access_token')!)).sub
    expect((await verify(fragment(b).get('access_token')!)).sub).toBe(subA)
    expect((await pool.query('select 1 from auth.users where email = $1', [e])).rowCount).toBe(1)
    expect((await pool.query('select 1 from auth.identities where user_id = $1', [subA])).rowCount).toBe(1)
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
      expect(res.headers.get('set-cookie'), String(s)).toMatch(/^sb-oauth-nonce=;.*Max-Age=0/) // nonce cleared
      const text = await res.text()
      expect(JSON.parse(text)).toMatchObject({ code: 400, error_code: 'bad_oauth_state' })
      expect(text).not.toContain(GOOGLE_SECRET)
    }
  })

  it('R2: a Google endpoint on a private address that is not allow-listed is never called (SSRF from an imported setting)', async () => {
    useFakeGoogle()
    // the same fake server, by a name that resolves to loopback: only 127.0.0.1 is in OUTBOUND_ALLOW_HOSTS (setup.ts)
    config.google = { ...config.google, userinfoUrl: `${fakeUrl.replace('127.0.0.1', 'localhost')}/userinfo` }
    googleUser = { sub: String(randomInt(1e9, 9e9)), email: email(), email_verified: true }
    const res = await googleLogin()
    expect(res.status).toBe(302)
    expect(fragment(res).get('error_description')).toBe('Unable to exchange external code')
    expect((await pool.query('select 1 from auth.users where email = $1', [googleUser.email])).rowCount).toBe(0)
    // a literal private address too, without a connection attempt
    config.google = { ...config.google, userinfoUrl: 'http://10.255.255.1:9/userinfo' }
    const t0 = Date.now()
    expect(fragment(await googleLogin()).get('error_description')).toBe('Unable to exchange external code')
    expect(Date.now() - t0).toBeLessThan(2000)
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

  const enablePhone = () => Object.assign(config, { authPhoneEnabled: true, fnUrl: fakeUrl,
    authSmsHookSecret: `v1,whsec_${Buffer.from('test-hook-secret-bytes').toString('base64')}` })
  /** PUT /user {phone}; returns the OTP the hook received. */
  async function requestOtp(jwt: string, p: string) {
    hookCalls.length = 0
    const res = await call('PUT', '/user', { phone: p }, jwt)
    expect(res.status).toBe(200)
    return JSON.parse(hookCalls[0].body).sms.otp as string
  }
  const guess = (jwt: string, p: string, token: string) => call('POST', '/verify', { type: 'phone_change', phone: p, token }, jwt)
  const wrongFor = (otp: string) => (otp === '000000' ? '111111' : '000000')
  const allowResend = (id: string) => pool.query(`update auth.users set phone_change_sent_at = now() - interval '61 seconds' where id = $1`, [id])
  const attemptsOf = async (id: string) =>
    (await pool.query(`select attempts from auth.one_time_tokens where user_id = $1 and token_type = 'phone_change_token'`, [id])).rows[0]?.attempts

  it('when enabled: signed hook gets a 6-digit OTP, /verify phone_change sets phone and phone_confirmed_at', async () => {
    const secret = Buffer.from('test-hook-secret-bytes').toString('base64')
    enablePhone()
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

    const wrong = await guess(s.access_token, p, wrongFor(payload.sms.otp))
    expect(wrong.status).toBe(403)
    expect(await wrong.json()).toMatchObject({ error_code: 'otp_expired' })

    const ok = await guess(s.access_token, p, payload.sms.otp)
    expect(ok.status).toBe(200)
    const sess = await ok.json()
    expect((await verify(sess.access_token)).sub).toBe(s.user.id)
    const row = (await pool.query('select phone, phone_confirmed_at, phone_change from auth.users where id = $1', [s.user.id])).rows[0]
    expect(row.phone).toBe(p)
    expect(row.phone_confirmed_at).toBeTruthy()
    expect(row.phone_change).toBe('')
    expect((await guess(s.access_token, p, payload.sms.otp)).status).toBe(403)
  })

  it('B: a code spent while a global logout ends the session leaves no live session behind', async () => {
    enablePhone()
    const s = await session()
    const p = phone()
    const otp = await requestOtp(s.access_token, p)
    const other = await (await call('POST', '/token?grant_type=password', { email: s.user.email, password: PW })).json()
    // the code's delete sleeps before it commits, so the logout lands between the spend and the apply
    await pool.query(`create table if not exists public.b_hold (user_id uuid primary key)`)
    await pool.query(`create or replace function public.b_ott() returns trigger language plpgsql as $$
      begin if exists (select 1 from public.b_hold where user_id = old.user_id) then perform pg_sleep(1.5); end if; return old; end $$`)
    await pool.query(`create or replace trigger b_ott after delete on auth.one_time_tokens for each row execute function public.b_ott()`)
    try {
      await pool.query('insert into public.b_hold values ($1)', [s.user.id])
      const verifying = guess(s.access_token, p, otp)
      for (let i = 0; !(await pool.query(`select 1 from pg_stat_activity where wait_event = 'PgSleep'
        and query like '%delete from auth.one_time_tokens%'`)).rowCount; i++) {
        if (i > 100) throw new Error('the verify never reached the trigger')
        await new Promise((r) => setTimeout(r, 20))
      }
      await pool.query('delete from public.b_hold')
      const logout = app.request('/auth/v1/logout?scope=global', { method: 'POST', headers: { authorization: `Bearer ${other.access_token}` } })
      const [v, l] = await Promise.all([verifying, logout])
      expect(l.status).toBe(204)
      // the phone may have changed while the session was live, but no session outlives the logout
      expect(v.status).toBe(403)
      expect((await pool.query('select 1 from auth.refresh_tokens where user_id = $1 and not revoked', [s.user.id])).rowCount).toBe(0)
    } finally {
      await pool.query('drop trigger if exists b_ott on auth.one_time_tokens')
      await pool.query('drop function if exists public.b_ott()')
      await pool.query('drop table if exists public.b_hold')
    }
  })

  it('verify needs the signed-in owner: anonymous is 401, another user cannot spend the attempts', async () => {
    enablePhone()
    const victim = await session()
    const p = phone()
    const otp = await requestOtp(victim.access_token, p)
    const anon = await guess(anonKey, p, wrongFor(otp))
    expect(anon.status).toBe(401)
    expect((await call('POST', '/verify', { type: 'phone_change', phone: p, token: otp }, 'x')).status).toBe(401) // bad JWT
    const attacker = await session()
    for (let i = 0; i < 6; i++) expect((await guess(attacker.access_token, p, wrongFor(otp))).status).toBe(403)
    expect((await guess(attacker.access_token, p, otp)).status).toBe(403)
    expect(await attemptsOf(victim.user.id)).toBe(0)
    expect((await guess(victim.access_token, p, otp)).status).toBe(200)
  })

  it('a code dies after 5 guesses: the 6th fails even when right; 4 wrong + right succeeds', async () => {
    enablePhone()
    const s = await session()
    const p = phone()
    const otp = await requestOtp(s.access_token, p)
    for (let i = 0; i < 5; i++) expect((await guess(s.access_token, p, wrongFor(otp))).status).toBe(403)
    expect((await guess(s.access_token, p, otp)).status).toBe(403)

    const s2 = await session()
    const p2 = phone()
    const otp2 = await requestOtp(s2.access_token, p2)
    for (let i = 0; i < 4; i++) expect((await guess(s2.access_token, p2, wrongFor(otp2))).status).toBe(403)
    expect((await guess(s2.access_token, p2, otp2)).status).toBe(200)
  })

  it('reissuing a code does not reset the guess count', async () => {
    enablePhone()
    const s = await session()
    const p = phone()
    const first = await requestOtp(s.access_token, p)
    for (let i = 0; i < 3; i++) expect((await guess(s.access_token, p, wrongFor(first))).status).toBe(403)
    await allowResend(s.user.id)
    await pool.query(`update auth.one_time_tokens set created_at = now() - interval '61 seconds' where user_id = $1`, [s.user.id])
    const second = await requestOtp(s.access_token, p)
    for (let i = 0; i < 2; i++) expect((await guess(s.access_token, p, wrongFor(second))).status).toBe(403)
    expect((await guess(s.access_token, p, second)).status).toBe(403)
  })

  it('SMS sends are 60 s apart per user: 429 over_sms_send_rate_limit', async () => {
    enablePhone()
    const s = await session()
    await requestOtp(s.access_token, phone())
    hookCalls.length = 0
    const other = phone()
    const res = await call('PUT', '/user', { phone: other }, s.access_token)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ code: 429, error_code: 'over_sms_send_rate_limit' })
    expect(hookCalls).toHaveLength(0)
    await allowResend(s.user.id)
    expect((await requestOtp(s.access_token, other))).toMatch(/^\d{6}$/)
  })

  it('one number gets one SMS per 60 s, whichever account asks', async () => {
    enablePhone()
    const a = await session()
    const b = await session()
    const p = phone()
    await requestOtp(a.access_token, p)
    hookCalls.length = 0
    const res = await call('PUT', '/user', { phone: p }, b.access_token)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error_code: 'over_sms_send_rate_limit' })
    expect(hookCalls).toHaveLength(0)
    await pool.query(`update auth.one_time_tokens set created_at = now() - interval '61 seconds' where user_id = $1`, [a.user.id])
    expect(await requestOtp(b.access_token, p)).toMatch(/^\d{6}$/)
  })

  it('a failed hook call gives the slot back, so the user can retry at once', async () => {
    enablePhone()
    const s = await session()
    const p = phone()
    hookStatus = 500
    try {
      const res = await call('PUT', '/user', { phone: p }, s.access_token)
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ error_code: 'unexpected_failure' })
    } finally {
      hookStatus = 200
    }
    // the change was recorded before the send; the retry sends at once and the code verifies
    expect((await pool.query('select phone_change from auth.users where id = $1', [s.user.id])).rows[0].phone_change).toBe(p)
    const otp = await requestOtp(s.access_token, p)
    expect((await guess(s.access_token, p, otp)).status).toBe(200)
  })

  it('a hook that answers with a redirect is a failed send, and core never follows it', async () => {
    enablePhone()
    const s = await session()
    redirectHits = 0
    hookStatus = 302
    try {
      const res = await call('PUT', '/user', { phone: phone() }, s.access_token)
      expect(res.status).toBe(500)
      expect(redirectHits).toBe(0)
    } finally {
      hookStatus = 200
    }
  })

  it('an empty AUTH_SMS_HOOK_SECRET refuses to send (500, generic error)', async () => {
    enablePhone()
    config.authSmsHookSecret = ''
    const s = await session()
    hookCalls.length = 0
    const res = await call('PUT', '/user', { phone: phone() }, s.access_token)
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error_code: 'unexpected_failure' })
    expect(hookCalls).toHaveLength(0)
  })
})
