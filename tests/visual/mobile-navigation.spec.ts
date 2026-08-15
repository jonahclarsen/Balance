import { expect, test } from '@playwright/test'

test('mobile header opens and swipes the desktop-style navigation drawer', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This prototype only changes compact navigation')

  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  const header = page.locator('.mobile-app-header')
  const menuButton = header.getByRole('button', { name: 'Open navigation' })
  const drawer = page.getByRole('complementary', { name: 'Primary navigation drawer' })
  await expect(header).toBeVisible()
  await expect(menuButton).toBeVisible()
  await expect(drawer).toBeHidden()

  const headerGeometry = await header.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, height: rect.height }
  })
  expect(headerGeometry.top).toBe(0)
  expect(headerGeometry.height).toBeGreaterThanOrEqual(70)

  await menuButton.click()
  await expect(drawer).toBeVisible()
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true')
  await drawer.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Notes', exact: true }).first()).toBeVisible()
  await expect(drawer).toBeHidden()

  await page.mouse.move(2, 320)
  await page.mouse.down()
  await page.mouse.move(210, 320, { steps: 8 })
  await page.mouse.up()
  await expect(drawer).toBeVisible()
  await page.waitForTimeout(300)

  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-swipe-drawer.png',
    fullPage: false,
  })

  await page.mouse.move(220, 340)
  await page.mouse.down()
  await page.mouse.move(16, 340, { steps: 8 })
  await page.mouse.up()
  await expect(drawer).toBeHidden()

  await menuButton.click()
  await drawer.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await expect.poll(() => header.evaluate((element) => element.getBoundingClientRect().top)).toBe(0)
})
