// Renders the website and docs screenshots headlessly from a synthetic
// workspace in the Iridescent theme. See website/README.md.
import { expect, test, type Page } from '@playwright/test'
import { openView } from '../../tests/helpers/navigation'
import { createScreenshotState } from './seed'

// A Wednesday afternoon, after Balance's 5 a.m. day boundary.
const NOW = new Date('2026-10-14T14:20:00')
const TODAY = '2026-10-14'
const OUT = 'artifacts/site-shots'

async function open(page: Page) {
  await page.clock.install({ time: NOW })
  await page.goto('/')
  const state = createScreenshotState(TODAY)
  await page.evaluate((raw) => {
    localStorage.clear()
    localStorage.setItem('balance.appState.v1', raw)
    localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({
      version: 1,
      colorScheme: 'light',
      systemColorSchemeStartDate: '',
      themeId: 'iridescent',
      randomThemeStartDate: '',
      doneTintColor: '',
      checkboxColor: '',
    }))
  }, JSON.stringify(state))
  await page.reload()
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })
    .or(page.getByRole('button', { name: 'Open navigation', exact: true }))).toBeVisible()
  await settle(page)
}

async function settle(page: Page) {
  await page.mouse.move(0, 0)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.waitForTimeout(1200)
}

// Today jumps to the next unchecked task on load; pictures start at the top.
async function scrollToTop(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>('*')) {
      if (element.scrollTop > 0) element.scrollTop = 0
    }
    window.scrollTo(0, 0)
  })
}

async function shot(page: Page, name: string, top = true) {
  await settle(page)
  if (top) {
    await scrollToTop(page)
    await page.waitForTimeout(300)
  }
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile)

  test('screens', async ({ page }) => {
    await open(page)
    await shot(page, 'mac-today')
    for (const [view, name] of [
      ['Next', 'mac-next'],
      ['Days', 'mac-days'],
      ['Lists', 'mac-lists'],
      ['Notes', 'mac-notes'],
      ['Quizzes', 'mac-quizzes'],
      ['Goals', 'mac-goals'],
      ['Projects', 'mac-projects'],
      ['Buckets', 'mac-buckets'],
    ]) {
      await openView(page, view)
      await shot(page, name)
    }
    await openView(page, 'Prioritize')
    await page.getByRole('button', { name: 'Past sessions', exact: true }).click()
    await page.locator('.prioritize-past button').first().click()
    await shot(page, 'mac-prioritize')
    await openView(page, 'Settings')
    await page.getByRole('heading', { name: 'Sync across your devices' }).evaluate((heading) => heading.scrollIntoView({ block: 'start' }))
    await shot(page, 'mac-sync', false)
  })
})

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile)

  test('screens', async ({ page }) => {
    await open(page)
    await shot(page, 'android-today')
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
    await shot(page, 'android-menu')
    for (const [view, name] of [
      ['Notes', 'android-notes'],
      ['Goals', 'android-goals'],
      ['Lists', 'android-lists'],
    ]) {
      await openView(page, view)
      await shot(page, name)
    }
  })
})
