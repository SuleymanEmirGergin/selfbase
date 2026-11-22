import { Hono } from 'hono'
import { pool } from '../db.ts'
import { config } from '../config.ts'
import type { AppEnv } from '../jwt.ts'
import { authError, createUser, findByEmail, findById, withTx } from './users.ts'
import { issueSession, isBanned } from './sessions.ts'
import { background, sendConfirmation, sendMagicLink, sendRecovery, sha256, TOKEN_TYPES } from './mail.ts'
import type { MailKind } from './templates.ts'
import { safeRedirect, sessionParams, withFragment } from './redirect.ts'
import { checkEmail, readBody } from './routes-core.ts'

const router = new Hono<AppEnv>()

// Anti-enumeration: the same 200 whether or not the email is registered; mails go out in the background.
router.post('/recover', async (c) => {
  const user = await findByEmail(checkEmail((await readBody(c)).email))
  if (user && !isBanned(user)) background(sendRecovery(user, c.req.query('redirect_to')))
  return c.json({})
})

router.post('/otp', async (c) => {
  const body = await readBody(c)
  const email = checkEmail(body.email)
  let user = await findByEmail(email)
  // supabase-js defaults create_user to true; the new user is confirmed by the magic link
  if (!user && body.create_user !== false) {
    const data = body.data && typeof body.data === 'object' ? body.data : {}
    user = await createUser({ email, user_metadata: data, provider: 'email' }).catch((err) => {
      if (err.code === '23505') return findByEmail(email)
      throw err
    })
  }
  if (user && !isBanned(user)) background(sendMagicLink(user, c.req.query('redirect_to')))
  return c.json({})
})

router.post('/resend', async (c) => {
  const body = await readBody(c)
  if (body.type !== 'signup') throw authError(400, 'validation_failed', 'type must be signup')
  const user = await findByEmail(checkEmail(body.email))
  if (user && !user.email_confirmed_at && !(await sendConfirmation(user, c.req.query('redirect_to'))))
    throw authError(429, 'over_email_send_rate_limit', `For security purposes, you can only request this after ${config.authEmailInterval} seconds.`)
  return c.json({})
})

/** Marks the email verified (or applies a pending email change) if the token still matches the user's state. */
const applyVerification = (type: MailKind, userId: string, email: string) =>
  withTx(async (tx) => {
    const r = type === 'email_change'
      ? await tx.query(`update auth.users set email = email_change, email_change = '', email_confirmed_at = coalesce(email_confirmed_at, now()),
          updated_at = now() where id = $1 and email_change = $2`, [userId, email])
      : await tx.query(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now()
          where id = $1 and email = $2`, [userId, email])
    if (!r.rowCount) return false
    await tx.query(`update auth.identities set identity_data = identity_data || jsonb_build_object('email', $2::text, 'email_verified', true),
      updated_at = now() where user_id = $1 and provider = 'email'`, [userId, email])
    return true
  }).catch((err) => {
    if (err.code === '23505') return false // the new address was taken meanwhile
    throw err
  })

router.get('/verify', async (c) => {
  const { token, type, redirect_to } = c.req.query()
  const target = safeRedirect(redirect_to)
  const fail = (error_code: string, error_description: string) =>
    c.redirect(withFragment(target, { error: 'access_denied', error_code, error_description }), 302)
  const expired = () => fail('otp_expired', 'Email link is invalid or has expired')
  if (!token || !type || !Object.hasOwn(TOKEN_TYPES, type)) return expired()
  const kind = type as MailKind
  // single use: the token row is gone whatever happens next
  const row = (await pool.query(
    `delete from auth.one_time_tokens where token_hash = $1 and token_type = $2
     returning user_id, relates_to, created_at > now() - make_interval(secs => $3) as fresh`,
    [sha256(token), TOKEN_TYPES[kind], config.authOtpExpiry],
  )).rows[0]
  if (!row?.fresh || !(await applyVerification(kind, row.user_id, row.relates_to))) return expired()
  const user = (await findById(row.user_id))!
  if (isBanned(user)) return fail('user_banned', 'User is banned')
  return c.redirect(withFragment(target, { ...sessionParams(await issueSession(user)), type: kind }), 302)
})

export default router
