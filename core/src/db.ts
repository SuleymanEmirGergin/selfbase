import pg from 'pg'
import type { PoolClient } from 'pg'
import { config } from './config.ts'
import type { JwtClaims } from './jwt.ts'

/** Superuser pool. End-user requests must go through asUser(), never this directly. */
export const pool = new pg.Pool({ ...config.db, max: 10 })

const ROLES = new Set(['anon', 'authenticated', 'service_role'])

/** Runs fn in a transaction as the JWT's role with request.jwt.claims set, like PostgREST does. */
export async function asUser<T>(claims: JwtClaims | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const role = claims?.role ?? 'anon'
  if (!ROLES.has(role)) throw new Error(`invalid role: ${role}`)
  const client = await pool.connect()
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
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
