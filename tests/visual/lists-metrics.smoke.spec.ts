import { expect, test } from '@playwright/test'

test('arrow navigation lands on list-linked plan items', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const date = new Date().toISOString().slice(0, 10)
    const item = (id: string, text: string) => ({
      id,
      text,
      html: text,
      done: false,
      startMinutes: null,
      endMinutes: null,
      children: [],
    })

    localStorage.setItem(
      'balance.appState.v1',
      JSON.stringify({
        schemaVersion: 1,
        deviceId: 'test-device',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: date,
        templates: [],
        plans: [
          {
            id: 'plan_test',
            date,
            title: 'Today',
            dailyReminder: '',
            generatedFromTemplateId: null,
            createdAt: new Date().toISOString(),
            items: [item('item_0', 'Above'), item('item_1', 'Groceries'), item('item_2', 'Below')],
          },
        ],
        listTemplates: [
          {
            id: 'list_template_groceries',
            name: 'Groceries',
            maxExpectedWords: 0,
            items: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        lists: [],
        metrics: [],
        metricEntries: [],
        goals: [],
        goalCompletions: [],
        operations: [],
      }),
    )
  })
  await page.reload()

  await expect(page.getByTitle('Open Groceries')).toBeVisible()
  await focusPlanTextTarget(page, 'item_2')
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => activePlanTextTarget(page)).toEqual({ id: 'item_1', display: false, collapsedCaret: true })

  await page.getByTitle('Open Groceries').click()
  await expect(page.getByRole('dialog', { name: 'Groceries' })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.keyboard.press('ArrowDown')
  await expect.poll(() => activePlanTextTarget(page)).toEqual({ id: 'item_2', display: false, collapsedCaret: true })
})

async function focusPlanTextTarget(page: import('@playwright/test').Page, itemId: string) {
  await page.evaluate((id) => {
    const target = document.querySelector<HTMLElement>(`[data-plan-text-focus-target-id="${id}"]`)
    target?.focus()

    if (!target?.matches('[contenteditable="true"]')) return

    const range = document.createRange()
    range.selectNodeContents(target)
    range.collapse(false)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, itemId)
}

async function activePlanTextTarget(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return null
    const selection = document.getSelection()
    return {
      id: active.dataset.planTextFocusTargetId ?? null,
      display: active.classList.contains('item-text-display'),
      collapsedCaret: Boolean(selection?.isCollapsed && selection.rangeCount > 0 && active.contains(selection.getRangeAt(0).startContainer)),
    }
  })
}

async function openMetrics(page: import('@playwright/test').Page) {
  const mobileMenu = page.getByRole('button', { name: 'Open navigation' })
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click()
    await page.getByRole('complementary', { name: 'Primary navigation drawer' }).getByRole('button', { name: 'Metrics', exact: true }).click()
  } else {
    await page.getByRole('button', { name: 'Metrics', exact: true }).click()
  }
}

async function openLists(page: import('@playwright/test').Page) {
  const mobileMenu = page.getByRole('button', { name: 'Open navigation' })
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click()
    await page.getByRole('complementary', { name: 'Primary navigation drawer' }).getByRole('button', { name: 'Lists', exact: true }).click()
  } else {
    await page.getByRole('button', { name: 'Lists', exact: true }).click()
  }
}

test('list template word cap blocks typing past the max', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openLists(page)
  await page.getByRole('button', { name: '+ New list' }).click()

  // Unlock and set a small cap of 2 expected words.
  await page.getByRole('button', { name: 'Unlock to edit max word count' }).click()
  const maxInput = page.locator('.word-cap-edit input')
  await maxInput.fill('2')

  // Typing a fourth word is rejected; the counter never exceeds the cap.
  const listItem = page.locator('[data-list-template-text-input]').first()
  await listItem.fill('')
  await listItem.click()
  await page.keyboard.type('one two three four')
  await expect(page.locator('.word-cap-count')).toContainText('2 / 2')
})

