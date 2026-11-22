import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // the cases of a mode share state and run in order; pause and restore alone take about half a minute
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
})
