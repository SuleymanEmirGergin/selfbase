import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // integration tests share one database; run files one at a time
    fileParallelism: false,
    testTimeout: 15000,
  },
})
