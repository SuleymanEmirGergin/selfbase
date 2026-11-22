// Throwaway values matching compose.test.yml (see global-setup.ts). Never real secrets.
import { afterAll } from 'vitest'
import { TEST_ENV } from './global-setup.ts'

// a fresh master key per worker is fine: every test file encrypts and decrypts within itself
Object.assign(process.env, TEST_ENV)

afterAll(async () => {
  const { closeDb } = await import('../src/db.ts')
  await closeDb()
})
