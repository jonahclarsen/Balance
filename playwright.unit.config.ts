import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/unit',
  outputDir: './artifacts/playwright-unit',
  fullyParallel: true,
  reporter: [['list']],
})
