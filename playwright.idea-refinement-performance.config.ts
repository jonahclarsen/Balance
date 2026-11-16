import { defineConfig, devices } from '@playwright/test'

const port = 46095
export default defineConfig({
  testDir: './tests/performance',
  testMatch: 'idea-refinement.spec.ts',
  outputDir: './artifacts/idea-refinement-test',
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 820 },
    reducedMotion: 'no-preference',
    baseURL: `http://127.0.0.1:${port}`,
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_BALANCE_START_VIEW: 'today' },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
})
