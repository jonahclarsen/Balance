import { defineConfig, devices } from '@playwright/test'

// Notes behavior and image regressions on desktop, mobile, and WebKit.
const port = process.env.PLAYWRIGHT_PORT ?? '5127'
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests/notes-editors',
  outputDir: './artifacts/playwright-notes-editors',
  fullyParallel: false,
  // Agent sessions share one dev machine; CI keeps Playwright's default parallelism.
  workers: process.env.CI ? undefined : 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port}`,
    env: { VITE_BALANCE_START_VIEW: 'today', VITE_BALANCE_SKIP_SEED_GOALS: '1' },
    url: baseURL,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'lexical',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 820 } },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'lexical-images-webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 820 } },
      testMatch: /images\.spec\.ts/,
    },
    {
      name: 'lexical-mobile',
      use: { ...devices['Pixel 7'] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
})