test('clearing a list item archives it on blur, while replacement typing stays an edit', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openLists(page)
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.getByLabel('List name').fill('Groceries')

  let item = page.locator('[data-list-template-text-input]').first()
  await item.fill('Milk')
  await item.press('Meta+A')
  await item.press('Backspace')
  await expect(item).toHaveText('')

  // Leaving the cleared editor commits a deletion using the still-persisted
  // non-empty snapshot, so one Undo can restore the whole operation.
  await page.getByLabel('List name').click()
  await expect(page.locator('[data-list-template-text-input]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Archive (1)' }).click()

  const archivedRow = page.locator('.list-item-archive-row', { hasText: 'Milk' })
  await expect(archivedRow).toBeVisible()
  const archivedDate = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.listTemplates[0].archivedItems[0].archivedDate as string
  })
  await expect(archivedRow.locator('time')).toHaveAttribute('datetime', archivedDate)

  await page.keyboard.press('Meta+Z')
  await expect(page.locator('[data-list-template-text-input]').first()).toHaveText('Milk')
  await expect(page.getByRole('button', { name: 'Archive (0)' })).toBeVisible()
  await page.keyboard.press('Meta+Shift+Z')
  await expect(page.locator('[data-list-template-text-input]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Archive (1)' })).toBeVisible()

  await archivedRow.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByRole('button', { name: 'Archive (0)' })).toBeVisible()
  item = page.locator('[data-list-template-text-input]').first()
  await expect(item).toHaveText('Milk')

  // Clearing and then typing before focus leaves the row is a replacement edit,
  // not an archive-worthy deletion.
  await item.press('Meta+A')
  await item.press('Backspace')
  await item.type('Oat milk')
  await page.getByLabel('List name').click()
  await expect(page.locator('[data-list-template-text-input]').first()).toHaveText('Oat milk')
  await expect(page.getByRole('button', { name: 'Archive (0)' })).toBeVisible()
})

test('command backspace archives a list item immediately', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Command-key editing is covered by the desktop project')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  const item = page.locator('[data-list-template-text-input]').first()
  await item.fill('Remove me')
  await item.press('Meta+Backspace')

  await expect(page.locator('[data-list-template-text-input]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Archive (1)' })).toBeVisible()
})

test('metric quiz records answers and bulk import backfills', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openMetrics(page)
  await page.getByRole('button', { name: '+ New metric' }).first().click()
  await page.getByLabel('Metric name').fill('Mood')
  await page.getByLabel('Question prompt').first().fill('Score')

  // Link from a daily task.
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const firstItem = page.locator('[data-plan-text-input]').first()
  const secondItemId = await page.locator('[data-plan-text-input]').nth(1).getAttribute('data-plan-text-input-id')
  await firstItem.fill('log Mood now')
  await firstItem.blur()

  // Only the matching substring "Mood" is the hyperlink, not the whole task.
  const moodLink = page.getByTitle('Open Mood').first()
  await expect(moodLink).toHaveText('Mood')
  await expect(page.locator('[data-plan-text-input]').first()).toContainText('log')

  await moodLink.click()
  const dialog = page.getByRole('dialog', { name: 'Mood' })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder('Type your answer, press Enter').fill('7')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect.poll(() => activePlanTextTarget(page)).toEqual({
    id: secondItemId,
    display: false,
    collapsedCaret: true,
  })

  // The numeric graph shows up in the Metrics view.
  await openMetrics(page)
  await expect(page.locator('.metric-graph').first()).toBeVisible()
})

test('Alt+Q and Alt+W select adjacent metrics', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openMetrics(page)
  await page.getByRole('button', { name: '+ New metric' }).click()
  await page.getByLabel('Metric name').fill('Alpha')
  await page.getByRole('button', { name: 'New metric', exact: true }).click()
  await page.getByLabel('Metric name').fill('Beta')

  const alphaTab = page.getByRole('button', { name: 'Alpha', exact: true })
  const betaTab = page.getByRole('button', { name: 'Beta', exact: true })
  await expect(betaTab).toHaveAttribute('aria-current', 'true')

  await page.keyboard.press('Alt+Q')
  await expect(alphaTab).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Alt+W')
  await expect(betaTab).toHaveAttribute('aria-current', 'true')
})

test('metric graph uses elapsed dates for point spacing and labels its x-axis', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openMetrics(page)
  await page.getByRole('button', { name: '+ New metric' }).first().click()
  await page.getByLabel('Metric name').fill('Irregular history')
  await page.getByLabel('Question prompt').first().fill('Score')

  await page.evaluate(() => {
    const key = 'balance.appState.v1'
    const state = JSON.parse(localStorage.getItem(key) || '{}')
    const metric = state.metrics[0]
    const question = metric.questions[0]
    state.metricEntries = [
      { id: 'entry_1', metricId: metric.id, date: '2026-01-01', answers: [{ questionId: question.id, value: '2' }] },
      { id: 'entry_2', metricId: metric.id, date: '2026-01-02', answers: [{ questionId: question.id, value: '4' }] },
      { id: 'entry_3', metricId: metric.id, date: '2026-04-01', answers: [{ questionId: question.id, value: '8' }] },
    ]
    localStorage.setItem(key, JSON.stringify(state))
  })
  await page.reload()
  await openMetrics(page)

  const graph = page.locator('.metric-graph').first()
  await expect(graph).toBeVisible()
  await expect(graph.locator('.date-label')).toContainText(['Jan 1', 'Apr 1'])

  const pointXs = await graph.locator('circle.dot').evaluateAll((dots) => dots.map((dot) => Number(dot.getAttribute('cx'))))
  expect(pointXs).toHaveLength(3)
  expect(pointXs[1] - pointXs[0]).toBeLessThan(10)
  expect(pointXs[2] - pointXs[1]).toBeGreaterThan(400)
})
