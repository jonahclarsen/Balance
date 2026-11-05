import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 5126)

export default defineConfig({
  testDir: './tests/performance',
  testMatch: 'day-navigation.spec.ts',
  outputDir: './artifacts/playwright-day-navigation-performance',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 240_000,
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 820 } },
    },
    {
      // Closest Playwright engine to the WKWebView used by the macOS app.
      name: 'webkit-desktop',
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 820 } },
    },
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Trace snapshots run inside the page and would distort the profile.
    trace: 'off',
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_BALANCE_START_VIEW: 'today' },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
