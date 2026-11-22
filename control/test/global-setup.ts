// Runs once before any test file: brings the compose.test.yml control-db to the current schema, the way control
// does at start. Throwaway values matching compose.test.yml. Never real secrets.
import { randomBytes } from 'node:crypto'

export const TEST_ENV: Record<string, string> = {
  SELFBASE_MASTER_KEY: randomBytes(32).toString('base64'),
  CONTROL_DB_HOST: 'localhost',
  CONTROL_DB_PORT: process.env.TEST_CONTROL_DB_PORT ?? '54340',
  CONTROL_DB_PASSWORD: 'test-control-db-password',
  CONTROL_JWT_SECRET: 'test-control-jwt-secret-at-least-32-characters',
  PROVISIONER_TOKEN: 'test-provisioner-token',
  BASE_DOMAIN: 'example.test',
  TEMPLATE_VERSION: 'test',
}

export default async function () {
  Object.assign(process.env, TEST_ENV)
  const { migrate, closeDb } = await import('../src/db.ts')
  try {
    await migrate()
  } finally {
    await closeDb()
  }
}
