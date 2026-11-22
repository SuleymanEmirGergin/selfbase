import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { pool } from '../db.ts'
import { config } from '../config.ts'

/** auth.users row plus its identities (json_agg rows of auth.identities). */
export type UserRow = Record<string, any> & { id: string; email: string | null; identities?: Record<string, any>[] }
export type UserJson = ReturnType<typeof toUserJson>

/** GoTrue-shaped error: {code, error_code, msg}. Throw it from any auth handler. */
export const authError = (status: ContentfulStatusCode, error_code: string, msg: string) =>
  new HTTPException(status, { res: Response.json({ code: status, error_code, msg }, { status }) })

export function toUserJson(row: UserRow) {
  return {
    id: row.id,
    aud: row.aud ?? 'authenticated',
    role: row.role ?? 'authenticated',
    email: row.email ?? '',
    phone: row.phone ?? '',
    email_confirmed_at: row.email_confirmed_at ?? null,
    phone_confirmed_at: row.phone_confirmed_at ?? null,
    confirmed_at: row.confirmed_at ?? null,
    last_sign_in_at: row.last_sign_in_at ?? null,
    app_metadata: row.raw_app_meta_data ?? {},
    user_metadata: row.raw_user_meta_data ?? {},
    identities: (row.identities ?? []).map((i) => ({
      identity_id: i.id,
      id: i.provider_id,
      user_id: i.user_id,
      identity_data: i.identity_data,
      provider: i.provider,
      last_sign_in_at: i.last_sign_in_at,
      created_at: i.created_at,
      updated_at: i.updated_at,
      email: i.email,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const SELECT_USER = `select u.*, coalesce((select json_agg(i) from auth.identities i where i.user_id = u.id), '[]') as identities
  from auth.users u`

export async function findById(id: string): Promise<UserRow | null> {
  return (await pool.query(`${SELECT_USER} where u.id = $1`, [id])).rows[0] ?? null
}

export async function findByEmail(email: string): Promise<UserRow | null> {
  return (await pool.query(`${SELECT_USER} where lower(u.email) = lower($1) and not u.is_sso_user`, [email])).rows[0] ?? null
}

export async function listUsers(limit: number, offset: number): Promise<{ rows: UserRow[]; total: number }> {
  const [page, count] = await Promise.all([
    pool.query(`${SELECT_USER} order by u.created_at desc, u.id limit $1 offset $2`, [limit, offset]),
    pool.query(`select count(*)::int as n from auth.users`),
  ])
  return { rows: page.rows, total: count.rows[0].n }
}

export const hashPassword = (password: string) => bcrypt.hash(password, 10)

/** Throws 422 weak_password when password is shorter than AUTH_MIN_PASSWORD. */
export function checkPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < config.authMinPassword)
    throw authError(422, 'weak_password', `Password should be at least ${config.authMinPassword} characters.`)
}

/** Inserts a user (email confirmed unless provider is email and AUTH_CONFIRM_EMAIL is on) and, for email, its identity. */
export async function createUser(p: {
  email: string
  password?: string
  user_metadata?: object
  provider: string
}): Promise<UserRow> {
  const id = randomUUID()
  const email = p.email.toLowerCase()
  const confirmed = p.provider !== 'email' || !config.authConfirmEmail
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(
      `insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
       values ($1, 'authenticated', 'authenticated', $2, $3, case when $4 then now() end, $5, $6)`,
      [id, email, p.password ? await hashPassword(p.password) : null, confirmed,
        { provider: p.provider, providers: [p.provider] }, p.user_metadata ?? {}],
    )
    // other providers insert their own identity (their provider_id is the provider's user id)
    if (p.provider === 'email')
      await client.query(
        `insert into auth.identities (provider_id, user_id, identity_data, provider) values ($1::text, $1::uuid, $2, 'email')`,
        [id, { sub: id, email, email_verified: confirmed, phone_verified: false }],
      )
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
  return (await findById(id))!
}
