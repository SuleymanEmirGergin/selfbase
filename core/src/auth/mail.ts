import { createHash, randomBytes } from 'node:crypto'
import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { pool } from '../db.ts'
import { config } from '../config.ts'
import { render } from './templates.ts'
import type { MailKind } from './templates.ts'
import { safeRedirect } from './redirect.ts'
import type { UserRow } from './users.ts'

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
const logFailure = (err: any) => console.error(`auth mail failed: ${err?.code ?? err?.responseCode ?? 'error'}`)

/** Runs a send without blocking the response, so response time does not depend on whether a mail goes out. */
export const background = (p: Promise<unknown>) => void p.catch(logFailure)

let transport: Transporter | undefined
let warned = false
async function deliver(to: string, subject: string, html: string): Promise<void> {
  if (!config.smtp.host) {
    if (!warned) console.warn('SMTP_HOST is empty: auth mails are written to selfbase.mail_log and not delivered')
    warned = true
    await pool.query(`insert into selfbase.mail_log (to_email, subject, html) values ($1, $2, $3)`, [to, subject, html])
    return
  }
  const { host, port, user, pass, from } = config.smtp
  transport ??= nodemailer.createTransport({ host, port, secure: port === 465, auth: user ? { user, pass } : undefined })
  await transport.sendMail({ from, to, subject, html })
}

/**
 * Takes the user's mail slot (one auth mail per AUTH_EMAIL_INTERVAL), stores a fresh link token and sends
 * the mail in the background. False when the slot was taken (inside the interval): nothing is sent.
 */
async function sendLink(user: UserRow, kind: MailKind, redirectTo: string | undefined, to: string): Promise<boolean> {
  const slot = await pool.query(
    `update auth.users set ${SENT_AT[kind]} = now() where id = $1
       and coalesce(greatest(confirmation_sent_at, recovery_sent_at, email_change_sent_at), '-infinity') <= now() - make_interval(secs => $2)`,
    [user.id, config.authEmailInterval],
  )
  if (!slot.rowCount) return false
  const token = randomBytes(32).toString('base64url')
  await storeToken(user.id, TOKEN_TYPES[kind], sha256(token), to)
  const q = new URLSearchParams({ token, type: kind, redirect_to: safeRedirect(redirectTo) })
  const { subject, html } = render(kind, { ConfirmationURL: `${config.publicUrl}/auth/v1/verify?${q}`, Email: to, SiteURL: config.siteUrl })
  background(deliver(to, subject, html))
  return true
}

export const sendConfirmation = (user: UserRow, redirectTo?: string) => sendLink(user, 'signup', redirectTo, user.email!)
export const sendRecovery = (user: UserRow, redirectTo?: string) => sendLink(user, 'recovery', redirectTo, user.email!)
export const sendMagicLink = (user: UserRow, redirectTo?: string) => sendLink(user, 'magiclink', redirectTo, user.email!)
// shortcut: single confirmation to the new address only (no "secure email change" mail to the old one); add it if the old address must approve
export const sendEmailChange = (user: UserRow, newEmail: string) => sendLink(user, 'email_change', undefined, newEmail)
