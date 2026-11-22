import { defineConfig, devices } from '@playwright/test'

// Runs against an already running stack (compose), e.g. PANEL_URL=http://localhost:54481.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.PANEL_URL || 'http://localhost:8080',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
})
