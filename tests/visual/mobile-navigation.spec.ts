import { expect, test } from '@playwright/test'

test('mobile header opens a smooth, close-only swipe drawer', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This navigation only appears in compact layouts')

  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  const header = page.locator('.mobile-app-header')
  const menuButton = header.getByRole('button', { name: 'Open navigation' })
  const drawer = page.getByRole('complementary', { name: 'Primary navigation drawer' })
  const closeButton = drawer.getByRole('button', { name: 'Close navigation' })
  await expect(header).toBeVisible()
  await expect(menuButton).toBeVisible()
  await expect(drawer).toBeHidden()

  const headerGeometry = await header.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, height: rect.height }
  })
  expect(headerGeometry.top).toBe(0)
  expect(headerGeometry.height).toBeGreaterThanOrEqual(70)

  const menuButtonBox = await menuButton.boundingBox()
  if (!menuButtonBox) throw new Error('Menu button has no tappable bounds')
  await menuButton.click()
  await expect(drawer).toBeVisible()
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(250)

  const closeButtonBox = await closeButton.boundingBox()
  if (!closeButtonBox) throw new Error('Close button has no tappable bounds')
  expect(Math.abs(closeButtonBox.x - menuButtonBox.x)).toBeLessThan(1)
  expect(Math.abs(closeButtonBox.y - menuButtonBox.y)).toBeLessThan(1)
  expect(closeButtonBox.width).toBe(menuButtonBox.width)
  expect(closeButtonBox.height).toBe(menuButtonBox.height)

  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-swipe-drawer.png',
    fullPage: false,
  })

  await closeButton.click()
  await expect(drawer).toBeHidden()

  // The left edge belongs to Android's Back gesture; opening is button-only.
  await page.mouse.move(2, 320)
  await page.mouse.down()
  await page.mouse.move(210, 320, { steps: 8 })
  await page.mouse.up()
  await expect(drawer).toBeHidden()

  await menuButton.click()
  await drawer.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Notes', exact: true }).first()).toBeVisible()
  await expect(drawer).toBeHidden()

  await menuButton.click()
  await page.evaluate(() => {
    const shell = document.querySelector('.app-shell')
    if (!shell) throw new Error('Missing app shell')
    let styleMutations = 0
    const observer = new MutationObserver((mutations) => {
      styleMutations += mutations.filter((mutation) => mutation.attributeName === 'style').length
    })
    observer.observe(shell, { attributes: true, attributeFilter: ['style'] })
    const testWindow = window as typeof window & { stopDrawerMutationWatch?: () => number }
    testWindow.stopDrawerMutationWatch = () => {
      observer.disconnect()
      return styleMutations
    }
  })

  // A short drag snaps open and updates only the two composited drawer layers,
  // never the app-shell style that owns the rest of the Svelte application.
  await page.mouse.move(240, 340)
  await page.mouse.down()
  await page.mouse.move(190, 340, { steps: 16 })
  await page.mouse.up()
  const appShellStyleMutations = await page.evaluate(() => {
    const testWindow = window as typeof window & { stopDrawerMutationWatch?: () => number }
    return testWindow.stopDrawerMutationWatch?.() ?? -1
  })
  expect(appShellStyleMutations).toBe(0)
  await expect(drawer).toBeVisible()

  await page.mouse.move(220, 340)
  await page.mouse.down()
  await page.mouse.move(16, 340, { steps: 12 })
  await page.mouse.up()
  await expect(drawer).toBeHidden()

  await menuButton.click()
  await drawer.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await expect.poll(() => header.evaluate((element) => element.getBoundingClientRect().top)).toBe(0)
})
