import { expect, test } from '@playwright/test'

// Seed a list template "Groceries" (one item) plus a plan whose task links to it,
// then open the list overlay toast so its generated items are on screen.
async function openGroceriesOverlay(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  await expect(page.getByRole('heading', { name: 'Lists' })).toBeVisible()
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
  await page.getByRole('button', { name: '+ New list' }).click()
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
  await page.getByRole('button', { name: '+ New list' }).click()
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
  await page.getByRole('button', { name: '+ New list' }).click()
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

test('Alt+F opens a task linked list from either its caret or item selection', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.getByLabel('List name').fill('Groceries')
  await page.locator('[data-list-template-text-input]').first().fill('Milk')

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const taskInput = page.locator('[data-plan-text-input]').first()
  await taskInput.fill('Groceries')

  await page.keyboard.press('Alt+f')
  const dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()

  const taskRow = page.getByRole('listitem', { name: 'Plan item: Groceries' })
  await taskRow.getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('Alt+f')
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: 'Close' }).click()
  await page.keyboard.press('Alt+/')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' }))
    .toContainText('Open linked list / metric')
})

test('Alt+F opens the metric linked by the selected list item', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Metrics', exact: true }).click()
  await page.getByRole('button', { name: '+ New metric' }).first().click()
  await page.getByLabel('Metric name').fill('Mood')
  await page.getByLabel('Question prompt').first().fill('Score')
  await page.getByRole('group', { name: 'Question type' }).getByRole('button', { name: 'Yes / no' }).click()

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.getByLabel('List name').fill('Groceries')
  await page.locator('[data-list-template-text-input]').first().fill('Record Mood')

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const taskInput = page.locator('[data-plan-text-input]').first()
  await taskInput.fill('Groceries')
  await taskInput.blur()
  await page.getByTitle('Open Groceries').first().click()

  const listDialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(listDialog.locator('.plan-row.selected')).toContainText('Record Mood')
  await page.keyboard.press('Alt+f')

  const metricDialog = page.getByRole('dialog', { name: 'Mood' })
  await expect(metricDialog).toBeVisible()
  await expect(metricDialog.getByRole('button', { name: /Yes/ })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(metricDialog).toBeHidden()
  await expect(listDialog).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(listDialog).toBeHidden()
})

test('arrowing onto a metric-linked list item opens its metric', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Metrics', exact: true }).click()
  await page.getByRole('button', { name: '+ New metric' }).first().click()
  await page.getByLabel('Metric name').fill('Mood')
  await page.getByLabel('Question prompt').first().fill('Score')
  await page.getByRole('group', { name: 'Question type' }).getByRole('button', { name: 'Yes / no' }).click()

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.getByLabel('List name').fill('Groceries')
  const listItems = page.locator('[data-list-template-text-input]')
  await listItems.first().fill('Milk')
  await page.getByRole('button', { name: '+ Add list item' }).click()
  await listItems.nth(1).fill('Record Mood')

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const taskInput = page.locator('[data-plan-text-input]').first()
  await taskInput.fill('Groceries')
  await taskInput.blur()
  await page.getByTitle('Open Groceries').first().click()

  const listDialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(listDialog.locator('.plan-row.selected')).toContainText('Milk')
  await page.keyboard.press('ArrowDown')

  const metricDialog = page.getByRole('dialog', { name: 'Mood' })
  await expect(metricDialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(metricDialog).toBeHidden()
  await expect(listDialog.locator('.plan-row.selected')).toContainText('Record Mood')

  // Pressing at the boundary is not a new selection and should not repeatedly
  // reopen the selected row's metric.
  await page.keyboard.press('ArrowDown')
  await expect(metricDialog).toBeHidden()
})

