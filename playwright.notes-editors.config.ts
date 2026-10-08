import { defineConfig, devices } from '@playwright/test'

// Conformance suite for the rebuilt Notes editors. Runs the same tests against
// each editor implementation (see tests/notes-editors/harness.ts).
const port = process.env.PLAYWRIGHT_PORT ?? '5127'
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests/notes-editors',
  outputDir: './artifacts/playwright-notes-editors',
  fullyParallel: false,
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
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'tiptap',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 820 }, noteEditor: 'tiptap' },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'lexical',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 820 }, noteEditor: 'lexical' },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'lexical-images-webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 820 }, noteEditor: 'lexical' },
      testMatch: /images\.spec\.ts/,
    },
    {
      name: 'tiptap-mobile',
      use: { ...devices['Pixel 7'], noteEditor: 'tiptap' },
      testMatch: /mobile\.spec\.ts/,
    },
    {
      name: 'lexical-mobile',
      use: { ...devices['Pixel 7'], noteEditor: 'lexical' },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
})
