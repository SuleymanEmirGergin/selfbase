import { Hono } from 'hono'
import { createHmac, randomInt, randomUUID } from 'node:crypto'
import { pool } from '../db.ts'
import { config } from '../config.ts'
import type { AppEnv } from '../jwt.ts'
import { authError, findById, toUserJson } from './users.ts'
import type { UserRow } from './users.ts'
import { issueSession, isBanned, sessionActive } from './sessions.ts'
import { sha256, storeToken } from './mail.ts'
import { logLine } from '../log.ts'

const router = new Hono<AppEnv>()
const MAX_ATTEMPTS = 5
const SMS_INTERVAL = 60

export const phoneDisabled = () => authError(422, 'phone_provider_disabled', 'Phone provider is disabled')

/** Sends a 6-digit OTP for the user's pending phone change through FN_URL/send-phone-otp-hook (Standard Webhooks signed). */
export async function sendPhoneOtp(user: UserRow, phone: string): Promise<void> {
  const failed = () => authError(500, 'unexpected_failure', 'Error sending phone OTP')
  if (!config.authSmsHookSecret) {
    logLine('error', 'AUTH_SMS_HOOK_SECRET is not set: phone OTP not sent')
    throw failed()
  }
  const tooSoon = () => authError(429, 'over_sms_send_rate_limit', `For security purposes, you can only request this after ${SMS_INTERVAL} seconds.`)
  // one SMS per number per interval, whichever account asks (tokens are stored only after a successful send)
  // shortcut: check-then-send, so two accounts racing within milliseconds can both send once; lock the number if that matters
  const recent = await pool.query(
    `select 1 from auth.one_time_tokens where token_type = 'phone_change_token' and relates_to = $1
       and created_at > now() - make_interval(secs => $2) limit 1`, [phone, SMS_INTERVAL])
  if (recent.rowCount) throw tooSoon()
  // per-user minimum gap between SMS sends (same 60 s as for mails)
  const slot = await pool.query(
    `update auth.users set phone_change_sent_at = now()
     where id = $1 and coalesce(phone_change_sent_at, '-infinity') <= now() - make_interval(secs => $2)`,
    [user.id, SMS_INTERVAL],
  )
  if (!slot.rowCount) throw tooSoon()
  const otp = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const body = JSON.stringify({ user: toUserJson(user), sms: { otp } })
  const id = `msg_${randomUUID()}`
  const ts = String(Math.floor(Date.now() / 1000))
  const key = Buffer.from(config.authSmsHookSecret.replace(/^v1,whsec_/, ''), 'base64')
  const signature = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
  const res = await fetch(`${config.fnUrl}/send-phone-otp-hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${signature}` },
    body,
    // a function-chosen redirect target is never fetched: a 3xx is a failed send
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  await res?.body?.cancel()
  if (!res?.ok) {
    // nothing went out: give the slot back so the user can retry at once
    await pool.query(`update auth.users set phone_change_sent_at = null where id = $1`, [user.id])
    throw failed()
  }
  await storeToken(user.id, 'phone_change_token', sha256(phone + otp), phone)
}

router.post('/verify', async (c) => {
  const body = await c.req.json().catch(() => null)
  // email links are verified by GET /verify
  if (body?.type !== 'phone_change') throw authError(400, 'validation_failed', 'Only type phone_change is supported')
  if (!config.authPhoneEnabled) throw phoneDisabled()
  const { phone, token } = body
  if (typeof phone !== 'string' || typeof token !== 'string') throw authError(400, 'validation_failed', 'phone and token are required')
  // only the signed-in owner can spend the code's attempts: the token is looked up by the user, never by the number
  const claims = c.get('claims')
  if (!claims?.sub) throw authError(401, 'no_authorization', 'This endpoint requires a signed-in user')
  if (!(await sessionActive(claims.session_id))) throw authError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist')
  const user = await findById(claims.sub)
  if (!user) throw authError(403, 'user_not_found', 'User from sub claim in JWT does not exist')
  if (isBanned(user)) throw authError(400, 'user_banned', 'User is banned')
  const invalid = () => authError(403, 'otp_expired', 'Token has expired or is invalid')
  if (!user.phone_change || user.phone_change !== phone) throw invalid()
  // every guess counts (row lock serialises them), so a 6-digit code survives at most MAX_ATTEMPTS tries
  const hit = (await pool.query(
    `update auth.one_time_tokens set attempts = attempts + 1, updated_at = now()
     where user_id = $1 and token_type = 'phone_change_token'
     returning id, relates_to = $2 and token_hash = $3 and attempts <= $4 and created_at > now() - make_interval(secs => $5) as ok`,
    [user.id, phone, sha256(phone + token), MAX_ATTEMPTS, config.authOtpExpiry],
  )).rows[0]
  // the delete decides between two concurrent correct guesses
  if (!hit?.ok || !(await pool.query(`delete from auth.one_time_tokens where id = $1`, [hit.id])).rowCount) throw invalid()
  const applied = await pool.query(
    `update auth.users set phone = phone_change, phone_change = '', phone_confirmed_at = now(), updated_at = now()
     where id = $1 and phone_change = $2`,
    [user.id, phone],
  ).catch((err) => {
    if (err.code === '23505') throw authError(422, 'phone_exists', 'Phone number already registered')
    throw err
  })
  if (!applied.rowCount) throw invalid()
  return c.json(await issueSession((await findById(user.id))!))
})

export default router
