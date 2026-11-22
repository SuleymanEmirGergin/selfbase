import { Hono } from 'hono'
import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { pool } from '../db.ts'
import { config } from '../config.ts'
import type { AppEnv } from '../jwt.ts'
import { authError, checkPassword, createUser, findByEmail, findById, hashPassword, listUsers, toUserJson, withTx } from './users.ts'
import { issueSession, isBanned, revokeSession, rotate, sessionActive } from './sessions.ts'
import { background, sendConfirmation, sendEmailChange } from './mail.ts'
import { phoneDisabled, sendPhoneOtp } from './routes-phone.ts'

type Ctx = Context<AppEnv>
type Body = Record<string, any>

const router = new Hono<AppEnv>()
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// compared against when the email is unknown, so response time does not reveal registered emails
const DUMMY_HASH = bcrypt.hashSync(randomUUID(), 10)

export const readBody = async (c: Ctx): Promise<Body> => {
  const b = await c.req.json().catch(() => null)
  return b && typeof b === 'object' ? b : {}
}
export const checkEmail = (email: unknown): string => {
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) throw authError(400, 'validation_failed', 'Unable to validate email address: invalid format')
  return email.toLowerCase()
}

/** The signed-in user behind the bearer token, with a live session. */
async function requireUser(c: Ctx) {
  const claims = c.get('claims')
  if (!claims) throw authError(401, 'no_authorization', 'This endpoint requires a Bearer token')
  if (!claims.sub) throw authError(403, 'bad_jwt', 'invalid claim: missing sub claim')
  if (!(await sessionActive(claims.session_id))) throw authError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist')
  const user = await findById(claims.sub)
  if (!user) throw authError(403, 'user_not_found', 'User from sub claim in JWT does not exist')
  if (isBanned(user)) throw authError(400, 'user_banned', 'User is banned')
  return { user, claims }
}

function requireAdmin(c: Ctx) {
  const claims = c.get('claims')
  if (!claims) throw authError(401, 'no_authorization', 'This endpoint requires a Bearer token')
  if (claims.role !== 'service_role') throw authError(403, 'not_admin', 'User not allowed')
}

const fakeUser = (email: string, data: object) => {
  const now = new Date()
  return toUserJson({ id: randomUUID(), email, raw_app_meta_data: { provider: 'email', providers: ['email'] },
    raw_user_meta_data: data, created_at: now, updated_at: now })
}

router.post('/signup', async (c) => {
  const body = await readBody(c)
  const email = checkEmail(body.email)
  checkPassword(body.password)
  const data = body.data && typeof body.data === 'object' ? body.data : {}
  const existing = await findByEmail(email)
  // same bcrypt cost on both branches so timing does not reveal registered emails; mails go out in the background
  const repeatHash = existing ? await hashPassword(body.password) : null
  const redirectTo = c.req.query('redirect_to')
  const user = existing
    ? null
    : await createUser({ email, password: body.password, user_metadata: data, provider: 'email' }).catch((err) => {
        if (err.code === '23505') return null // lost a race with a concurrent signup for the same email
        throw err
      })
  if (!user) {
    // GoTrue: with confirmation on, an obfuscated user so signup does not reveal registered emails;
    // a still unconfirmed address takes this request's password and data (so an earlier signup by someone else
    // is not what the owner confirms) and gets its confirmation mail again (rate limited)
    if (config.authConfirmEmail) {
      if (existing && !existing.email_confirmed_at)
        background(pool.query(
          `update auth.users set encrypted_password = $2, raw_user_meta_data = $3, updated_at = now() where id = $1 and email_confirmed_at is null`,
          [existing.id, repeatHash, data],
        ).then(() => sendConfirmation(existing, redirectTo)))
      return c.json(fakeUser(email, data))
    }
    throw authError(422, 'user_already_exists', 'User already registered')
  }
  if (!config.authConfirmEmail) return c.json(await issueSession(user))
  background(sendConfirmation(user, redirectTo))
  return c.json(toUserJson(user))
})

/** /token handlers by grant_type; other auth route files add theirs (e.g. grants.pkce = ...). */
export const grants: Record<string, (c: Ctx, body: Body) => Promise<Response>> = {
  async password(c, body) {
    if (typeof body.email !== 'string' || typeof body.password !== 'string')
      throw authError(400, 'validation_failed', 'email and password are required')
    const user = await findByEmail(body.email)
    const ok = await bcrypt.compare(body.password, user?.encrypted_password || DUMMY_HASH)
    if (!user || !user.encrypted_password || !ok) throw authError(400, 'invalid_credentials', 'Invalid login credentials')
    if (isBanned(user)) throw authError(400, 'user_banned', 'User is banned')
    if (config.authConfirmEmail && !user.email_confirmed_at) throw authError(400, 'email_not_confirmed', 'Email not confirmed')
    return c.json(await issueSession(user))
  },
  async refresh_token(c, body) {
    if (typeof body.refresh_token !== 'string' || !body.refresh_token)
      throw authError(400, 'validation_failed', 'refresh_token is required')
    return c.json(await rotate(body.refresh_token))
  },
}

