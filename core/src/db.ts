import pg from 'pg'
import type { PoolClient } from 'pg'
import { config } from './config.ts'
import { ROLES } from './jwt.ts'
import type { JwtClaims } from './jwt.ts'
import { logLine } from './log.ts'

/** Superuser pool for core's own bookkeeping. End-user requests must go through asUser(), never this. */
export const pool = new pg.Pool({ ...config.db, max: 10, connectionTimeoutMillis: 10_000 })

// Same login PostgREST uses: NOINHERIT and can only switch to the API roles, never superuser.
const userPool = new pg.Pool({ ...config.db, user: 'authenticator', password: config.authenticatorPassword, max: 10, connectionTimeoutMillis: 10_000 })

// An idle client whose backend dies (database restart) emits 'error' on the pool; unhandled, it would end the process.
// The pool drops that client and the next query opens a fresh one.
pool.on('error', (e) => logLine('error', `db pool: ${e.message}`))
userPool.on('error', (e) => logLine('error', `db user pool: ${e.message}`))

/** Runs fn in a transaction as the JWT's role with request.jwt.claims set, like PostgREST does. */
export async function asUser<T>(claims: JwtClaims | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const role = claims?.role ?? 'anon'
  if (!ROLES.includes(role)) throw new Error(`invalid role: ${role}`)
  const client = await userPool.connect()
  let broken: Error | undefined
  try {
    await client.query('begin')
    await client.query(`select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)`, [
      role,
      JSON.stringify(claims ?? { role: 'anon' }),
    ])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback').catch((e: Error) => (broken = e))
    throw err
  } finally {
    client.release(broken)
  }
}

/** Closes both pools (tests, shutdown). Safe to call twice. */
export async function closeDb(): Promise<void> {
  await Promise.all([pool, userPool].filter((p) => !p.ended).map((p) => p.end()))
}
