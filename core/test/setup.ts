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
  PLATFORM_DIR: '../db/platform',
  JWT_SECRET: TEST_JWT_SECRET,
  ANON_KEY: await apiKey('anon'),
  SERVICE_ROLE_KEY: await apiKey('service_role'),
  PUBLIC_URL: 'http://localhost:8080',
  SITE_URL: 'http://localhost:5173',
  AUTH_REDIRECT_ALLOWLIST: 'http://localhost:5173/*',
  AUTH_CONFIRM_EMAIL: 'true',
  AUTH_PHONE_ENABLED: 'false',
  AUTH_MIN_PASSWORD: '6',
  // every test request comes from one "IP"; the rate limit test turns the limits on itself
  AUTH_RATE_LIMIT_SIGN_IN: '0',
  AUTH_RATE_LIMIT_VERIFY: '0',
  AUTH_RATE_LIMIT_REFRESH: '0',
  AUTH_RATE_LIMIT_EMAIL: '0',
  SMTP_HOST: '',
  ADMIN_TOKEN: 'test-admin-token-at-least-32-characters',
  PROJECT_REF: 'testprojectrefaaaaaa',
  STORAGE_DIR: process.env.TEST_STORAGE_DIR ?? './.test-storage',
  FUNCTIONS_DIR: './.test-functions',
  PGRST_URL: `http://localhost:${restPort}`,
  FN_URL: 'http://localhost:54331',
  // the netqueue test's stand-in servers; every other private address stays refused
  NETQUEUE_ALLOW_HOSTS: '127.0.0.1',
})

afterAll(async () => {
  const { closeDb } = await import('../src/db.ts')
  await closeDb()
})