router.post('/token', async (c) => {
  const type = c.req.query('grant_type') ?? ''
  if (!Object.hasOwn(grants, type)) throw authError(400, 'unsupported_grant_type', 'unsupported grant_type')
  return grants[type](c, await readBody(c))
})

router.get('/user', async (c) => c.json(toUserJson((await requireUser(c)).user)))

router.put('/user', async (c) => {
  const { user } = await requireUser(c)
  const body = await readBody(c)
  // validate everything before writing anything
  const { data, password, phone } = body
  if (data !== undefined && (!data || typeof data !== 'object' || Array.isArray(data)))
    throw authError(400, 'validation_failed', 'data must be an object')
  if (password !== undefined) checkPassword(password)
  const email = body.email === undefined ? null : checkEmail(body.email)
  const newEmail = email && email !== user.email ? email : null
  const emailTaken = () => authError(422, 'email_exists', 'A user with this email address has already been registered')
  if (newEmail && (await findByEmail(newEmail))) throw emailTaken()
  if (phone !== undefined) {
    if (!config.authPhoneEnabled) throw phoneDisabled()
    if (typeof phone !== 'string') throw authError(400, 'validation_failed', 'phone must be a string')
  }
  const hash = password === undefined ? null : await hashPassword(password)
  // first, so a 429 (SMS interval) or a failed hook writes nothing; the code is checked against phone_change
  if (phone !== undefined) await sendPhoneOtp(user, phone)

  await withTx(async (tx) => {
    if (data !== undefined)
      // GoTrue merges top-level keys; a null value removes the key
      await tx.query(
        `update auth.users set raw_user_meta_data = (coalesce(raw_user_meta_data, '{}') || $2::jsonb)
           - array(select key from jsonb_each($2::jsonb) where value = 'null'::jsonb), updated_at = now() where id = $1`,
        [user.id, data],
      )
    if (hash) await tx.query(`update auth.users set encrypted_password = $2, updated_at = now() where id = $1`, [user.id, hash])
    if (newEmail && config.authConfirmEmail) {
      // applied by GET /verify type=email_change
      await tx.query(`update auth.users set email_change = $2, updated_at = now() where id = $1`, [user.id, newEmail])
    } else if (newEmail) {
      await tx.query(`update auth.users set email = $2, updated_at = now() where id = $1`, [user.id, newEmail])
      await tx.query(`update auth.identities set identity_data = identity_data || jsonb_build_object('email', $2::text), updated_at = now()
        where user_id = $1 and provider = 'email'`, [user.id, newEmail])
    }
    // applied by POST /verify type=phone_change
    if (phone !== undefined) await tx.query(`update auth.users set phone_change = $2, updated_at = now() where id = $1`, [user.id, phone])
  }).catch((err) => {
    if (err.code === '23505') throw emailTaken() // lost a race for the same email
    throw err
  })
  // the pending change stays recorded when this is 429; a later PUT sends the link
  if (newEmail && config.authConfirmEmail && !(await sendEmailChange(user, newEmail)))
    throw authError(429, 'over_email_send_rate_limit', `For security purposes, you can only request this after ${config.authEmailInterval} seconds.`)
  return c.json(toUserJson((await findById(user.id))!))
})

router.post('/logout', async (c) => {
  const { user, claims } = await requireUser(c)
  const scope = c.req.query('scope') ?? 'global'
  if (scope === 'local') await revokeSession(claims.session_id!)
  else if (scope === 'global' || scope === 'others')
    await pool.query(`update auth.refresh_tokens set revoked = true, updated_at = now() where user_id = $1 and not revoked and ($2::uuid is null or session_id <> $2)`,
      [user.id, scope === 'others' ? claims.session_id : null])
  else throw authError(400, 'validation_failed', 'scope must be global, local or others')
  return c.body(null, 204)
})

router.get('/admin/users', async (c) => {
  requireAdmin(c)
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const perPage = Math.min(1000, Math.max(1, Number(c.req.query('per_page')) || 50))
  const { rows, total } = await listUsers(perPage, (page - 1) * perPage)
  c.header('x-total-count', String(total))
  return c.json({ users: rows.map(toUserJson), aud: 'authenticated' })
})

router.delete('/admin/users/:id', async (c) => {
  requireAdmin(c)
  const id = c.req.param('id')
  if (!UUID_RE.test(id) || !(await pool.query(`delete from auth.users where id = $1`, [id])).rowCount)
    throw authError(404, 'user_not_found', 'User not found')
  return c.json({})
})

export default router
