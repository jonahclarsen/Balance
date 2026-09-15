import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ci', testMatch: 'undo-comparison.spec.ts',
  outputDir: './artifacts/undo-comparison-tests', timeout: 600_000,
  workers: 1, maxFailures: 1, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:55338' },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 55338 --strictPort',
    url: 'http://127.0.0.1:55338', reuseExistingServer: false,
  },
})