test('B goes back and S skips on yes-no metric questions', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Metrics', exact: true }).click()
  await page.getByRole('button', { name: '+ New metric' }).first().click()
  await page.getByLabel('Metric name').fill('Mood')
  await page.getByLabel('Question prompt').first().fill('Morning')
  await page.getByRole('group', { name: 'Question type' }).getByRole('button', { name: 'Yes / no' }).click()
  await page.getByRole('button', { name: '+ Add question' }).click()
  await page.getByLabel('Question prompt').nth(1).fill('Evening')
  await page.getByRole('group', { name: 'Question type' }).nth(1).getByRole('button', { name: 'Yes / no' }).click()

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const firstItem = page.locator('[data-plan-text-input]').first()
  await firstItem.fill('Record Mood')
  await firstItem.blur()
  await page.getByTitle('Open Mood').first().click()

  const metricDialog = page.getByRole('dialog', { name: 'Mood' })
  await expect(metricDialog).toContainText('Question 1 of 2')
  await expect(metricDialog.getByRole('button', { name: /Back B/ })).toBeVisible()
  await expect(metricDialog.getByRole('button', { name: /Skip S/ })).toBeVisible()

  await page.keyboard.press('s')
  await expect(metricDialog).toContainText('Question 2 of 2')
  await page.keyboard.press('b')
  await expect(metricDialog).toContainText('Question 1 of 2')
})

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
  await expect(dialog.locator('.plan-row.selected')).toContainText('Eggs')
})

test('list overlay opens note and external links from generated items', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openPrimaryView(page, 'Notes')
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Project Brain')
  const noteLink = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return `balance://note/${state.notes[0].id}`
  })

  await openPrimaryView(page, 'Lists')
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.getByLabel('List name').fill('Reading')

  const listItems = page.locator('[data-list-template-text-input]')
  const noteItem = listItems.first()
  await noteItem.fill('Open Project Brain')
  await pasteLinkOverText(noteItem, noteLink, 5, 18)
  await noteItem.blur()

  await page.getByRole('button', { name: '+ Add list item' }).click()
  const externalItem = listItems.nth(1)
  await externalItem.fill('Visit example')
  await pasteLinkOverText(externalItem, 'https://example.com/docs', 6, 13)
  await externalItem.blur()

  await generateToday(page)
  const firstItem = page.locator('[data-plan-text-input]').first()
  await firstItem.fill('Reading')
  await firstItem.blur()
  await page.getByTitle('Open Reading').first().click()

  const dialog = page.getByRole('dialog', { name: 'Reading' })
  await expect(dialog).toBeVisible()
  await page.evaluate(() => {
    ;(window as typeof window & { openedExternalURL?: string }).openedExternalURL = ''
    window.open = ((url?: string | URL) => {
      ;(window as typeof window & { openedExternalURL?: string }).openedExternalURL = String(url)
      return null
    }) as typeof window.open
  })

  await dialog.getByRole('link', { name: 'example' }).click()
  await expect.poll(() => page.evaluate(() => (window as typeof window & { openedExternalURL?: string }).openedExternalURL))
    .toBe('https://example.com/docs')
  await expect(dialog).toBeVisible()

  await dialog.getByRole('link', { name: 'Project Brain' }).click()
  await expect(page.getByLabel('Note title')).toHaveValue('Project Brain')
})

async function pasteLinkOverText(
  editor: import('@playwright/test').Locator,
  link: string,
  start: number,
  end: number,
) {
  await editor.evaluate((element, selection) => {
    const range = document.createRange()
    range.setStart(element.firstChild!, selection.start)
    range.setEnd(element.firstChild!, selection.end)
    const browserSelection = document.getSelection()
    browserSelection?.removeAllRanges()
    browserSelection?.addRange(range)

    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', selection.link)
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
  }, { link, start, end })
}

async function openPrimaryView(page: import('@playwright/test').Page, name: 'Today' | 'Lists' | 'Notes') {
  const mobileMenu = page.getByRole('button', { name: 'Open navigation' })
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click()
    await page.getByRole('complementary', { name: 'Primary navigation drawer' })
      .getByRole('button', { name, exact: true })
      .click()
    return
  }

  await page.getByRole('button', { name, exact: true }).click()
}

async function generateToday(page: import('@playwright/test').Page) {
  await openPrimaryView(page, 'Today')
  const emptyState = page.locator('.empty-state')
  await emptyState.getByRole('radio', { name: 'Default day' }).check()
  await emptyState.getByRole('button', { name: 'Generate today' }).click()
}

test('list overlay selects its first item when initially opened', async ({ page }) => {
  const dialog = await openTwoItemGroceriesOverlay(page)

  await expect(dialog.locator('.plan-row.selected')).toContainText('Milk')
})

