import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/performance',
  testMatch: '*-core.spec.ts',
  outputDir: './artifacts/playwright-core-performance',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
})
