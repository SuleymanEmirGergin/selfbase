// Runs once before any test file: brings the compose.test.yml database to the current platform schema, the way
// core does at start. Throwaway values matching compose.test.yml (and setup.ts). Never real secrets.
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import { applyMigrations, setRolePassword } from '../src/platform/migrate.ts'

export const PLATFORM_DIR = fileURLToPath(new URL('../../db/platform', import.meta.url))
export const TEST_PASSWORD = 'test-postgres-password'
export const testPool = (port: string, database = 'postgres') =>
  new pg.Pool({ host: 'localhost', port: Number(port), user: 'postgres', password: TEST_PASSWORD, database })

export default async function () {
  const pool = testPool(process.env.TEST_DB_PORT ?? '54329')
  try {
    await applyMigrations(pool, { dir: PLATFORM_DIR, ledger: 'selfbase.platform_migrations', lockKey: 7213014, adoptV1: true })
    await setRolePassword(pool, 'authenticator', TEST_PASSWORD)
  } finally {
    await pool.end()
  }
  // PostgREST could not log in before authenticator existed; it retries with backoff. Tests that never reach it
  // still run if it is not up after 60 s.
  const rest = `http://localhost:${process.env.TEST_REST_PORT ?? '54330'}/`
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) {
    const status = await fetch(rest).then((r) => r.status, () => 0)
    if (status !== 0 && status !== 503) return
  }
  console.warn(`global-setup: PostgREST at ${rest} is not ready`)
}
