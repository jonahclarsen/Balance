import { expect, test, type Locator, type Page } from '@playwright/test'

// Drags one item's handle onto a target row. The drag handles use pointer capture
// and resolve their drop target with elementFromPoint, so a real mouse press +
// move + release is what exercises them.
async function dragItemOnto(page: Page, handle: Locator, target: Locator, edge: 'top' | 'bottom' = 'top') {
  const handleBox = await handle.boundingBox()
  const targetBox = await target.boundingBox()
  if (!handleBox || !targetBox) throw new Error('Expected both the drag handle and the drop target to be visible')

  const dropY = edge === 'top' ? targetBox.y + targetBox.height * 0.15 : targetBox.y + targetBox.height * 0.85

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  // An intermediate move makes the drop marker resolve before the release.
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 })
  await page.mouse.move(targetBox.x + targetBox.width / 2, dropY, { steps: 4 })
  await page.mouse.up()
}

function paneFor(page: Page, name: 'Daily plan' | 'Compared day') {
  return page.getByRole('region', { name })
}

async function openTwoGeneratedDays(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await expect(page.locator('[data-plan-text-input]').first()).toBeVisible()

  await page.getByRole('button', { name: 'Compare with another day' }).click()

  const comparePane = paneFor(page, 'Compared day')
  await expect(comparePane).toBeVisible()
  await comparePane.getByRole('button', { name: 'Generate this day' }).click()
  await expect(comparePane.locator('[data-plan-text-input]').first()).toBeVisible()
}

test('two days show side by side and items can be dragged between them', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The panes stack on mobile; dragging is covered on desktop.')

  await openTwoGeneratedDays(page)

  const primaryPane = paneFor(page, 'Daily plan')
  const comparePane = paneFor(page, 'Compared day')

  // The comparison day defaults to the day after the active one.
  const primaryDate = await primaryPane.locator('.date-input').inputValue()
  const compareDate = await comparePane.locator('.date-input').inputValue()
  expect(new Date(`${compareDate}T00:00:00Z`).getTime() - new Date(`${primaryDate}T00:00:00Z`).getTime()).toBe(
    24 * 60 * 60 * 1000,
  )

  await expect(primaryPane.locator('[data-plan-item-id]')).toHaveCount(5)
  await expect(comparePane.locator('[data-plan-item-id]')).toHaveCount(5)

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-side-by-side-days.png`,
    fullPage: true,
  })

  // "Work block" carries two children, so this also proves a subtree moves whole.
  const movedRow = primaryPane.locator('[data-plan-item-id]').filter({ hasText: 'Work block' }).first()
  const movedItemId = await movedRow.getAttribute('data-plan-item-id')
  const handle = movedRow.getByRole('button', { name: 'Drag to move item' })
  const target = comparePane.locator('[data-plan-item-id]').first()

  await dragItemOnto(page, handle, target)

  await expect(primaryPane.locator(`[data-plan-item-id="${movedItemId}"]`)).toHaveCount(0)
  await expect(comparePane.locator(`[data-plan-item-id="${movedItemId}"]`)).toHaveCount(1)
  await expect(primaryPane.locator('[data-plan-item-id]')).toHaveCount(2)
  await expect(comparePane.locator('[data-plan-item-id]')).toHaveCount(8)
  // The child rows came along rather than being stranded in the old day. Both days
  // were generated from the same template, so the compare pane now holds two.
  await expect(primaryPane.locator('[data-plan-item-id]').filter({ hasText: 'Write down next action' })).toHaveCount(0)
  await expect(comparePane.locator('[data-plan-item-id]').filter({ hasText: 'Write down next action' })).toHaveCount(2)

  // A single undo puts the whole subtree back where it started.
  await page.keyboard.press('ControlOrMeta+z')
  await expect(primaryPane.locator(`[data-plan-item-id="${movedItemId}"]`)).toHaveCount(1)
  await expect(primaryPane.locator('[data-plan-item-id]')).toHaveCount(5)
  await expect(comparePane.locator('[data-plan-item-id]')).toHaveCount(5)
})

test('each side-by-side day scrolls independently', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Mobile comparison panes stack in the document flow.')

  await openTwoGeneratedDays(page)
  await page.setViewportSize({ width: 1000, height: 430 })

  const primaryPane = paneFor(page, 'Daily plan')
  const comparePane = paneFor(page, 'Compared day')
  await expect
    .poll(() => primaryPane.evaluate((pane) => pane.scrollHeight > pane.clientHeight))
    .toBe(true)
  await expect
    .poll(() => comparePane.evaluate((pane) => pane.scrollHeight > pane.clientHeight))
    .toBe(true)

  await primaryPane.evaluate((pane) => pane.scrollTo(0, pane.scrollHeight))
  const primaryScrollTop = await primaryPane.evaluate((pane) => pane.scrollTop)
  expect(primaryScrollTop).toBeGreaterThan(0)
  await expect.poll(() => comparePane.evaluate((pane) => pane.scrollTop)).toBe(0)

  await comparePane.evaluate((pane) => pane.scrollTo(0, pane.scrollHeight))
  await expect.poll(() => comparePane.evaluate((pane) => pane.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => primaryPane.evaluate((pane) => pane.scrollTop)).toBe(primaryScrollTop)
})

test('opening comparison from tomorrow shows today followed by tomorrow', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  const primaryDateInput = paneFor(page, 'Daily plan').locator('.date-input')
  const today = await primaryDateInput.inputValue()
  const tomorrow = new Date(`${today}T00:00:00Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const tomorrowISO = tomorrow.toISOString().slice(0, 10)

  await primaryDateInput.fill(tomorrowISO)
  await page.getByRole('button', { name: 'Compare with another day' }).click()

  await expect(paneFor(page, 'Daily plan').locator('.date-input')).toHaveValue(today)
  await expect(paneFor(page, 'Compared day').locator('.date-input')).toHaveValue(tomorrowISO)
})

