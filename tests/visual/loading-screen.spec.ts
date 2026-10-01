import { expect, test } from '@playwright/test'

test('the Android loading card is horizontally centered', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'The startup layout regression is Android-only')

  await page.addInitScript(() => {
    localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({
      version: 1,
      themeId: 'graphite',
      randomThemeStartDate: '',
      doneTintColor: '',
      checkboxColor: '',
    }))
    type TestRuntime = typeof globalThis & {
      isTauri: boolean
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: string }; currentWebview: { label: string } }
        invoke: (command: string) => Promise<unknown>
        transformCallback: () => number
      }
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => void
      }
    }
    const runtime = globalThis as TestRuntime

    Object.defineProperty(navigator, 'platform', { value: 'Linux armv8l', configurable: true })
    Object.defineProperty(navigator, 'userAgent', { value: 'Balance Android visual test', configurable: true })
    runtime.isTauri = true
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
    runtime.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command: string) => {
        if (command === 'read_app_state') return new Promise(() => undefined)
        if (command === 'get_recovery_key_status') {
          return {
            confirmed: true,
            recoveryKey: null,
            databasePath: '/tmp/balance-visual-test.sqlite3',
          }
        }
        return null
      },
    }
  })

  await page.goto('/')

  const loadingScreen = page.getByRole('status')
  await expect(loadingScreen).toBeVisible()
  await expect(loadingScreen.getByText('Loading…')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite')
  await expect(loadingScreen.getByRole('progressbar', { name: 'Database loading progress' })).toBeVisible()

  const geometry = await loadingScreen.evaluate((backdrop) => {
    const card = backdrop.querySelector<HTMLElement>('.database-loading-card')
    if (!card) throw new Error('Missing database loading card')
    const backdropRect = backdrop.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    return {
      backdropCenter: backdropRect.left + backdropRect.width / 2,
      cardCenter: cardRect.left + cardRect.width / 2,
      cardLeft: cardRect.left,
      cardRight: cardRect.right,
      viewportWidth: window.innerWidth,
    }
  })

  expect(Math.abs(geometry.cardCenter - geometry.backdropCenter)).toBeLessThanOrEqual(1)
  expect(geometry.cardLeft).toBeGreaterThanOrEqual(0)
  expect(geometry.cardRight).toBeLessThanOrEqual(geometry.viewportWidth)

  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-android-loading-screen-centered.png',
    fullPage: false,
  })
})
