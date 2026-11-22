// Throwaway values matching compose.test.yml. Never real secrets.
import { afterAll } from 'vitest'
import { SignJWT } from 'jose'

export const TEST_JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long'
const dbPort = process.env.TEST_DB_PORT ?? '54329'
const restPort = process.env.TEST_REST_PORT ?? '54330'

const key = new TextEncoder().encode(TEST_JWT_SECRET)
const apiKey = (role: string) =>
  new SignJWT({ role, iss: 'selfbase' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(key)

Object.assign(process.env, {
  DB_HOST: 'localhost',
  DB_PORT: dbPort,
  POSTGRES_PASSWORD: 'test-postgres-password',
  JWT_SECRET: TEST_JWT_SECRET,
  ANON_KEY: await apiKey('anon'),
  SERVICE_ROLE_KEY: await apiKey('service_role'),
  PUBLIC_URL: 'http://localhost:8080',
  SITE_URL: 'http://localhost:5173',
  AUTH_REDIRECT_ALLOWLIST: 'http://localhost:5173/*',
  AUTH_CONFIRM_EMAIL: 'true',
  AUTH_PHONE_ENABLED: 'false',
  AUTH_MIN_PASSWORD: '8',
  SMTP_HOST: '',
  PANEL_ADMIN_EMAIL: 'admin@example.test',
  PANEL_ADMIN_PASSWORD_HASH: '',
  STORAGE_DIR: process.env.TEST_STORAGE_DIR ?? './.test-storage',
  FUNCTIONS_DIR: './.test-functions',
  PGRST_URL: `http://localhost:${restPort}`,
  FN_URL: 'http://localhost:54331',
})

afterAll(async () => {
  const { pool } = await import('../src/db.ts')
  await pool.end()
})
