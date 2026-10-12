import { defineConfig, devices } from '@playwright/test'

const port = process.env.PLAYWRIGHT_PORT ?? '5197'
const appDir = 'artifacts/site-capture-app'

export default defineConfig({
  testDir: '.',
  testMatch: /capture\.spec\.ts/,
  outputDir: '../../artifacts/site-capture-results',
  workers: 1,
  timeout: 180_000,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `pnpm exec vite build --outDir ${appDir} && pnpm exec vite preview --outDir ${appDir} --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: '../..',
    env: { VITE_BALANCE_START_VIEW: 'today', VITE_BALANCE_SKIP_SEED_GOALS: '1' },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 600_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
})
