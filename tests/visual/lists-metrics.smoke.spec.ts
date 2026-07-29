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

test('list template word cap blocks typing past the max', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list template' }).click()

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

test('metric quiz records answers and bulk import backfills', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Metrics', exact: true }).click()
  await page.getByRole('button', { name: '+ New metric' }).first().click()
  await page.getByLabel('Metric name').fill('Mood')
  await page.getByLabel('Question prompt').first().fill('Score')

  // Link from a daily task.
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const firstItem = page.locator('[data-plan-text-input]').first()
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

  // The numeric graph shows up in the Metrics view.
  await page.getByRole('button', { name: 'Metrics', exact: true }).click()
  await expect(page.locator('.metric-graph').first()).toBeVisible()
})
