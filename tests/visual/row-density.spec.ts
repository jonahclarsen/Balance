import { expect, test, type Page } from '@playwright/test'

// A worst-case row: deeply indented, carrying a time range and a goal badge, with
// text long enough to need real width.
const DEEP_TEXT = 'Write the weekly review and file the receipts'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const date = new Date().toISOString().slice(0, 10)
    const item = (
      id: string,
      text: string,
      children: ReturnType<typeof item>[] = [],
      startMinutes: number | null = null,
      endMinutes: number | null = null,
    ) => ({ id, text, html: text, done: false, startMinutes, endMinutes, children })

    const deepest = item('deep_4', 'Write the weekly review and file the receipts', [], 690, 750)
    const branch = item('deep_1', 'Deep task one', [item('deep_2', 'Deep task two', [item('deep_3', 'Deep task three', [deepest])])], 600, 660)

    localStorage.clear()
    localStorage.setItem(
      'balance.appState.v1',
      JSON.stringify({
        schemaVersion: 1,
        deviceId: 'row-density-test',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: date,
        templates: [],
        plans: [{ id: 'plan_density', date, title: 'Density day', dailyReminder: '', items: [branch] }],
        listTemplates: [],
        lists: [],
        metrics: [],
        metricEntries: [],
        goals: [
          {
            id: 'goal_review',
            name: 'Weekly review',
            nameHtml: 'Weekly review',
            cadenceDays: 7,
            matchTerms: ['review'],
            matchTermsHtml: 'review',
            hue: 165,
            lightness: 50,
            activityPeriods: [{ startDate: '2020-01-01', endDate: null }],
            createdAt: '2020-01-01T00:00:00Z',
            updatedAt: '2020-01-01T00:00:00Z',
          },
        ],
        goalCompletions: [],
        operations: [],
      }),
    )
  })
  await page.reload()
  await expect(page.getByRole('listitem', { name: `Plan item: ${DEEP_TEXT}` })).toBeVisible()
})

async function deepRowGeometry(page: Page) {
  return page.getByRole('listitem', { name: `Plan item: ${DEEP_TEXT}` }).evaluate((element) => {
    const shell = element.closest('.item-shell') as HTMLElement
    const text = element.querySelector('[data-plan-text-input]') as HTMLElement
    const badges = element.querySelector('.plan-goal-badges') as HTMLElement
    const time = element.querySelector('.time-range') as HTMLElement
    const badge = element.querySelector('.plan-goal-badge') as HTMLElement
    return {
      rowWidth: shell.getBoundingClientRect().width,
      rowRight: element.getBoundingClientRect().right,
      textWidth: text.getBoundingClientRect().width,
      textTop: text.getBoundingClientRect().top,
      badgeTop: badges.getBoundingClientRect().top,
      badgeRight: badge.getBoundingClientRect().right,
      timeTop: time.getBoundingClientRect().top,
      rowHeight: element.getBoundingClientRect().height,
    }
  })
}

test('a deeply indented task keeps readable text width as its row narrows', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Mobile row density is covered by mobile-layout.spec.ts')

  // Full-width: everything still sits on one line.
  const wide = await deepRowGeometry(page)
  expect(wide.textWidth).toBeGreaterThanOrEqual(320)
  expect(Math.abs(wide.badgeTop - wide.textTop)).toBeLessThan(20)
  expect(Math.abs(wide.timeTop - wide.textTop)).toBeLessThan(20)
  // The goal badge is the last thing on the row and must keep a gutter rather
  // than sitting flush against the row's edge.
  expect(wide.rowRight - wide.badgeRight).toBeGreaterThanOrEqual(8)

  // Halving the row by opening the second day must not squeeze the text to a
  // sliver — the time range and goal badge give up the line instead.
  await page.getByRole('button', { name: 'Compare with another day' }).click()
  const split = await deepRowGeometry(page)
  expect(split.rowWidth).toBeLessThan(wide.rowWidth * 0.6)
  expect(split.textWidth).toBeGreaterThanOrEqual(220)
  expect(split.timeTop).toBeGreaterThan(split.textTop)
  expect(split.badgeTop).toBeGreaterThan(split.timeTop)

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-deep-row-density.png`,
    fullPage: false,
  })

  // Even at a cramped window the text keeps most of the row.
  await page.setViewportSize({ width: 1000, height: 820 })
  const cramped = await deepRowGeometry(page)
  // Split panes reserve a stable scrollbar gutter, so allow a few pixels of
  // rendering variance while the proportional check enforces readability.
  expect(cramped.textWidth).toBeGreaterThanOrEqual(135)
  expect(cramped.textWidth / cramped.rowWidth).toBeGreaterThan(0.55)
})

test('editable task rows carry no add-child or delete buttons', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Add child item' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete item' })).toHaveCount(0)

  // The keyboard paths that replaced them still work.
  const row = page.getByRole('listitem', { name: `Plan item: ${DEEP_TEXT}` })
  await row.getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('listitem', { name: `Plan item: ${DEEP_TEXT}` })).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.getByRole('listitem', { name: `Plan item: ${DEEP_TEXT}` })).toHaveCount(1)
})
