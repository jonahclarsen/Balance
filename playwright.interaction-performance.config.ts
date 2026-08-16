import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/performance',
  testMatch: 'interactions.spec.ts',
  outputDir: './artifacts/playwright-interaction-performance',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 120_000,
  projects: [
    {
      name: 'mac-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 820 },
      },
    },
    {
      name: 'android-like-6x-cpu',
      use: {
        ...devices['Pixel 5'],
      },
    },
  ],
  use: {
    baseURL: 'http://127.0.0.1:5124',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5124',
    url: 'http://127.0.0.1:5124',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
