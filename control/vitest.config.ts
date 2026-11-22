import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    // integration tests share one database; run files one at a time
    fileParallelism: false,
    testTimeout: 15000,
  },
})
