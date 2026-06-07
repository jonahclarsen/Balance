import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a completed matching plan item automatically completes a goal and shows its color badge', async ({ page }, testInfo) => {
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await createGoal(page, 'Exercise', 1, 'lift, swim')

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  const matchingText = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.plans?.[0]?.items?.find((item: { text: string }) => /lift|swim/i.test(item.text))?.text ?? ''
  })
  expect(matchingText).not.toBe('')

  const row = page.getByRole('listitem', { name: `Plan item: ${matchingText}` })
  await row.getByRole('checkbox', { name: 'Complete item' }).check()

  await expect(row.locator('.plan-goal-badge', { hasText: 'Exercise' })).toBeVisible()
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.goalCompletions?.map((completion: { goalId: string; itemIds: string[] }) => ({
          goalId: completion.goalId,
          itemIds: completion.itemIds,
        }))
      }),
    )
    .toHaveLength(1)

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-goal-completed.png`,
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await page.getByLabel('Matching terms for Exercise').fill('rowing')
  await page.getByLabel('Matching terms for Exercise').press('Tab')
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(row.locator('.plan-goal-badge', { hasText: 'Exercise' })).toHaveCount(0)
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.goalCompletions?.length ?? -1
      }),
    )
    .toBe(0)

  const editor = row.locator('[contenteditable="true"]')
  const editorId = await editor.getAttribute('data-plan-text-input-id')
  expect(editorId).not.toBeNull()
  await editor.evaluate((element) => {
    element.textContent = 'rowing'
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'rowing' }))
    element.textContent = 'rowing workout'
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' workout' }))
  })
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const payload = state.operations?.at(-1)?.payload
        return payload?.goalData?.goalCompletions?.length ?? -1
      }),
    )
    .toBe(1)
  await page.locator(`[data-plan-text-input-id="${editorId}"]`).fill(matchingText)

  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await page.getByLabel('Matching terms for Exercise').fill('lift, swim')
  await page.getByLabel('Matching terms for Exercise').press('Tab')
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(row.locator('.plan-goal-badge', { hasText: 'Exercise' })).toBeVisible()

  await row.getByRole('checkbox', { name: 'Complete item' }).uncheck()
  await expect(row.locator('.plan-goal-badge', { hasText: 'Exercise' })).toHaveCount(0)
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.goalCompletions?.length ?? -1
      }),
    )
    .toBe(0)
})

test('task typing only rescans goals when its match result changes', async ({ page }) => {
  const matchTerm = 'needle-goal-token'
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await createGoal(page, 'Needle', 1, matchTerm)
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  const wakeRow = page.getByRole('listitem', { name: 'Plan item: Wake up' })
  const targetRow = page.getByRole('listitem', { name: 'Plan item: Work block' })
  const targetId = await targetRow.getAttribute('data-plan-item-id')
  expect(targetId).not.toBeNull()
  const stableTargetRow = page.locator(`[data-plan-item-id="${targetId}"]`)
  const targetEditor = stableTargetRow.locator('[contenteditable="true"]')
  await wakeRow.getByRole('checkbox', { name: 'Complete item' }).check()

  await page.evaluate((term) => {
    const originalIncludes = String.prototype.includes
    ;(window as Window & { unrelatedGoalIncludes?: number }).unrelatedGoalIncludes = 0
    String.prototype.includes = function (searchString: string, position?: number) {
      if (String(this).toLocaleLowerCase() === 'wake up' && searchString === term) {
        ;(window as Window & { unrelatedGoalIncludes?: number }).unrelatedGoalIncludes! += 1
      }
      return originalIncludes.call(this, searchString, position)
    }
  }, matchTerm)

  await targetEditor.fill('prefix ')
  await targetEditor.pressSequentially('ordinary typing')
  await expect.poll(() => unrelatedGoalIncludes(page)).toBe(0)

  await stableTargetRow.getByRole('checkbox', { name: 'Complete item' }).check()
  await page.evaluate(() => {
    ;(window as Window & { unrelatedGoalIncludes?: number }).unrelatedGoalIncludes = 0
  })

  await targetEditor.pressSequentially(matchTerm)
  await expect(stableTargetRow.locator('.plan-goal-badge', { hasText: 'Needle' })).toBeVisible()
  await expect.poll(() => unrelatedGoalIncludes(page)).toBe(1)

  await targetEditor.pressSequentially(' suffix')
  await expect.poll(() => unrelatedGoalIncludes(page)).toBe(1)
})

test('old goal snapshots survive rule edits and archiving, and deletion advises archiving', async ({ page }, testInfo) => {
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await createGoal(page, 'Exercise', 3, 'lift, swim')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  const matchingText = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.plans?.[0]?.items?.find((item: { text: string }) => /lift|swim/i.test(item.text))?.text ?? ''
  })
  await page.getByRole('listitem', { name: `Plan item: ${matchingText}` }).getByRole('checkbox', { name: 'Complete item' }).check()

  const oldDate = addDays(todayISO(), -5)
  await page.evaluate((date) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    state.plans[0].date = date
    state.plans[0].title = 'Old saved day'
    state.activePlanDate = date
    state.goals[0].activityPeriods = [{ startDate: date, endDate: null }]
    state.goalCompletions[0].date = date
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, oldDate)
  await page.reload()

  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  const termsInput = page.getByLabel('Matching terms for Exercise')
  await termsInput.fill('rowing')
  await termsInput.press('Tab')
  await expect
    .poll(async () =>
      page.evaluate((date) => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.goalCompletions?.some((completion: { date: string }) => completion.date === date)
      }, oldDate),
    )
    .toBe(true)

  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(page.getByText('Archived', { exact: true })).toBeVisible()
  await expect(page.getByLabel(`Exercise on ${oldDate}, completed`)).toBeVisible()

  const dialogMessages: string[] = []
  page.on('dialog', async (dialog) => {
    dialogMessages.push(dialog.message())
    await dialog.dismiss()
  })
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => dialogMessages.length).toBe(1)
  expect(dialogMessages[0]).toContain('Archiving it keeps that history visible')
  await expect(page.getByLabel('Goal name: Exercise')).toBeVisible()

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-goals-archived-history.png`,
    fullPage: true,
  })
})