test('dropping on empty panel space appends to the end of the other day', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The panes stack on mobile; dragging is covered on desktop.')

  await openTwoGeneratedDays(page)

  const primaryPane = paneFor(page, 'Daily plan')
  const comparePane = paneFor(page, 'Compared day')

  const movedRow = primaryPane.locator('[data-plan-item-id]').filter({ hasText: 'Wake up' }).first()
  const movedItemId = await movedRow.getAttribute('data-plan-item-id')
  const handle = movedRow.getByRole('button', { name: 'Drag to move item' })

  // The "+ Add item" row sits inside the panel but outside every item row, so it
  // stands in for the panel's empty tail.
  await dragItemOnto(page, handle, comparePane.getByRole('button', { name: '+ Add item' }))

  const compareIds = comparePane.locator('[data-plan-item-id]')
  await expect(compareIds).toHaveCount(6)
  await expect(compareIds.last()).toHaveAttribute('data-plan-item-id', movedItemId ?? '')
})

test('selection and arrow navigation stay inside the pane you last touched', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Selection handles are mouse-only.')

  await openTwoGeneratedDays(page)

  const primaryPane = paneFor(page, 'Daily plan')
  const comparePane = paneFor(page, 'Compared day')

  // Selecting in the compare pane must aim the plan shortcuts at that day.
  await comparePane.locator('[data-plan-item-id]').first().getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('ControlOrMeta+d')
  await expect(comparePane.locator('[data-plan-item-id]').first()).toHaveClass(/done/)
  await expect(primaryPane.locator('.plan-row.done')).toHaveCount(0)

  // Arrow keys must not walk out of the last row of one day into the next day.
  const lastPrimaryInput = primaryPane.locator('[data-plan-text-input]').last()
  await lastPrimaryInput.click()
  await page.keyboard.press('ArrowDown')
  await expect(lastPrimaryInput).toBeFocused()
})

test('the comparison toggles with Alt+B and survives a reload', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await expect(paneFor(page, 'Compared day')).toHaveCount(0)

  await page.keyboard.press('Alt+b')
  await expect(paneFor(page, 'Compared day')).toBeVisible()

  await page.reload()
  await expect(paneFor(page, 'Compared day')).toBeVisible()

  await page.keyboard.press('Alt+b')
  await expect(paneFor(page, 'Compared day')).toHaveCount(0)

  await page.reload()
  await expect(paneFor(page, 'Compared day')).toHaveCount(0)
})
