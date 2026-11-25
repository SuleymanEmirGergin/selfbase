import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { pool } from '../db.ts'
import { config } from '../config.ts'
import type { AppEnv } from '../jwt.ts'
import { authError, createUser, findByEmail, findById, withTx } from './users.ts'
import type { UserRow } from './users.ts'
import { issueSession, isBanned } from './sessions.ts'
import { safeRedirect, sessionParams, withFragment } from './redirect.ts'
import { logLine } from '../log.ts'
import { guardedRequest } from '../netguard.ts'

const router = new Hono<AppEnv>()
const stateKey = new TextEncoder().encode(config.jwtSecret)
// own audience and no role claim: a state token is never accepted as an API key, and no API key passes as a state
const STATE_AUD = 'selfbase:oauth-state'
const callbackUrl = () => `${config.publicUrl}/auth/v1/callback`
const NONCE_COOKIE = 'sb-oauth-nonce'
const nonceCookie = () => {
  const u = new URL(config.publicUrl)
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  return { path: '/auth/v1/callback', httpOnly: true, sameSite: 'Lax' as const, secure: !local }
}

router.get('/authorize', async (c) => {
  // the nonce cookie is host-only and the callback is PUBLIC_URL's: a flow started on another host (legacy, custom)
  // moves there first. Hostnames only: cookies do not separate ports.
  const here = new URL(c.req.url)
  if (here.hostname !== new URL(config.publicUrl).hostname) return c.redirect(`${config.publicUrl}/auth/v1/authorize${here.search}`, 302)
  if (c.req.query('provider') !== 'google' || !config.google.clientId)
    throw authError(400, 'validation_failed', 'Unsupported provider: provider is not enabled')
  const nonce = randomBytes(16).toString('base64url')
  const state = await new SignJWT({ redirect_to: safeRedirect(c.req.query('redirect_to')), nonce })
    .setProtectedHeader({ alg: 'HS256' }).setAudience(STATE_AUD).setIssuedAt().setExpirationTime('10m').sign(stateKey)
  // binds the flow to this browser: a callback URL sent to someone else lacks the cookie (login CSRF)
  setCookie(c, NONCE_COOKIE, nonce, { ...nonceCookie(), maxAge: 600 })
  const q = new URLSearchParams({ client_id: config.google.clientId, redirect_uri: callbackUrl(), response_type: 'code', scope: 'openid email profile', state })
  return c.redirect(`${config.google.authUrl}?${q}`, 302)
})

type GoogleProfile = { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown; picture?: unknown }

/**
 * Exchanges the code and reads the profile; null on any failure. Never logs or returns the client secret. Both calls go
 * through the outbound guard: the endpoints are settings, and core is on the shared proxy network.
 */
async function googleProfile(code: string): Promise<GoogleProfile | null> {
  const { clientId, clientSecret, tokenUrl, userinfoUrl } = config.google
  const allow = config.outboundAllowHosts
  try {
    const t = await guardedRequest(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: callbackUrl(), grant_type: 'authorization_code' }).toString(),
      timeoutMs: 10_000,
    }, allow)
    if (t.status < 200 || t.status > 299) {
      logLine('error', `google token exchange failed: ${t.status}`)
      return null
    }
    const { access_token } = JSON.parse(t.body)
    const u = await guardedRequest(userinfoUrl, { headers: { authorization: `Bearer ${access_token}` }, timeoutMs: 10_000 }, allow)
    if (u.status < 200 || u.status > 299) {
      logLine('error', `google userinfo failed: ${u.status}`)
      return null
    }
    return JSON.parse(u.body)
  } catch (err: any) {
    logLine('error', `google oauth failed: ${err?.name ?? 'error'}`)
    return null
  }
}

