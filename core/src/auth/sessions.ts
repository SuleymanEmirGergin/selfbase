import { randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '../db.ts'
import { config } from '../config.ts'
import { sign } from '../jwt.ts'
import { authError, findById, toUserJson, withTx } from './users.ts'
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
  // a token's user never changes: read it unlocked, then take the user's lock before the token row's
  const owner = (await pool.query(`select user_id from auth.refresh_tokens where token = $1`, [refreshToken])).rows[0]
  if (!owner) throw authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found')
  const client = await pool.connect()
  let result: { user_id: string; session_id: string; token: string } | 'reused'
  try {
    await client.query('begin')
    await lockUser(client, owner.user_id)
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

// S4: rotation and every revocation of a user's tokens hold this per-user transaction lock. Without it a revocation's
// UPDATE could run while a rotation had inserted its child token but not committed it: the UPDATE's snapshot misses
// the child, which then outlives the logout. Under the lock the revocation's UPDATE starts after the rotation
// committed, so it sees (and revokes) the child. Lock order is not uniform: the admin ban and password reset hold the
// auth.users row (FOR UPDATE) and then ask for this lock, while a rotation (and PUT /user's password change, which
// takes it first) holds this lock and then its child insert takes FOR KEY SHARE on that row. Postgres detects that cycle and aborts one side with a 500; either side rolls back whole, so no
// revocation is lost and no ban reports success with a live token.
const LOCK_NS = 0x5e55 // the two-key advisory lock space of refresh tokens
const lockUser = (c: PoolClient, userId: string) => c.query('select pg_advisory_xact_lock($1, hashtext($2::text))', [LOCK_NS, userId])

const revokeIn = (c: PoolClient, sessionId: string) =>
  c.query(`update auth.refresh_tokens set revoked = true, updated_at = now() where session_id = $1 and not revoked`, [sessionId])

/** Runs `fn` in `client`'s transaction when given (the caller's), else in one of its own. */
const inTx = (client: PoolClient | undefined, fn: (c: PoolClient) => Promise<void>) => (client ? fn(client) : withTx(fn))

/** Revokes every refresh token of the session (there is no sessions table). */
export async function revokeSession(sessionId: string): Promise<void> {
  const owner = (await pool.query(`select user_id from auth.refresh_tokens where session_id = $1 limit 1`, [sessionId])).rows[0]
  if (!owner) return
  await inTx(undefined, async (c) => {
    await lockUser(c, owner.user_id)
    await revokeIn(c, sessionId)
  })
}

/**
 * Revokes every refresh token of the user, except those of session `except` when given (logout scope=others, a
 * password reset). `client`: run inside the caller's transaction (an admin ban), which then holds the lock to its end.
 */
export async function revokeUserSessions(userId: string, except: string | null = null, client?: PoolClient): Promise<void> {
  await inTx(client, async (c) => {
    await lockUser(c, userId)
    await c.query(`update auth.refresh_tokens set revoked = true, updated_at = now()
      where user_id = $1 and not revoked and ($2::uuid is null or session_id <> $2)`, [userId, except])
  })
}

/**
 * GoTrue's UpdatePassword: a new password ends every session of the user except `keep` (the caller's own; null for an
 * admin reset) and clears its one-time tokens, so a stolen refresh token or link dies with the old password. Runs in
 * the caller's transaction, next to the password write.
 */
export async function endSessionsForNewPassword(client: PoolClient, userId: string, keep: string | null): Promise<void> {
  await revokeUserSessions(userId, keep, client)
  await client.query('delete from auth.one_time_tokens where user_id = $1', [userId])
}

/** A session is live while it has an unrevoked refresh token. */
export async function sessionActive(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false
  return ((await pool.query(`select 1 from auth.refresh_tokens where session_id = $1 and not revoked limit 1`, [sessionId])).rowCount ?? 0) > 0
}
