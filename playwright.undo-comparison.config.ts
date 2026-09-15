import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ci', testMatch: 'undo-comparison.spec.ts',
  outputDir: './artifacts/undo-comparison-tests', timeout: 600_000,
  workers: 1, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5123' },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5123 --strictPort',
    url: 'http://127.0.0.1:5123', reuseExistingServer: false,
  },
})