test('clicking a list row selects it without checking it', async ({ page }) => {
  const dialog = await openTwoItemGroceriesOverlay(page)
  const milkRow = dialog.locator('.plan-row', { hasText: 'Milk' })
  const eggsRow = dialog.locator('.plan-row', { hasText: 'Eggs' })

  await milkRow.click()
  await expect(milkRow.getByRole('checkbox')).not.toBeChecked()

  await eggsRow.click()

  await expect(eggsRow).toHaveClass(/selected/)
  await expect(eggsRow.getByRole('checkbox')).not.toBeChecked()
})

test('ArrowUp reopens the two items above completion-advanced focus', async ({ page }) => {
  const dialog = await openThreeItemGroceriesOverlay(page)
  const milkRow = dialog.locator('.plan-row', { hasText: 'Milk' })
  const eggsRow = dialog.locator('.plan-row', { hasText: 'Eggs' })
  const milkCheckbox = milkRow.getByRole('checkbox')
  const eggsCheckbox = eggsRow.getByRole('checkbox')
  const breadRow = dialog.locator('.plan-row', { hasText: 'Bread' })
  const breadCheckbox = breadRow.getByRole('checkbox')

  await page.keyboard.press('ArrowDown')
  await expect(milkCheckbox).toBeChecked()
  await expect(eggsRow).toHaveClass(/selected/)
  await eggsCheckbox.check()
  await expect(breadRow).toHaveClass(/selected/)

  await page.keyboard.press('ArrowUp')

  await expect(milkCheckbox).toBeChecked()
  await expect(eggsCheckbox).not.toBeChecked()
  await expect(breadCheckbox).not.toBeChecked()
  await expect(eggsRow).toHaveClass(/selected/)
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

test('list modal collapses at the keyboard boundary and expands for upward wheel scrolling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The long-list setup helper uses desktop navigation')
  test.setTimeout(60_000)
  const dialog = await openLongGroceriesOverlay(page)
  const body = dialog.locator('.overlay-body')
  const rows = dialog.locator('.plan-row')

  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight
  })
  const crossoverIndex = await rows.evaluateAll((elements) => {
    const targetTop = window.innerHeight / 3
    let closestIndex = -1
    let closestDistance = Number.POSITIVE_INFINITY
    for (const [index, element] of elements.entries()) {
      const distance = targetTop - element.getBoundingClientRect().top
      if (distance >= 0 && distance < closestDistance && index < elements.length - 2) {
        closestIndex = index
        closestDistance = distance
      }
    }
    return closestIndex
  })
  expect(crossoverIndex).toBeGreaterThanOrEqual(0)

  await rows.nth(crossoverIndex).click()
  await page.waitForTimeout(300)

  const before = await body.evaluate(modalGeometry)
  const expectedFirstCollapse = Math.max(
    0,
    before.nextTop - before.selectedTop - (before.maxScrollTop - before.scrollTop),
  )
  expect(expectedFirstCollapse).toBeGreaterThan(2)

  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(70)
  const midHeight = await dialog.evaluate((element) => element.getBoundingClientRect().height)
  await page.waitForTimeout(220)
  const afterFirst = await body.evaluate(modalGeometry)

  expect(midHeight).toBeLessThan(before.cardHeight)
  expect(midHeight).toBeGreaterThan(afterFirst.cardHeight)
  expect(afterFirst.cardTop).toBeCloseTo(before.cardTop, 0)
  expect(before.cardHeight - afterFirst.cardHeight).toBeCloseTo(expectedFirstCollapse, 0)
  expect(afterFirst.selectedTop).toBeCloseTo(before.selectedTop, 0)

  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(300)
  const afterSecond = await body.evaluate(modalGeometry)

  expect(afterSecond.cardHeight).toBeLessThan(afterFirst.cardHeight)
  expect(afterSecond.cardTop).toBeCloseTo(before.cardTop, 0)
  expect(afterSecond.selectedTop).toBeCloseTo(before.selectedTop, 0)

  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(300)
  const afterFirstReverse = await body.evaluate(modalGeometry)
  expect(afterFirstReverse.cardHeight).toBeCloseTo(afterFirst.cardHeight, 0)
  expect(afterFirstReverse.selectedTop).toBeCloseTo(before.selectedTop, 0)

  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(300)
  const restored = await body.evaluate(modalGeometry)
  expect(restored.cardHeight).toBeCloseTo(before.cardHeight, 0)
  expect(restored.cardTop).toBeCloseTo(before.cardTop, 0)
  expect(restored.selectedTop).toBeCloseTo(before.selectedTop, 0)

  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(300)
  const recollapsed = await body.evaluate(modalGeometry)
  expect(recollapsed.cardHeight).toBeCloseTo(afterFirst.cardHeight, 0)

  await body.hover()
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(70)
  const wheelMidHeight = await dialog.evaluate((element) => element.getBoundingClientRect().height)
  await page.waitForTimeout(220)
  const afterWheel = await body.evaluate(modalGeometry)

  expect(wheelMidHeight).toBeGreaterThan(recollapsed.cardHeight)
  expect(wheelMidHeight).toBeLessThan(before.cardHeight)
  expect(afterWheel.cardHeight).toBeCloseTo(before.cardHeight, 0)
  expect(afterWheel.cardTop).toBeCloseTo(before.cardTop, 0)

  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(300)
  const afterKeyboardResume = await body.evaluate(modalGeometry)
  expect(afterKeyboardResume.cardHeight).toBeLessThan(afterWheel.cardHeight)
  expect(afterKeyboardResume.cardTop).toBeCloseTo(before.cardTop, 0)
  expect(afterKeyboardResume.selectedTop).toBeCloseTo(before.selectedTop, 0)
})

