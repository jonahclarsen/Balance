import { expect, test } from '@playwright/test'

test('mobile header and bottom navigation stay reachable without the desktop sidebar', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This prototype only changes compact navigation')

  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  const header = page.locator('.mobile-app-header')
  const bottomNav = page.getByRole('navigation', { name: 'Mobile primary navigation' })
  await expect(header).toBeVisible()
  await expect(bottomNav).toBeVisible()
  await expect(page.getByRole('complementary')).toBeHidden()

  const initialGeometry = await page.evaluate(() => {
    const headerElement = document.querySelector<HTMLElement>('.mobile-app-header')
    const navElement = document.querySelector<HTMLElement>('.mobile-bottom-nav')
    if (!headerElement || !navElement) throw new Error('Missing mobile navigation')
    const headerRect = headerElement.getBoundingClientRect()
    const navRect = navElement.getBoundingClientRect()
    return {
      headerTop: headerRect.top,
      headerHeight: headerRect.height,
      navBottom: navRect.bottom,
      viewportHeight: window.innerHeight,
    }
  })
  expect(initialGeometry.headerTop).toBe(0)
  expect(initialGeometry.headerHeight).toBeGreaterThanOrEqual(70)
  expect(Math.abs(initialGeometry.navBottom - initialGeometry.viewportHeight)).toBeLessThan(1)

  await bottomNav.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Notes', exact: true }).first()).toBeVisible()

  const moreButton = bottomNav.getByRole('button', { name: 'More', exact: true })
  const moreButtonBox = await moreButton.boundingBox()
  if (!moreButtonBox) throw new Error('More button has no tappable bounds')
  await page.mouse.click(moreButtonBox.x + moreButtonBox.width / 2, moreButtonBox.y + moreButtonBox.height / 2)
  const more = page.getByRole('dialog', { name: 'More navigation' })
  await expect(more).toBeVisible()
  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-bottom-more-sheet.png',
    fullPage: false,
  })
  await more.getByRole('button', { name: 'Day Templates', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Daily template' })).toBeVisible()

  const currentMoreButtonBox = await moreButton.boundingBox()
  if (!currentMoreButtonBox) throw new Error('More button lost its tappable bounds')
  await page.mouse.click(
    currentMoreButtonBox.x + currentMoreButtonBox.width / 2,
    currentMoreButtonBox.y + currentMoreButtonBox.height / 2,
  )
  await page.getByRole('dialog', { name: 'More navigation' }).getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await expect.poll(() => header.evaluate((element) => element.getBoundingClientRect().top)).toBe(0)

  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-bottom-navigation.png',
    fullPage: false,
  })
})
