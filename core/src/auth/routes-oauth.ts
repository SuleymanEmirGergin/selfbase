import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { pool } from '../db.ts'
import { config } from '../config.ts'
import type { AppEnv } from '../jwt.ts'
import { authError, createUser, findByEmail, findById, withTx } from './users.ts'
import type { UserRow } from './users.ts'
import { issueSession, isBanned } from './sessions.ts'
import { safeRedirect, sessionParams, withFragment } from './redirect.ts'

const router = new Hono<AppEnv>()
const stateKey = new TextEncoder().encode(config.jwtSecret)
// own audience and no role claim: a state token is never accepted as an API key, and no API key passes as a state
const STATE_AUD = 'selfbase:oauth-state'
const callbackUrl = () => `${config.publicUrl}/auth/v1/callback`

router.get('/authorize', async (c) => {
  if (c.req.query('provider') !== 'google' || !config.google.clientId)
    throw authError(400, 'validation_failed', 'Unsupported provider: provider is not enabled')
  const state = await new SignJWT({ redirect_to: safeRedirect(c.req.query('redirect_to')), nonce: randomBytes(16).toString('base64url') })
    .setProtectedHeader({ alg: 'HS256' }).setAudience(STATE_AUD).setIssuedAt().setExpirationTime('10m').sign(stateKey)
  const q = new URLSearchParams({ client_id: config.google.clientId, redirect_uri: callbackUrl(), response_type: 'code', scope: 'openid email profile', state })
  return c.redirect(`${config.google.authUrl}?${q}`, 302)
})

type GoogleProfile = { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown; picture?: unknown }

/** Exchanges the code and reads the profile; null on any failure. Never logs or returns the client secret. */
async function googleProfile(code: string): Promise<GoogleProfile | null> {
  const { clientId, clientSecret, tokenUrl, userinfoUrl } = config.google
  try {
    const t = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: callbackUrl(), grant_type: 'authorization_code' }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!t.ok) {
      console.error(`google token exchange failed: ${t.status}`)
      return null
    }
    const { access_token } = await t.json()
    const u = await fetch(userinfoUrl, { headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) })
    if (!u.ok) {
      console.error(`google userinfo failed: ${u.status}`)
      return null
    }
    return await u.json()
  } catch (err: any) {
    console.error(`google oauth failed: ${err?.name ?? 'error'}`)
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

  const existing = await findByEmail(email)
  const user = existing ?? (await createUser({ email, user_metadata: data, provider: 'google' }))
  await withTx(async (tx) => {
    await tx.query(`insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at) values ($1, $2, $3, 'google', now())`,
      [sub, user.id, data])
    // linking: Google proved the address, so it is confirmed now; a password set before anyone proved owning
    // the address (pre-account takeover) is dropped
    if (existing)
      await tx.query(
        `update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()),
           encrypted_password = case when email_confirmed_at is null then null else encrypted_password end,
           raw_app_meta_data = jsonb_set(coalesce(raw_app_meta_data, '{}'), '{providers}', coalesce(raw_app_meta_data -> 'providers', '[]') || '["google"]'),
           updated_at = now() where id = $1`, [user.id])
  })
  return (await findById(user.id))!
}

router.get('/callback', async (c) => {
  let target: string
  try {
    const { payload } = await jwtVerify(c.req.query('state') ?? '', stateKey, { audience: STATE_AUD, algorithms: ['HS256'], requiredClaims: ['exp'] })
    target = safeRedirect(payload.redirect_to as string)
  } catch {
    throw authError(400, 'bad_oauth_state', 'OAuth state parameter is missing or invalid')
  }
  const fail = (error: string, error_code: string, error_description: string) =>
    c.redirect(withFragment(target, { error, error_code, error_description }), 302)

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