test('a new completion starts a new cadence segment and shortens the prior one', async ({ page }, testInfo) => {
  const firstCompletion = addDays(todayISO(), -6)
  const dayAfterFirst = addDays(firstCompletion, 1)
  const secondCompletion = addDays(firstCompletion, 2)
  const dayAfterSecond = addDays(secondCompletion, 1)

  await page.evaluate(
    ({ firstCompletion, secondCompletion }) => {
      const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
      state.goals = [
        {
          id: 'goal_beats',
          name: 'Make a beat',
          cadenceDays: 3,
          matchTerms: ['beat'],
          hue: 278,
          activityPeriods: [{ startDate: firstCompletion, endDate: null }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]
      state.goalCompletions = [
        {
          goalId: 'goal_beats',
          date: firstCompletion,
          itemIds: ['item_first'],
          matchedTerms: ['beat'],
          computedAt: new Date().toISOString(),
        },
        {
          goalId: 'goal_beats',
          date: secondCompletion,
          itemIds: ['item_second'],
          matchedTerms: ['beat'],
          computedAt: new Date().toISOString(),
        },
      ]
      localStorage.setItem('balance.appState.v1', JSON.stringify(state))
    },
    { firstCompletion, secondCompletion },
  )
  await page.reload()

  await page.getByLabel('Days of goal history').fill('120')
  await page.getByLabel('Days of goal history').press('Tab')
  await expect(page.getByLabel('Days of goal history')).toHaveValue('120')
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem('balance.goalHistoryDays')))
    .toBe('120')

  await expect(page.getByLabel(`Make a beat on ${firstCompletion}, completed`)).toHaveClass(/segment-start/)
  await expect(page.getByLabel(`Make a beat on ${dayAfterFirst}`)).toHaveClass(/segment-end/)
  await expect(page.getByLabel(`Make a beat on ${dayAfterFirst}`)).toHaveClass(/relieved/)
  await expect(page.getByLabel(`Make a beat on ${secondCompletion}, completed`)).toHaveClass(/segment-start/)
  await expect(page.getByLabel(`Make a beat on ${dayAfterSecond}`)).toHaveClass(/relieved/)

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-goal-cadence-segments.png`,
    fullPage: true,
  })
})

async function createGoal(page: import('@playwright/test').Page, name: string, cadenceDays: number, terms: string) {
  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await page.getByLabel('New goal name').fill(name)
  await page.getByLabel('New goal cadence days').fill(String(cadenceDays))
  await page.getByLabel('New goal matching terms').fill(terms)
  await page.getByRole('button', { name: 'Add goal', exact: true }).click()
  await expect(page.getByLabel(`Goal name: ${name}`)).toBeVisible()
}

function todayISO() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00`)
  parsed.setDate(parsed.getDate() + days)
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function unrelatedGoalIncludes(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as Window & { unrelatedGoalIncludes?: number }).unrelatedGoalIncludes ?? -1)
}
