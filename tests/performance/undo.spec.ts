import { expect, test } from '@playwright/test'

const PLAN_COUNT = performanceSize('BALANCE_UNDO_PERF_PLANS', 180)
const ITEMS_PER_PLAN = performanceSize('BALANCE_UNDO_PERF_ITEMS_PER_PLAN', 25)
const GOAL_COUNT = performanceSize('BALANCE_UNDO_PERF_GOALS', 80)

function performanceSize(variable: string, fallback: number) {
  const value = Number(process.env[variable])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

test('profiles pasted-link undo through the frontend store and renderer', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(
    ({ planCount, itemsPerPlan, goalCount }) => {
      const plans = Array.from({ length: planCount }, (_, planIndex) => ({
        id: `plan_${planIndex}`,
        date: performanceDate(planIndex),
        title: `Plan ${planIndex}`,
        dailyReminder: '',
        generatedFromTemplateId: null,
        createdAt: '2026-01-01T00:00:00Z',
        items: Array.from({ length: itemsPerPlan }, (_, itemIndex) => ({
          id: `plan_${planIndex}_item_${itemIndex}`,
          text: `Plan ${planIndex} item ${itemIndex}`,
          html: `Plan ${planIndex} item ${itemIndex}`,
          done: itemIndex % 3 === 0,
          startMinutes: null,
          endMinutes: null,
          children: [],
        })),
      }))
      const goals = Array.from({ length: goalCount }, (_, goalIndex) => ({
        id: `goal_${goalIndex}`,
        name: `Goal ${goalIndex}`,
        nameHtml: `Goal ${goalIndex}`,
        cadenceDays: 3,
        matchTerms: [`term-${goalIndex}`],
        matchTermsHtml: `term-${goalIndex}`,
        hue: Math.floor((goalIndex * 360) / goalCount),
        lightness: 50,
        activityPeriods: [{ startDate: '2026-01-01', endDate: null }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }))

      localStorage.setItem(
        'balance.appState.v1',
        JSON.stringify({
          schemaVersion: 1,
          deviceId: 'device_perf',
          localSequence: 0,
          historyRevision: 0,
          activePlanDate: performanceDate(planCount - 1),
          templates: [],
          plans,
          listTemplates: [],
          lists: [],
          metrics: [],
          metricEntries: [],
          goals,
          goalCompletions: [],
          operations: [],
        }),
      )

      function performanceDate(index: number) {
        const daysPerTestYear = 12 * 28
        const year = 2020 + Math.floor(index / daysPerTestYear)
        const dayOfYear = index % daysPerTestYear
        const month = Math.floor(dayOfYear / 28) + 1
        const day = (dayOfYear % 28) + 1
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      }
    },
    { planCount: PLAN_COUNT, itemsPerPlan: ITEMS_PER_PLAN, goalCount: GOAL_COUNT },
  )
  await page.reload()
  await page.getByRole('button', { name: 'Goals', exact: true }).click()

  const editor = page.getByRole('textbox', { name: 'Goal name: Goal 0' })
  await editor.evaluate((element) => {
    const text = element.firstChild
    if (!text) throw new Error('Expected goal-title text')

    element.focus()
    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'https://example.com/goal')
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    )
  })
  await expect(editor.getByRole('link', { name: 'Goal 0' })).toBeVisible()

  const undoMs = await editor.evaluate(async (element) => {
    const started = performance.now()
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        code: 'KeyZ',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )

    while (element.querySelector('a')) {
      await new Promise(requestAnimationFrame)
    }
    await new Promise(requestAnimationFrame)
    return performance.now() - started
  })

  const profile = {
    plans: PLAN_COUNT,
    items: PLAN_COUNT * ITEMS_PER_PLAN,
    goals: GOAL_COUNT,
    undoAndRenderMs: undoMs,
  }
  console.log(`UNDO_PERF frontend ${JSON.stringify(profile)}`)
  await testInfo.attach('undo-performance.json', {
    body: JSON.stringify(profile, null, 2),
    contentType: 'application/json',
  })

  await expect(editor).toHaveText('Goal 0')
})
