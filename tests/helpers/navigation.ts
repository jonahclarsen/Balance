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
  const close = drawer.getByRole('button', { name: 'Close navigation', exact: true })
  if (openedDrawer && await close.isVisible()) {
    await close.click()
    await expect(drawer).toBeHidden()
  }
}
