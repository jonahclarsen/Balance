import { defineConfig, devices } from '@playwright/test'

// BALANCE_WARP_APP_DIR serves another checkout so CI can profile a baseline
// build with this branch's spec.
const port = Number(process.env.PLAYWRIGHT_PORT ?? 5131)
const retina = { viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 }

export default defineConfig({
  testDir: './tests/performance',
  testMatch: /(?:idea-sort-warp|warp-noise-field)\.spec\.ts/,
  outputDir: './artifacts/playwright-idea-sort-warp',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 120_000,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...retina } },
    { name: 'chromium-6x-cpu', use: { ...devices['Desktop Chrome'], ...retina } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], ...retina } },
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'off',
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: process.env.BALANCE_WARP_APP_DIR,
    env: { VITE_BALANCE_START_VIEW: 'today' },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
