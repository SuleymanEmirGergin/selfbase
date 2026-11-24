import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { pool } from '../db.ts'
import { config } from '../config.ts'
import type { AppEnv } from '../jwt.ts'
import { authError, createUser, findByEmail, findById, withTx } from './users.ts'
import { issueSession, isBanned, lockUser } from './sessions.ts'
import { background, CURRENT_EMAIL_TOKEN, sendConfirmation, sendMagicLink, sendRecovery, sha256, TOKEN_TYPES } from './mail.ts'
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
// `seen`: the password hash read while the token existed. Under the S4 lock it must still be the user's (a reset
// since then changed it and ended every session), and the hash this leaves is what issueSession checks next.
const applyVerification = (type: MailKind, userId: string, email: string, seen: string | null) =>
  withTx(async (tx): Promise<false | { hash: string | null }> => {
    await lockUser(tx, userId)
    const r = type === 'email_change'
      ? await tx.query(`update auth.users set email = email_change, email_change = '', email_change_confirm_status = 0,
          email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now()
          where id = $1 and email_change = $2 and encrypted_password is not distinct from $3 returning encrypted_password`, [userId, email, seen])
      : await tx.query(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()),
          -- a magic or recovery link proves the address, not a password set before anyone proved it (pre-account takeover)
          encrypted_password = case when email_confirmed_at is null and $3 then null else encrypted_password end,
          updated_at = now() where id = $1 and email = $2 and encrypted_password is not distinct from $4
          returning encrypted_password`, [userId, email, type !== 'signup', seen])
    if (!r.rowCount) return false
    await tx.query(`update auth.identities set identity_data = identity_data || jsonb_build_object('email', $2::text, 'email_verified', true),
      updated_at = now() where user_id = $1 and provider = 'email'`, [userId, email])
    return { hash: r.rows[0].encrypted_password }
  }).catch((err): false => {
    if (err.code === '23505') return false // the new address was taken meanwhile
    throw err
  })

/**
 * Secure email change: true while the other address's link for this change is still unused. The first link used
 * only records the step (email_change_confirm_status 1); the change applies with the second, in either order.
 */
async function otherLinkPending(userId: string, newEmail: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `select 1 from auth.one_time_tokens where user_id = $1 and token_type = any($2) and relates_to = $3`,
    [userId, [TOKEN_TYPES.email_change, CURRENT_EMAIL_TOKEN], newEmail],
  )
  if (!rowCount) return false
  await pool.query(`update auth.users set email_change_confirm_status = 1, updated_at = now() where id = $1 and email_change = $2`, [userId, newEmail])
  return true
}

// GoTrue's amr method of each link session
const AMR: Record<MailKind, string> = { signup: 'email/signup', recovery: 'recovery', magiclink: 'magiclink', email_change: 'email_change' }

router.get('/verify', async (c) => {
  const { token, type, redirect_to } = c.req.query()
  const target = safeRedirect(redirect_to)
  const fail = (error_code: string, error_description: string) =>
    c.redirect(withFragment(target, { error: 'access_denied', error_code, error_description }), 302)
  const expired = () => fail('otp_expired', 'Email link is invalid or has expired')
  if (!token || !type || !Object.hasOwn(TOKEN_TYPES, type)) return expired()
  const kind = type as MailKind
  // an email change link was mailed to the new or (secure email change) the current address
  const types = kind === 'email_change' ? [TOKEN_TYPES[kind], CURRENT_EMAIL_TOKEN] : [TOKEN_TYPES[kind]]
  // the hash as it was while the token still existed: a password reset changes it and deletes the tokens in one
  // transaction, so applyVerification and issueSession refuse the link if a reset ran after this read (see S4)
  const seen = (await pool.query(`select u.encrypted_password from auth.one_time_tokens t join auth.users u on u.id = t.user_id
    where t.token_hash = $1 and t.token_type = any($2)`, [sha256(token), types])).rows[0]
  if (!seen) return expired()
  // single use: the token row is gone whatever happens next
  const row = (await pool.query(
    `delete from auth.one_time_tokens where token_hash = $1 and token_type = any($2)
     returning user_id, relates_to, created_at > now() - make_interval(secs => $3) as fresh`,
    [sha256(token), types, config.authOtpExpiry],
  )).rows[0]
  if (!row?.fresh) return expired()
  if (kind === 'email_change' && (await otherLinkPending(row.user_id, row.relates_to)))
    return c.redirect(withFragment(target, { message: 'Confirmation link accepted. Please proceed to confirm link sent to the other email' }), 302)
  const applied = await applyVerification(kind, row.user_id, row.relates_to, seen.encrypted_password ?? null)
  if (!applied) return expired()
  const user = (await findById(row.user_id))!
  if (isBanned(user)) return fail('user_banned', 'User is banned')
  // a contested signup lost its password (repeat signup): type=recovery makes the client let the owner set one
  const passwordless = kind === 'signup' && !user.encrypted_password && (user.identities ?? []).every((i) => i.provider === 'email')
  // AUTH_SET_PASSWORD_URL goes through the allowlist like any redirect (outside it: SITE_URL)
  const landing = passwordless && config.authSetPasswordUrl ? safeRedirect(config.authSetPasswordUrl) : target
  const shown = passwordless ? 'recovery' : kind
  // refused (a reset or ban since the token was read): the link is spent, like an expired one
  const session = await issueSession(user, AMR[shown], applied.hash).catch((err) => {
    if (err instanceof HTTPException && err.status === 400) return null
    throw err
  })
  if (!session) return expired()
  return c.redirect(withFragment(landing, { ...sessionParams(session), type: shown }), 302)
})

export default router
