import { randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '../db.ts'
import { config } from '../config.ts'
import { sign } from '../jwt.ts'
import { authError, findById, toUserJson } from './users.ts'
import type { UserJson, UserRow } from './users.ts'

const ACCESS_TTL = 3600

export type SessionJson = {
  access_token: string
  token_type: 'bearer'
  expires_in: number
  expires_at: number
  refresh_token: string
  user: UserJson
}

const newToken = () => randomBytes(32).toString('base64url')

async function sessionJson(user: UserRow, sessionId: string, refreshToken: string): Promise<SessionJson> {
  const claims = {
    sub: user.id,
    role: 'authenticated' as const,
    aud: 'authenticated',
    email: user.email ?? '',
    phone: user.phone ?? '',
    app_metadata: user.raw_app_meta_data ?? {},
    user_metadata: user.raw_user_meta_data ?? {},
    session_id: sessionId,
  }
  return {
    access_token: await sign(claims, ACCESS_TTL),
    token_type: 'bearer',
    expires_in: ACCESS_TTL,
    expires_at: Math.floor(Date.now() / 1000) + ACCESS_TTL,
    refresh_token: refreshToken,
    user: toUserJson(user),
  }
}

export const isBanned = (user: UserRow) => user.banned_until && new Date(user.banned_until) > new Date()

/** Starts a new session for a signed-in user: first refresh token, last_sign_in_at bumped. */
export async function issueSession(user: UserRow): Promise<SessionJson> {
  const sessionId = randomUUID()
  const token = newToken()
  await pool.query(`insert into auth.refresh_tokens (token, user_id, session_id) values ($1, $2, $3)`, [token, user.id, sessionId])
  await pool.query(`update auth.users set last_sign_in_at = now() where id = $1`, [user.id])
  return sessionJson((await findById(user.id))!, sessionId, token)
}

/**
 * Exchanges a refresh token for a new pair in the same session. A token that was already rotated is
 * reuse (likely theft): the whole session is revoked and the call fails. Exception (GoTrue's reuse interval): within
 * AUTH_REFRESH_REUSE_INTERVAL seconds of its rotation, while its direct child is still the live token, the retry
 * (lost response, two tabs) gets that same child back with a fresh access token.
 */
export async function rotate(refreshToken: string): Promise<SessionJson> {
  const client = await pool.connect()
  let result: { user_id: string; session_id: string; token: string } | 'reused'
  try {
    await client.query('begin')
    const old = (await client.query(
      `select *, updated_at > now() - make_interval(secs => $2) as recent from auth.refresh_tokens where token = $1 for update`,
      [refreshToken, config.authRefreshReuseInterval],
    )).rows[0]
    if (!old) throw authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found')
    // a live child has never been rotated itself (rotation revokes it), so this only ever reaches one generation back
    const child = old.revoked && config.authRefreshReuseInterval > 0 && old.recent
      ? (await client.query(`select token from auth.refresh_tokens where parent = $1 and not revoked`, [old.token])).rows[0]
      : undefined
    if (child) {
      result = { user_id: old.user_id, session_id: old.session_id, token: child.token }
    } else if (old.revoked) {
      await revokeIn(client, old.session_id)
      result = 'reused'
    } else {
      const token = newToken()
      await client.query(`update auth.refresh_tokens set revoked = true, updated_at = now() where id = $1`, [old.id])
      await client.query(`insert into auth.refresh_tokens (token, user_id, session_id, parent) values ($1, $2, $3, $4)`,
        [token, old.user_id, old.session_id, old.token])
      result = { user_id: old.user_id, session_id: old.session_id, token }
    }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  if (result === 'reused') throw authError(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used')
  const user = await findById(result.user_id)
  if (!user) throw authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found')
  if (isBanned(user)) {
    await revokeSession(result.session_id)
    throw authError(400, 'user_banned', 'User is banned')
  }
  return sessionJson(user, result.session_id, result.token)
}

const revokeIn = (c: PoolClient | typeof pool, sessionId: string) =>
  c.query(`update auth.refresh_tokens set revoked = true, updated_at = now() where session_id = $1 and not revoked`, [sessionId])

/** Revokes every refresh token of the session (there is no sessions table). */
export async function revokeSession(sessionId: string): Promise<void> {
  await revokeIn(pool, sessionId)
}

/** A session is live while it has an unrevoked refresh token. */
export async function sessionActive(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false
  return ((await pool.query(`select 1 from auth.refresh_tokens where session_id = $1 and not revoked limit 1`, [sessionId])).rowCount ?? 0) > 0
}
