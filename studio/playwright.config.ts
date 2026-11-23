import { defineConfig, devices } from '@playwright/test'

// The specs intercept every /platform call with page.route fixtures, so a plain Vite dev server is enough.
// STUDIO_E2E_PREVIEW=1 runs them against the production build instead (chunking, lazy catalogues).
const port = Number(process.env.STUDIO_E2E_PORT || 5181)
const preview = !!process.env.STUDIO_E2E_PREVIEW

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: preview ? `npx vite build && npx vite preview --port ${port} --strictPort` : `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI && !preview,
  },
})