function modalGeometry(element: Element) {
  if (!(element instanceof HTMLElement)) throw new Error('Expected the overlay body')
  const card = element.closest<HTMLElement>('.overlay-card')
  const rows = card ? Array.from(card.querySelectorAll<HTMLElement>('.plan-row')) : []
  const selected = card?.querySelector<HTMLElement>('.plan-row.selected') ?? null
  const selectedIndex = selected ? rows.indexOf(selected) : -1
  const next = rows[selectedIndex + 1]
  if (!card || !selected || !next) throw new Error('Expected a selected row with a following row')

  const cardRect = card.getBoundingClientRect()
  return {
    cardTop: cardRect.top,
    cardHeight: cardRect.height,
    selectedTop: selected.getBoundingClientRect().top,
    nextTop: next.getBoundingClientRect().top,
    scrollTop: element.scrollTop,
    maxScrollTop: element.scrollHeight - element.clientHeight,
  }
}

test('list overlay item shows an edit pencil that jumps to the template and reopens on return', async ({ page }) => {
  const dialog = await openGroceriesOverlay(page)

  // Each generated item exposes a button that jumps back to its source in Lists.
  const editButton = dialog.getByRole('button', { name: 'Edit this item in Lists' })
  await expect(editButton).toBeVisible()
  await expect(editButton.locator('xpath=..').getByText('E', { exact: true })).toBeVisible()
  await editButton.click()

  // The toast hides while we land on Lists with the source item focused.
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Lists' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-list-template-text-input-id') ?? null)).not.toBeNull()
  await expect(page.locator('[data-list-template-text-input]').first()).toContainText('Milk')

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Groceries' })).toBeVisible()
})

test('E edits the selected item in a list overlay', async ({ page }) => {
  const dialog = await openTwoItemGroceriesOverlay(page)

  await page.keyboard.press('ArrowDown')
  await expect(dialog.locator('.plan-row.selected')).toContainText('Eggs')
  await page.keyboard.press('e')

  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Lists' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ''))
    .toBe('Eggs')
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

test('an open list overlay, its selection, and its scroll position survive a reload', async ({ page }) => {
  let dialog = await openLongGroceriesOverlay(page)
  const targetText = 'Item 24'
  await dialog.locator('.plan-row', { hasText: targetText }).click()
  await expect(dialog.locator('.plan-row.selected')).toContainText(targetText)
  await page.waitForTimeout(350)
  await dialog.locator('.overlay-body').evaluate((element) => {
    element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + 180)
  })
  const scrollTopBefore = await dialog.locator('.overlay-body').evaluate((element) => element.scrollTop)

  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance:workspaceViewState') || 'null')
        return state?.listOverlayScrollTopsByList?.[state?.listOverlay?.listId] ?? null
      }),
    )
    .toBe(scrollTopBefore)

  await page.reload()
  dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.plan-row.selected')).toContainText(targetText)
  await expect
    .poll(() => dialog.locator('.overlay-body').evaluate((element) => element.scrollTop))
    .toBeGreaterThanOrEqual(scrollTopBefore - 2)
  expect(await dialog.locator('.overlay-body').evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(scrollTopBefore + 2)
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
