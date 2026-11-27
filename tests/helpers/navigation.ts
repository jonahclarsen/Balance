import { expect, type Page } from '@playwright/test'

// Page content can also contain buttons named Goals or Settings.
export function primaryNavigation(page: Page) {
  return page.getByRole('navigation', { name: 'Primary', exact: true })
}

export async function showPrimaryNavigation(page: Page) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  // A closing drawer can still have visible button rectangles during its
  // transition. Its expanded state tells us whether it needs opening.
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') {
    await menu.click()
  }
}

export async function hidePrimaryNavigation(page: Page) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  if (!await menu.isVisible()) return
  const drawer = page.getByRole('complementary', { name: 'Primary navigation drawer' })
  // The app may already be closing it, as day generation does.
  if (await menu.getAttribute('aria-expanded') === 'true') {
    await drawer.getByRole('button', { name: 'Close navigation', exact: true }).click()
  }
  await expect(drawer).toBeHidden()
}

export async function openView(page: Page, name: string) {
  await showPrimaryNavigation(page)
  const button = primaryNavigation(page).getByRole('button', { name, exact: true })
  await button.click()
  if (await page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible()) {
    await expect(page.getByRole('complementary', { name: 'Primary navigation drawer' })).toBeHidden()
  }
}

// The Notes list stays hidden until the menu button is hovered.
export async function openNoteList(page: Page) {
  await page.locator('.notes-drawer-toggle').hover()
  const sidebar = page.locator('.notes-sidebar')
  await expect(sidebar).toBeVisible()
  // Let it finish sliding in so its bounds are final.
  await sidebar.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
}

// Moving the pointer off the list hides it again.
export async function closeNoteList(page: Page) {
  const workspace = await page.locator('.notes-workspace').first().boundingBox()
  if (!workspace) throw new Error('Notes workspace is not visible')
  await page.mouse.move(workspace.x + workspace.width - 4, workspace.y + workspace.height / 2)
  await expect(page.locator('.notes-sidebar')).toBeHidden()
}

export async function generateDay(page: Page, name = 'Generate day') {
  const drawer = page.getByRole('complementary', { name: 'Primary navigation drawer' })
  const button = drawer.getByRole('button', { name, exact: true })
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  const openedDrawer = await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true'
  await showPrimaryNavigation(page)
  // Generation controls live on Today; returning from a template preserves the selected date.
  if (await button.count() === 0) {
    await openView(page, 'Today')
    await showPrimaryNavigation(page)
  }
  await button.click()
  if (openedDrawer) await hidePrimaryNavigation(page)
  // Keyboard presses skip locator handlers, so pass the check before returning.
  if (skippingCalendarCheck.has(page)) {
    const check = calendarCheck(page)
    if (await check.waitFor({ timeout: 1500 }).then(() => true, () => false)) {
      await check.getByRole('button', { name: 'Done (Enter)' }).click()
      await expect(check).toBeHidden()
    }
  }
}

// Day generation opens with the calendar check; tests not about it skip it.
const skippingCalendarCheck = new WeakSet<Page>()
const calendarCheck = (page: Page) => page.getByRole('dialog', { name: 'Emptied your whole calendar?' })

export async function skipCalendarCheck(page: Page) {
  skippingCalendarCheck.add(page)
  const check = calendarCheck(page)
  await page.addLocatorHandler(check, async () => {
    await check.getByRole('button', { name: 'Done (Enter)' }).click()
  })
}