/** The user behind a Google account: by identity, else by email (linked), else a new confirmed user. */
async function googleUser(sub: string, email: string, p: GoogleProfile): Promise<UserRow> {
  const name = typeof p.name === 'string' ? p.name : undefined
  const picture = typeof p.picture === 'string' ? p.picture : undefined
  const data = { iss: 'https://accounts.google.com', sub, provider_id: sub, email, email_verified: true, phone_verified: false,
    name, full_name: name, picture, avatar_url: picture }
  const known = (await pool.query(
    `update auth.identities set identity_data = $2, last_sign_in_at = now(), updated_at = now()
     where provider = 'google' and provider_id = $1 returning user_id`, [sub, data])).rows[0]
  if (known) return (await findById(known.user_id))!

  let existing = await findByEmail(email)
  // a banned user is returned untouched: nothing is linked or confirmed, the caller refuses the sign-in
  if (existing && isBanned(existing)) return existing
  const user = existing ?? (await createUser({ email, user_metadata: data, provider: 'google' }).catch(async (err) => {
    // a concurrent first login created it: link to that user
    if (err.code === '23505' && (existing = await findByEmail(email))) return existing
    throw err
  }))
  try {
    await withTx(async (tx) => {
      await tx.query(`insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at) values ($1, $2, $3, 'google', now())`,
        [sub, user.id, data])
      // linking: Google proved the address, so it is confirmed now; a password set before anyone proved owning
      // the address (pre-account takeover) is dropped
      if (existing)
        await tx.query(
          `update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()),
             encrypted_password = case when email_confirmed_at is null then null else encrypted_password end,
             raw_app_meta_data = case when raw_app_meta_data -> 'providers' ? 'google' then raw_app_meta_data
               else jsonb_set(coalesce(raw_app_meta_data, '{}'), '{providers}', coalesce(raw_app_meta_data -> 'providers', '[]') || '["google"]') end,
             updated_at = now() where id = $1`, [user.id])
    })
  } catch (err: any) {
    // a concurrent first login linked this Google account already: use its user
    const winner = err.code === '23505'
      && (await pool.query(`select user_id from auth.identities where provider = 'google' and provider_id = $1`, [sub])).rows[0]
    if (!winner) throw err
    return (await findById(winner.user_id))!
  }
  return (await findById(user.id))!
}

router.get('/callback', async (c) => {
  // the nonce cookie is single use: cleared on every callback, accepted or not
  const cookieNonce = getCookie(c, NONCE_COOKIE)
  deleteCookie(c, NONCE_COOKIE, nonceCookie())
  let target: string
  let nonce: unknown
  try {
    const { payload } = await jwtVerify(c.req.query('state') ?? '', stateKey, { audience: STATE_AUD, algorithms: ['HS256'], requiredClaims: ['exp'] })
    target = safeRedirect(payload.redirect_to as string)
    nonce = payload.nonce
  } catch {
    // returned (not thrown) so the cookie-clearing header goes out with the 400
    return c.json({ code: 400, error_code: 'bad_oauth_state', msg: 'OAuth state parameter is missing or invalid' }, 400)
  }
  const fail = (error: string, error_code: string, error_description: string) =>
    c.redirect(withFragment(target, { error, error_code, error_description }), 302)
  if (!cookieNonce || cookieNonce !== nonce) return fail('access_denied', 'bad_oauth_callback', 'OAuth callback was not started in this browser')

  const code = c.req.query('code')
  if (c.req.query('error') || !code) return fail('access_denied', 'provider_error', 'Google sign-in was cancelled or failed')
  const p = await googleProfile(code)
  if (!p) return fail('server_error', 'unexpected_failure', 'Unable to exchange external code')
  if (typeof p.sub !== 'string' || typeof p.email !== 'string' || p.email_verified !== true)
    return fail('access_denied', 'provider_email_needs_verification', 'Google account email is not verified')
  const user = await googleUser(p.sub, p.email.toLowerCase(), p)
  if (isBanned(user)) return fail('access_denied', 'user_banned', 'User is banned')
  return c.redirect(withFragment(target, sessionParams(await issueSession(user))), 302)
})

export default router
