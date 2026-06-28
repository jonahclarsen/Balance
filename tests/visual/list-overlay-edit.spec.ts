import { expect, test } from '@playwright/test'

// Seed a list template "Groceries" (one item) plus a plan whose task links to it,
// then open the list overlay toast so its generated items are on screen.
async function openGroceriesOverlay(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list template' }).click()
  await expect(page.getByRole('heading', { name: 'List template' })).toBeVisible()
  await page.getByLabel('List name').fill('Groceries')

  const listItems = page.locator('[data-list-template-text-input]')
  await expect(listItems.first()).toBeVisible()
  await listItems.first().fill('Milk')

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const firstItem = page.locator('[data-plan-text-input]').first()
  await firstItem.fill('Groceries')
  await firstItem.blur()

  await page.getByTitle('Open Groceries').first().click()
  const dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Milk')).toBeVisible()
  return dialog
}

test('list overlay item shows an edit pencil that jumps to the template and closes the toast', async ({ page }) => {
  const dialog = await openGroceriesOverlay(page)

  // Each generated item exposes an edit-in-template button.
  const editButton = dialog.getByRole('button', { name: 'Edit this item in the list template' })
  await expect(editButton).toBeVisible()
  await editButton.click()

  // The toast closes and we land on the list-templates editor with the source item focused.
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: 'List template' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-list-template-text-input-id') ?? null)).not.toBeNull()
  await expect(page.locator('[data-list-template-text-input]').first()).toContainText('Milk')
})

test('navigating to another page closes the list overlay', async ({ page }) => {
  const dialog = await openGroceriesOverlay(page)

  // Clicking any other page (Lists) dismisses the toast so it never floats over unrelated content.
  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await expect(dialog).toBeHidden()
})

test('reopening a list overlay restores the selected item near the one-third scroll line', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list template' }).click()
  await page.getByLabel('List name').fill('Groceries')

  const listItems = page.locator('[data-list-template-text-input]')
  await listItems.first().fill('Item 01')
  for (let index = 2; index <= 52; index += 1) {
    await page.getByRole('button', { name: '+ Add list item' }).click()
    await listItems.nth(index - 1).fill(`Item ${String(index).padStart(2, '0')}`)
  }

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const firstItem = page.locator('[data-plan-text-input]').first()
  await firstItem.fill('Groceries')
  await firstItem.blur()

  await page.getByTitle('Open Groceries').first().click()
  let dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(dialog).toBeVisible()

  const targetText = 'Item 24'
  await dialog.locator('.plan-row', { hasText: targetText }).click()
  await expect(dialog.locator('.plan-row.selected')).toContainText(targetText)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()

  await page.evaluate(() => {
    const win = window as Window & {
      __listOverlayScrollBehaviors?: string[]
      __originalElementScrollTo?: typeof Element.prototype.scrollTo
    }
    win.__listOverlayScrollBehaviors = []
    if (win.__originalElementScrollTo) return

    win.__originalElementScrollTo = Element.prototype.scrollTo
    const originalScrollTo = win.__originalElementScrollTo
    Element.prototype.scrollTo = function (arg0?: ScrollToOptions | number, arg1?: number) {
      if (arg0 && typeof arg0 === 'object' && 'behavior' in arg0) {
        win.__listOverlayScrollBehaviors?.push(String(arg0.behavior))
        return originalScrollTo.call(this, arg0)
      }
      return originalScrollTo.call(this, arg0 ?? 0, arg1 ?? 0)
    }
  })

  await page.getByTitle('Open Groceries').first().click()
  dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.plan-row.selected')).toContainText(targetText)
  await expect
    .poll(async () =>
      page.evaluate(() => (window as Window & { __listOverlayScrollBehaviors?: string[] }).__listOverlayScrollBehaviors ?? []),
    )
    .toContain('auto')
  expect(await page.evaluate(() => (window as Window & { __listOverlayScrollBehaviors?: string[] }).__listOverlayScrollBehaviors ?? [])).not.toContain(
    'smooth',
  )

  await expect
    .poll(async () => {
      return dialog.locator('.plan-row.selected').evaluate((row) => {
        const top = row.getBoundingClientRect().top
        return Math.abs(top - window.innerHeight / 3)
      })
    })
    .toBeLessThan(72)
})
