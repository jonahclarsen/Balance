import { expect, test } from '@playwright/test'

test('metrics editor uses a readable phone layout', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This layout is mobile-only')
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/')
  await page.evaluate(() => {
    const createdAt = '2026-08-24T12:00:00.000Z'
    localStorage.clear()
    localStorage.setItem(
      'balance.appState.v1',
      JSON.stringify({
        schemaVersion: 1,
        deviceId: 'mobile-metrics-test',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: '2026-08-24',
        templates: [],
        plans: [],
        listTemplates: [],
        lists: [],
        metrics: [
          {
            id: 'wellbeing',
            name: 'Wellbeing check-in',
            questions: [
              { id: 'energy', prompt: 'How was your energy today?', html: 'How was your energy today?', type: 'text' },
              { id: 'outside', prompt: 'Did you spend time outside?', html: 'Did you spend time outside?', type: 'boolean' },
              { id: 'note', prompt: 'What helped most?', html: 'What helped most?', type: 'text' },
            ],
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: 'sleep',
            name: 'Sleep',
            questions: [{ id: 'hours', prompt: 'Hours slept', html: 'Hours slept', type: 'text' }],
            createdAt,
            updatedAt: createdAt,
          },
        ],
        metricEntries: [
          {
            id: 'entry-1',
            metricId: 'wellbeing',
            date: '2026-08-22',
            answers: [
              { questionId: 'energy', value: '6' },
              { questionId: 'outside', value: 'n' },
            ],
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: 'entry-2',
            metricId: 'wellbeing',
            date: '2026-08-24',
            answers: [
              { questionId: 'energy', value: '8' },
              { questionId: 'outside', value: 'y' },
            ],
            createdAt,
            updatedAt: createdAt,
          },
        ],
        goals: [],
        goalCompletions: [],
        operations: [],
      }),
    )
  })
  await page.reload()

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page
    .getByRole('complementary', { name: 'Primary navigation drawer' })
    .getByRole('button', { name: 'Metrics', exact: true })
    .click()

  await expect(page.locator('.app-shell')).not.toHaveClass(/mobile-drawer-open/)
  await page.waitForTimeout(250)
  await expect(page.getByRole('heading', { name: 'Metrics' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)

  const questionRows = page.locator('.metric-question-row')
  await expect(questionRows).toHaveCount(3)
  const layout = await questionRows.first().evaluate((row) => {
    const rowRect = row.getBoundingClientRect()
    const promptRect = row.querySelector<HTMLElement>('.metric-question-prompt')?.getBoundingClientRect()
    const selectRect = row.querySelector<HTMLSelectElement>('select')?.getBoundingClientRect()
    const buttonRects = [...row.querySelectorAll<HTMLButtonElement>('button')].map((button) => button.getBoundingClientRect())
    return {
      rowWidth: rowRect.width,
      rowRight: rowRect.right,
      promptWidth: promptRect?.width ?? 0,
      promptBottom: promptRect?.bottom ?? 0,
      controlsTop: selectRect?.top ?? 0,
      selectWidth: selectRect?.width ?? 0,
      buttonSizes: buttonRects.map(({ width, height }) => ({ width, height })),
    }
  })
  expect(layout.rowRight).toBeLessThanOrEqual(360)
  expect(layout.promptWidth).toBeGreaterThan(layout.rowWidth * 0.85)
  expect(layout.controlsTop).toBeGreaterThan(layout.promptBottom)
  expect(layout.selectWidth).toBeGreaterThanOrEqual(140)
  expect(layout.buttonSizes).toHaveLength(3)
  expect(layout.buttonSizes.every(({ width, height }) => width >= 40 && height >= 40)).toBe(true)

  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-metrics.png',
    fullPage: true,
  })
})
