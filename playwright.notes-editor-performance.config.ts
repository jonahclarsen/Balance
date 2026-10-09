import { defineConfig, devices } from '@playwright/test'

// Notes performance profile with synthetic data.
const port = process.env.PLAYWRIGHT_PORT ?? '5128'
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests/performance',
  testMatch: 'notes-editors.spec.ts',
  outputDir: './artifacts/playwright-notes-editor-performance',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 300_000,
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 820 } },
    },
  ],
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
})
