import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/performance',
  outputDir: './artifacts/playwright-undo-performance',
  fullyParallel: false,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:55338',
    viewport: { width: 1280, height: 820 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 55338',
    url: 'http://127.0.0.1:55338',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
