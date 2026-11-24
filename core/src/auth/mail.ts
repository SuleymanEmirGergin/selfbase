import { createHash, randomBytes } from 'node:crypto'
import nodemailer from 'nodemailer'
import { pool } from '../db.ts'
import { config } from '../config.ts'
import { render } from './templates.ts'
import type { MailKind } from './templates.ts'
import { safeRedirect } from './redirect.ts'
import type { UserRow } from './users.ts'
import { logLine } from '../log.ts'
import { resolveChecked } from '../netguard.ts'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** GET /verify type -> auth.one_time_tokens.token_type */
export const TOKEN_TYPES: Record<MailKind, string> = {
  signup: 'confirmation_token',
  recovery: 'recovery_token',
  magiclink: 'magiclink_token',
  email_change: 'email_change_token_new',
}
// auth.users column that records the last send of each kind (GoTrue's columns; magic links use recovery_sent_at like GoTrue)
const SENT_AT: Record<MailKind, string> = {
  signup: 'confirmation_sent_at',
  recovery: 'recovery_sent_at',
  magiclink: 'recovery_sent_at',
  email_change: 'email_change_sent_at',
}

/**
 * Stores the hash of a one-time token, replacing the user's previous token of that type. Failed attempts carry
 * over while the previous token was still live, so reissuing a code never buys fresh guesses.
 */
export async function storeToken(userId: string, tokenType: string, tokenHash: string, relatesTo: string): Promise<void> {
  await pool.query(
    `insert into auth.one_time_tokens (user_id, token_type, token_hash, relates_to) values ($1, $2, $3, $4)
     on conflict (user_id, token_type) do update
       set token_hash = excluded.token_hash, relates_to = excluded.relates_to,
         attempts = case when one_time_tokens.created_at > now() - make_interval(secs => $5) then one_time_tokens.attempts else 0 end,
         created_at = now(), updated_at = now()`,
    [userId, tokenType, tokenHash, relatesTo, config.authOtpExpiry],
  )
}

// no addresses or SMTP details: only the error code
const logFailure = (err: any) => logLine('error', `auth mail failed: ${err?.code ?? err?.responseCode ?? 'error'}`)

/** Runs a send without blocking the response, so response time does not depend on whether a mail goes out. */
export const background = (p: Promise<unknown>) => void p.catch(logFailure)

let warned = false
/** nodemailer options: implicit TLS on 465; elsewhere STARTTLS is required, so a stripped upgrade never sends SMTP_PASS in clear. */
export const smtpOptions = ({ host, port, user, pass }: typeof config.smtp) =>
  ({ host, port, secure: port === 465, requireTLS: port !== 465, auth: user ? { user, pass } : undefined })
async function deliver(to: string, subject: string, html: string): Promise<void> {
  if (!config.smtp.host) {
    if (!warned) logLine('warn', 'SMTP_HOST is empty: auth mails are written to selfbase.mail_log and not delivered')
    warned = true
    await pool.query(`insert into selfbase.mail_log (to_email, subject, html) values ($1, $2, $3)`, [to, subject, html])
    return
  }
  // through the outbound guard (SMTP_HOST is a setting, core is on the shared proxy network), then to the checked
  // address itself, the name kept for TLS: a second DNS answer cannot differ
  const [{ address }] = await resolveChecked(config.smtp.host, config.outboundAllowHosts)
  await nodemailer.createTransport({ ...smtpOptions(config.smtp), host: address, servername: config.smtp.host })
    .sendMail({ from: config.smtp.from, to, subject, html })
}

/**
 * Takes the user's mail slot (one auth mail per AUTH_EMAIL_INTERVAL), stores a fresh link token and sends
 * the mail in the background. False when the slot was taken (inside the interval): nothing is sent.
 */
async function sendLink(user: UserRow, kind: MailKind, redirectTo: string | undefined, to: string): Promise<boolean> {
  if (!(await takeSlot(user, kind))) return false
  await mailLink(user, kind, TOKEN_TYPES[kind], redirectTo, to, to)
  return true
}

const takeSlot = async (user: UserRow, kind: MailKind) => !!(await pool.query(
  `update auth.users set ${SENT_AT[kind]} = now() where id = $1
     and coalesce(greatest(confirmation_sent_at, recovery_sent_at, email_change_sent_at), '-infinity') <= now() - make_interval(secs => $2)`,
  [user.id, config.authEmailInterval],
)).rowCount

/** Stores a fresh link token of tokenType (relating to relatesTo) and mails the link to `to` in the background. */
async function mailLink(user: UserRow, kind: MailKind, tokenType: string, redirectTo: string | undefined, relatesTo: string, to: string) {
  const token = randomBytes(32).toString('base64url')
  await storeToken(user.id, tokenType, sha256(token), relatesTo)
  const q = new URLSearchParams({ token, type: kind, redirect_to: safeRedirect(redirectTo) })
  // Email is the address the link is about: for an email change, the new address in both mails
  const { subject, html } = render(kind, { ConfirmationURL: `${config.publicUrl}/auth/v1/verify?${q}`, Email: relatesTo, SiteURL: config.siteUrl })
  background(deliver(to, subject, html))
}

export const sendConfirmation = (user: UserRow, redirectTo?: string) => sendLink(user, 'signup', redirectTo, user.email!)
export const sendRecovery = (user: UserRow, redirectTo?: string) => sendLink(user, 'recovery', redirectTo, user.email!)
export const sendMagicLink = (user: UserRow, redirectTo?: string) => sendLink(user, 'magiclink', redirectTo, user.email!)

/**
 * Email change link to the new address and, with AUTH_SECURE_EMAIL_CHANGE (GoTrue's secure email change), a second
 * one to the current address; GET /verify applies the change once every link sent has been used. Both tokens are
 * replaced on each request, so a new request invalidates the previous links. False inside the mail interval.
 */
export async function sendEmailChange(user: UserRow, newEmail: string): Promise<boolean> {
  if (!(await takeSlot(user, 'email_change'))) return false
  const secure = config.authSecureEmailChange && !!user.email
  if (!secure) await pool.query(`delete from auth.one_time_tokens where user_id = $1 and token_type = $2`, [user.id, CURRENT_EMAIL_TOKEN])
  await pool.query(`update auth.users set email_change_confirm_status = 0 where id = $1`, [user.id])
  await mailLink(user, 'email_change', TOKEN_TYPES.email_change, undefined, newEmail, newEmail)
  if (secure) await mailLink(user, 'email_change', CURRENT_EMAIL_TOKEN, undefined, newEmail, user.email!)
  return true
}
/** one_time_tokens type of the email change link sent to the current address (GoTrue's column name) */
export const CURRENT_EMAIL_TOKEN = 'email_change_token_current'
