import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/unit',
  outputDir: './artifacts/playwright-unit',
  fullyParallel: true,
  // Agent sessions share one dev machine; CI keeps Playwright's default parallelism.
  workers: process.env.CI ? undefined : 1,
  reporter: [['list']],
})
