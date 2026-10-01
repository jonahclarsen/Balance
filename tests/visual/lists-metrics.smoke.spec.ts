import { expect, test } from '@playwright/test'
import { generateDay, openView } from '../helpers/navigation'

async function archivedListItems(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    return state.listTemplates[0].archivedItems.map((entry: { item: { text: string } }) => entry.item.text)
  })
}

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
  await openView(page, 'Quizzes')
}

async function openLists(page: import('@playwright/test').Page) {
  await openView(page, 'Lists')
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

test('list template max word count automatically locks 10 seconds after unlocking', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openLists(page)
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.clock.install()

  const maxInput = page.getByRole('spinbutton', { name: 'max' })
  await expect(maxInput).toBeDisabled()
  await page.getByRole('button', { name: 'Unlock to edit max word count' }).click()
  await expect(maxInput).toBeEnabled()

  await page.clock.fastForward(9_000)
  await expect(maxInput).toBeEnabled()
  await page.clock.fastForward(1_000)
  await expect(maxInput).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Unlock to edit max word count' })).toBeVisible()
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
  await page.getByRole('button', { name: 'View Archive', exact: true }).click()

  const archivedRow = page.locator('.list-item-archive-row', { hasText: 'Milk' })
  await expect(archivedRow).toBeVisible()
  const archivedDate = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.listTemplates[0].archivedItems[0].archivedDate as string
  })
  await expect(archivedRow.locator('time')).toHaveAttribute('datetime', archivedDate)

  await page.keyboard.press('Meta+Z')
  await expect(page.locator('[data-list-template-text-input]').first()).toHaveText('Milk')
  await expect.poll(() => archivedListItems(page)).toEqual([])
  await page.keyboard.press('Meta+Shift+Z')
  await expect(page.locator('[data-list-template-text-input]')).toHaveCount(0)
  await expect.poll(() => archivedListItems(page)).toEqual(['Milk'])

  // Undo/redo reveals the edited list and closes its auxiliary archive panel.
  await page.getByRole('button', { name: 'View Archive', exact: true }).click()
  await archivedRow.getByRole('button', { name: 'Restore' }).click()
  await expect.poll(() => archivedListItems(page)).toEqual([])
  item = page.locator('[data-list-template-text-input]').first()
  await expect(item).toHaveText('Milk')

  // Clearing and then typing before focus leaves the row is a replacement edit,
  // not an archive-worthy deletion.
  await item.press('Meta+A')
  await item.press('Backspace')
  await item.type('Oat milk')
  await page.getByLabel('List name').click()
  await expect(page.locator('[data-list-template-text-input]').first()).toHaveText('Oat milk')
  await expect.poll(() => archivedListItems(page)).toEqual([])
})

test('command backspace archives a list item immediately', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Command-key editing is covered by the desktop project')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openView(page, 'Lists')
  await page.getByRole('button', { name: '+ New list' }).click()
  const item = page.locator('[data-list-template-text-input]').first()
  await item.fill('Remove me')
  await item.press('Meta+Backspace')

  await expect(page.locator('[data-list-template-text-input]')).toHaveCount(0)
  await expect.poll(() => archivedListItems(page)).toEqual(['Remove me'])
})

test('quiz links in a list template open the quiz editor instead of the quiz', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openMetrics(page)
  await page.getByRole('button', { name: '+ New quiz' }).first().click()
  await page.getByLabel('Quiz name').fill('Mood')
  await page.getByRole('button', { name: 'New quiz', exact: true }).click()
  await page.getByLabel('Quiz name').fill('Energy')

  await openLists(page)
  await page.getByRole('button', { name: '+ New list' }).click()
  const listItem = page.locator('[data-list-template-text-input]').first()
  await listItem.fill('log Mood now')
  await listItem.blur()

  await page.getByTitle('Open Mood').first().click()
  await expect(page.getByRole('dialog', { name: 'Mood' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Quizzes' })).toBeVisible()
  await expect(page.getByLabel('Quiz name')).toHaveValue('Mood')
})

test('a numeric quiz records an answer from its task link and shows it on the graph', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openMetrics(page)
  await page.getByRole('button', { name: '+ New quiz' }).first().click()
  await page.getByLabel('Quiz name').fill('Mood')
  await page.getByLabel('Question prompt').first().fill('Score')
  await page.getByRole('group', { name: 'Question type' }).first().getByRole('button', { name: 'Number', exact: true }).click()

  // Link from a daily task.
  await openView(page, 'Today')
  await generateDay(page)
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
  await dialog.getByRole('spinbutton').fill('7')
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
  await page.getByRole('button', { name: '+ New quiz' }).click()
  await page.getByLabel('Quiz name').fill('Alpha')
  await page.getByRole('button', { name: 'New quiz', exact: true }).click()
  await page.getByLabel('Quiz name').fill('Beta')

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
  await page.getByRole('button', { name: '+ New quiz' }).first().click()
  await page.getByLabel('Quiz name').fill('Irregular history')
  await page.getByLabel('Question prompt').first().fill('Score')
  await page.getByRole('group', { name: 'Question type' }).first().getByRole('button', { name: 'Number', exact: true }).click()

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
  expect(pointXs[1] - pointXs[0]).toBeGreaterThan(0)
  expect(pointXs[2] - pointXs[1]).toBeGreaterThan((pointXs[1] - pointXs[0]) * 20)
})

test('finishing a list survey opens the next row survey', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const date = new Date().toISOString().slice(0, 10)
    const now = new Date().toISOString()
    const templateItem = (id: string, text: string) => ({ id, text, html: text, probability: 100, children: [] })
    const metric = (id: string, name: string) => ({
      id,
      name,
      questions: [{ id: `${id}_q`, prompt: `${name}?`, html: '', type: 'boolean' }],
      createdAt: now,
      updatedAt: now,
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
            createdAt: now,
            items: [{ id: 'item_0', text: 'Checkin', html: 'Checkin', done: false, startMinutes: null, endMinutes: null, children: [] }],
          },
        ],
        listTemplates: [
          {
            id: 'list_template_checkin',
            name: 'Checkin',
            maxExpectedWords: 0,
            items: [
              templateItem('t_start', 'Start'),
              templateItem('t_mood', 'Mood'),
              templateItem('t_sleep', 'Sleep'),
              templateItem('t_stretch', 'Stretch'),
            ],
            createdAt: now,
            updatedAt: now,
          },
        ],
        lists: [],
        metrics: [metric('metric_mood', 'Mood'), metric('metric_sleep', 'Sleep')],
        metricEntries: [],
        goals: [],
        goalCompletions: [],
        operations: [],
      }),
    )
  })
  await page.reload()

  await page.getByTitle('Open Checkin').click()
  await expect(page.getByRole('dialog', { name: 'Checkin' })).toBeVisible()

  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('dialog', { name: /^Mood · / })).toBeVisible()
  await page.keyboard.press('y')

  await expect(page.getByRole('dialog', { name: /^Mood · / })).toBeHidden()
  await expect(page.getByRole('dialog', { name: /^Sleep · / })).toBeVisible()
  await page.keyboard.press('y')

  await expect(page.getByRole('dialog', { name: /^Sleep · / })).toBeHidden()
  await expect(page.locator('.metric-quiz')).toHaveCount(0)
})
