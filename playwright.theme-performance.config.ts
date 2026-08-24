import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/performance',
  testMatch: 'theme-state.spec.ts',
  outputDir: './artifacts/playwright-theme-performance',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 120_000,
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1280, height: 820 },
    },
  }],
  use: {
    baseURL: 'http://127.0.0.1:5128',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5128',
    url: 'http://127.0.0.1:5128',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
