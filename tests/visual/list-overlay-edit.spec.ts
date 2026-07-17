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

async function openLongGroceriesOverlay(page: import('@playwright/test').Page) {
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
  const dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function openTwoItemGroceriesOverlay(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list template' }).click()
  await page.getByLabel('List name').fill('Groceries')

  const listItems = page.locator('[data-list-template-text-input]')
  await listItems.first().fill('Milk')
  await page.getByRole('button', { name: '+ Add list item' }).click()
  await listItems.nth(1).fill('Eggs')

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const firstItem = page.locator('[data-plan-text-input]').first()
  await firstItem.fill('Groceries')
  await firstItem.blur()

  await page.getByTitle('Open Groceries').first().click()
  const dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Milk')).toBeVisible()
  await expect(dialog.getByText('Eggs')).toBeVisible()
  return dialog
}

async function openThreeItemGroceriesOverlay(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list template' }).click()
  await page.getByLabel('List name').fill('Groceries')

  const listItems = page.locator('[data-list-template-text-input]')
  for (const [index, item] of ['Milk', 'Eggs', 'Bread'].entries()) {
    if (index > 0) await page.getByRole('button', { name: '+ Add list item' }).click()
    await listItems.nth(index).fill(item)
  }

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const firstItem = page.locator('[data-plan-text-input]').first()
  await firstItem.fill('Groceries')
  await firstItem.blur()

  await page.getByTitle('Open Groceries').first().click()
  const dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(dialog).toBeVisible()
  return dialog
}

test('list overlay header progress fills as items are checked off', async ({ page }) => {
  const dialog = await openTwoItemGroceriesOverlay(page)
  const progress = dialog.getByRole('progressbar', { name: 'List completion' })
  const progressFill = progress.locator('.list-progress-fill')

  await expect(progress).toHaveAttribute('aria-valuemax', '2')
  await expect(progress).toHaveAttribute('aria-valuenow', '0')
  await expect(progress).toHaveCSS('--list-progress', '0%')
  await expect(progressFill).toHaveCSS('transition-property', 'clip-path')
  await expect(progressFill).toHaveCSS('transition-duration', '0.2s')
  await expect(progressFill).toHaveCSS('transition-timing-function', 'ease-out')

  await dialog.locator('.plan-row', { hasText: 'Milk' }).getByRole('checkbox').check()

  await expect(progress).toHaveAttribute('aria-valuenow', '1')
  await expect(progress).toHaveCSS('--list-progress', '50%')
})

test('list overlay selects its first item when initially opened', async ({ page }) => {
  const dialog = await openTwoItemGroceriesOverlay(page)

  await expect(dialog.locator('.plan-row.selected')).toContainText('Milk')
})

test('ArrowUp unchecks both the current and previous list items', async ({ page }) => {
  const dialog = await openThreeItemGroceriesOverlay(page)
  const milkRow = dialog.locator('.plan-row', { hasText: 'Milk' })
  const eggsRow = dialog.locator('.plan-row', { hasText: 'Eggs' })
  const milkCheckbox = milkRow.getByRole('checkbox')
  const eggsCheckbox = eggsRow.getByRole('checkbox')

  await page.keyboard.press('ArrowDown')
  await expect(milkCheckbox).toBeChecked()
  await expect(eggsRow).toHaveClass(/selected/)
  await eggsCheckbox.check()

  await page.keyboard.press('ArrowUp')

  await expect(milkCheckbox).not.toBeChecked()
  await expect(eggsCheckbox).not.toBeChecked()
  await expect(milkRow).toHaveClass(/selected/)
})

test('ArrowDown checks the final list item when it cannot navigate farther', async ({ page }) => {
  const dialog = await openTwoItemGroceriesOverlay(page)
  const milkRow = dialog.locator('.plan-row', { hasText: 'Milk' })
  const eggsRow = dialog.locator('.plan-row', { hasText: 'Eggs' })
  const eggsCheckbox = eggsRow.getByRole('checkbox')

  await page.keyboard.press('ArrowDown')
  await milkRow.getByRole('checkbox').uncheck()
  await page.keyboard.press('ArrowDown')

  await expect(eggsCheckbox).toBeChecked()
  await expect(eggsRow).toHaveClass(/selected/)
})

test('list overlay item shows an edit pencil that jumps to the template and reopens on return', async ({ page }) => {
  const dialog = await openGroceriesOverlay(page)

  // Each generated item exposes an edit-in-template button.
  const editButton = dialog.getByRole('button', { name: 'Edit this item in the list template' })
  await expect(editButton).toBeVisible()
  await editButton.click()

  // The toast hides while we land on the list-templates editor with the source item focused.
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: 'List template' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-list-template-text-input-id') ?? null)).not.toBeNull()
  await expect(page.locator('[data-list-template-text-input]').first()).toContainText('Milk')

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Groceries' })).toBeVisible()
})

test('navigating to another page hides the list overlay until returning', async ({ page }) => {
  const dialog = await openGroceriesOverlay(page)

  // Clicking any other page (Lists) hides the toast so it never floats over unrelated content.
  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Groceries' })).toBeVisible()
})

test('returning to Today restores the list overlay scroll position', async ({ page }) => {
  const dialog = await openLongGroceriesOverlay(page)
  const targetText = 'Item 24'
  await dialog.locator('.plan-row', { hasText: targetText }).click()
  await expect(dialog.locator('.plan-row.selected')).toContainText(targetText)
  await page.waitForTimeout(350)
  await dialog.locator('.overlay-body').evaluate((element) => {
    element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + 180)
  })
  await page.waitForTimeout(50)
  const scrollTopBefore = await dialog.locator('.overlay-body').evaluate((element) => element.scrollTop)

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  const reopenedDialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(reopenedDialog).toBeVisible()
  await expect
    .poll(() => reopenedDialog.locator('.overlay-body').evaluate((element) => element.scrollTop))
    .toBeGreaterThanOrEqual(scrollTopBefore - 2)
  expect(await reopenedDialog.locator('.overlay-body').evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(scrollTopBefore + 2)
})

test('reopening a list overlay restores the selected item near the one-third scroll line', async ({ page }) => {
  let dialog = await openLongGroceriesOverlay(page)

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
