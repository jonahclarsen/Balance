import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('goal colors use a two-dimensional hue and lightness picker', async ({ page }, testInfo) => {
  await createGoal(page, 'Exercise', 3, 'lift, swim')

  const picker = page.getByRole('button', { name: 'Color for Exercise' })
  const bounds = await picker.boundingBox()
  expect(bounds).not.toBeNull()
  await picker.click({
    position: {
      x: bounds!.width * 0.75,
      y: bounds!.height * 0.25,
    },
  })

  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const goal = state.goals?.[0]
        return Math.abs(goal?.hue - 269) <= 3 && Math.abs(goal?.lightness - 75) <= 3
      }),
    )
    .toBe(true)

  const clickedColor = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return { hue: state.goals[0].hue, lightness: state.goals[0].lightness }
  })

  await picker.press('ArrowUp')
  await picker.press('Shift+ArrowLeft')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return { hue: state.goals?.[0]?.hue, lightness: state.goals?.[0]?.lightness }
      }),
    )
    .toEqual({ hue: clickedColor.hue - 10, lightness: clickedColor.lightness + 1 })

  await expect(page.locator('.goal-hue-slider, .goal-lightness-slider')).toHaveCount(0)
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-goal-color-grid.png`,
    fullPage: true,
  })
})

test('goal matching terms preserve rich text and turn a pasted URL into a link', async ({ page }) => {
  await createGoal(page, 'Exercise', 3, 'lift, swim')

  const editor = page.getByRole('textbox', { name: 'Matching terms for Exercise' })
  await editor.evaluate((element) => {
    const text = element.firstChild
    if (!text) throw new Error('Expected matching-term text')

    element.focus()
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 4)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'https://example.com/exercise')
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
  })

  const link = editor.getByRole('link', { name: 'lift' })
  await expect(link).toHaveAttribute('href', 'https://example.com/exercise')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const goal = state.goals?.[0]
        return { matchTerms: goal?.matchTerms, matchTermsHtml: goal?.matchTermsHtml }
      }),
    )
    .toEqual({
      matchTerms: ['lift', 'swim'],
      matchTermsHtml: '<a href="https://example.com/exercise" target="_blank" rel="noreferrer">lift</a>, swim',
    })

  await page.reload()
  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Matching terms for Exercise' }).getByRole('link', { name: 'lift' })).toBeVisible()
})

test('Alt+A toggles goal rhythm without typing and hidden rhythm returns after 60 seconds', async ({ page }) => {
  await page.clock.install()
  const goalRhythm = page.getByRole('region', { name: 'Goal history' })
  const goalSearch = page.getByRole('searchbox', { name: 'Search goals' })

  await expect(goalRhythm).toBeVisible()
  await goalSearch.evaluate((element) => {
    ;(window as typeof window & { goalSearchInputEvents?: number }).goalSearchInputEvents = 0
    element.addEventListener('input', () => {
      const testWindow = window as typeof window & { goalSearchInputEvents?: number }
      testWindow.goalSearchInputEvents = (testWindow.goalSearchInputEvents ?? 0) + 1
    })
  })
  await goalSearch.press('Alt+a')
  expect(
    await page.evaluate(
      () => (window as typeof window & { goalSearchInputEvents?: number }).goalSearchInputEvents,
    ),
  ).toBe(0)
  await expect(goalRhythm).toHaveCount(0)

  await page.clock.fastForward(59_000)
  expect(await goalRhythm.count()).toBe(0)
  await page.clock.fastForward(1_000)
  await expect(goalRhythm).toBeVisible()

  const altLeftAllowed = await goalSearch.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true }),
    ),
  )
  const altRightAllowed = await goalSearch.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }),
    ),
  )
  expect(altLeftAllowed).toBe(true)
  expect(altRightAllowed).toBe(true)

  await page.keyboard.press('Alt+a')
  await expect(goalRhythm).toHaveCount(0)
  await page.keyboard.press('Alt+a')
  await expect(goalRhythm).toBeVisible()
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

test('direct edits to an older plan item can complete an overdue goal', async ({ page }) => {
  const oldDate = addDays(todayISO(), -3)
  const timestamp = new Date().toISOString()

  await page.evaluate(
    ({ oldDate, timestamp }) => {
      const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
      state.activePlanDate = oldDate
      state.plans = [
        {
          id: 'plan_old',
          date: oldDate,
          title: 'Old saved day',
          dailyReminder: '',
          generatedFromTemplateId: null,
          createdAt: timestamp,
          items: [
            {
              id: 'item_old',
              text: 'ordinary task',
              html: 'ordinary task',
              done: false,
              startMinutes: null,
              endMinutes: null,
              children: [],
            },
          ],
        },
      ]
      state.goals = [
        {
          id: 'goal_read',
          name: 'Read',
          cadenceDays: 4,
          matchTerms: ['read'],
          hue: 200,
          activityPeriods: [{ startDate: addDaysInBrowser(oldDate, -4), endDate: null }],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]
      state.goalCompletions = []
      localStorage.setItem('balance.appState.v1', JSON.stringify(state))

      function addDaysInBrowser(date: string, days: number) {
        const parsed = new Date(`${date}T12:00:00`)
        parsed.setDate(parsed.getDate() + days)
        const year = parsed.getFullYear()
        const month = String(parsed.getMonth() + 1).padStart(2, '0')
        const day = String(parsed.getDate()).padStart(2, '0')
        return `${year}-${month}-${day}`
      }
    },
    { oldDate, timestamp },
  )
  await page.reload()

  const row = page.locator('[data-plan-item-id="item_old"]')
  await row.locator('[contenteditable="true"]').fill('read a chapter')
  await row.getByRole('checkbox', { name: 'Complete item' }).check()

  await expect(row.locator('.plan-goal-badge', { hasText: 'Read' })).toBeVisible()
  await expect(row.locator('.plan-due-today')).toHaveCount(0)
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.goalCompletions?.map((completion: { goalId: string; date: string; itemIds: string[] }) => ({
          goalId: completion.goalId,
          date: completion.date,
          itemIds: completion.itemIds,
        }))
      }),
    )
    .toEqual([{ goalId: 'goal_read', date: oldDate, itemIds: ['item_old'] }])
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
  await expect(page.locator(`.goal-day-cell[title="Exercise · ${oldDate} · completed"]`)).toBeVisible()

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

test('a completion resets a rolling deadline and late days stay overdue', async ({ page }, testInfo) => {
  const firstCompletion = addDays(todayISO(), -7)
  const coverageEnd = addDays(firstCompletion, 3)
  const dueDate = addDays(firstCompletion, 4)
  const firstOverdueDate = addDays(firstCompletion, 5)
  const lastOverdueDate = addDays(firstCompletion, 6)
  const secondCompletion = addDays(firstCompletion, 7)

  await page.evaluate(
    ({ firstCompletion, secondCompletion }) => {
      const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
      state.goals = [
        {
          id: 'goal_beats',
          name: 'Make a beat',
          cadenceDays: 4,
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

  await expect(page.locator(`.goal-day-cell[title="Make a beat · ${firstCompletion} · completed"]`)).toHaveClass(/segment-start/)
  await expect(page.locator(`.goal-day-cell[title="Make a beat · ${coverageEnd} · active"]`)).toHaveClass(/segment-end/)
  await expect(page.locator(`.goal-day-cell[title="Make a beat · ${dueDate} · missed"]`)).toHaveClass(/segment-start/)
  await expect(page.locator(`.goal-day-cell[title="Make a beat · ${firstOverdueDate} · overdue"] .overdue-mark`)).toHaveText('×')
  await expect(page.locator(`.goal-day-cell[title="Make a beat · ${lastOverdueDate} · overdue"]`)).toHaveClass(/segment-end/)
  await expect(page.locator(`.goal-day-cell[title="Make a beat · ${secondCompletion} · completed"]`)).toHaveClass(/segment-start/)
  await expect(page.locator('.goal-history-name', { hasText: 'Make a beat' }).locator('.goal-lapse')).toHaveText('4d left')

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-goal-cadence-segments.png`,
    fullPage: true,
  })
})

test('an unmet rolling deadline stays overdue until a completion resets it', async ({ page }) => {
  const start = addDays(todayISO(), -7)
  const deadline = addDays(start, 2)
  const secondStart = addDays(start, 3)
  const lateCompletion = addDays(todayISO(), -2)

  await page.evaluate((start) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const timestamp = new Date().toISOString()
    state.goals = [
      {
        id: 'goal_read',
        name: 'Read',
        cadenceDays: 3,
        matchTerms: ['read'],
        hue: 200,
        activityPeriods: [{ startDate: start, endDate: null }],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]
    state.goalCompletions = []
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, start)
  await page.reload()

  const lapsePill = page.locator('.goal-history-name', { hasText: 'Read' }).locator('.goal-lapse')
  await expect(lapsePill).toHaveText('5d over')
  await expect(lapsePill).toHaveClass(/overdue/)
  await expect(page.locator('.goal-history-toolbar > div > span')).toHaveText('1 upcoming in the next 3 days')

  await expect(page.locator(`.goal-day-cell[title="Read · ${start} · missed"]`)).toHaveClass(/segment-start/)
  await expect(page.locator(`.goal-day-cell[title="Read · ${deadline} · missed"]`)).toBeVisible()
  await expect(page.locator(`.goal-day-cell[title="Read · ${secondStart} · overdue"] .overdue-mark`)).toHaveText('×')
  await expect(page.locator(`.goal-day-cell[title="Read · ${todayISO()} · overdue"]`)).toHaveClass(/segment-end/)

  await expect(page.locator('.goal-date-head.future')).toHaveCount(6)

  await page.evaluate((lateCompletion) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    state.goalCompletions = [
      {
        goalId: 'goal_read',
        date: lateCompletion,
        itemIds: ['item_read'],
        matchedTerms: ['read'],
        computedAt: new Date().toISOString(),
      },
    ]
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, lateCompletion)
  await page.reload()

  await expect(lapsePill).toHaveText('1d left')
  await expect(page.locator(`.goal-day-cell[title="Read · ${deadline} · missed"]`)).toBeVisible()
  await expect(page.locator(`.goal-day-cell[title="Read · ${secondStart} · overdue"]`)).toBeVisible()
  await expect(page.locator(`.goal-day-cell[title="Read · ${addDays(lateCompletion, -1)} · overdue"]`)).toHaveClass(/segment-end/)
  await expect(page.locator(`.goal-day-cell[title="Read · ${lateCompletion} · completed"]`)).toHaveClass(/segment-start/)
  await expect(page.locator(`.goal-day-cell[title="Read · ${todayISO()} · active"]`)).toHaveClass(/segment-end/)
})

test('goal rhythm keeps rounded segment ends when saved activity periods overlap', async ({ page }) => {
  const firstStart = addDays(todayISO(), -8)
  const overlapStart = addDays(todayISO(), -5)
  const firstEnd = addDays(todayISO(), -2)

  await page.evaluate(
    ({ firstStart, overlapStart, firstEnd }) => {
      const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
      const timestamp = new Date().toISOString()
      state.goals = [
        {
          id: 'goal_overlap',
          name: 'Overlapping history',
          cadenceDays: 3,
          matchTerms: ['overlap'],
          hue: 160,
          activityPeriods: [
            { startDate: firstStart, endDate: firstEnd },
            { startDate: overlapStart, endDate: null },
          ],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]
      state.goalCompletions = []
      localStorage.setItem('balance.appState.v1', JSON.stringify(state))
    },
    { firstStart, overlapStart, firstEnd },
  )
  await page.reload()

  const overlapBoundary = page.locator(`.goal-day-cell[title="Overlapping history · ${overlapStart} · overdue"]`)
  await expect(overlapBoundary).not.toHaveClass(/segment-start/)

  const currentEnd = page.locator(`.goal-day-cell[title="Overlapping history · ${todayISO()} · overdue"]`)
  await expect(currentEnd).toHaveClass(/segment-end/)
  await expect(currentEnd).toHaveCSS('border-bottom-right-radius', '999px')
})

test('goals put daily intervals first, then order by days until lapse and shortest interval', async ({ page }) => {
  const today = todayISO()
  const threeDaysAgo = addDays(today, -3)
  const yesterday = addDays(today, -1)

  await page.evaluate(
    ({ today, threeDaysAgo, yesterday }) => {
      const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
      const timestamp = new Date().toISOString()
      state.goals = [
        {
          id: 'goal_long_tie',
          name: 'Long tie',
          cadenceDays: 7,
          matchTerms: ['long'],
          hue: 120,
          activityPeriods: [{ startDate: threeDaysAgo, endDate: null }],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: 'goal_short_tie',
          name: 'Short tie',
          cadenceDays: 4,
          matchTerms: ['short'],
          hue: 80,
          activityPeriods: [{ startDate: today, endDate: null }],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: 'goal_sooner',
          name: 'Sooner',
          cadenceDays: 2,
          matchTerms: ['soon'],
          hue: 0,
          activityPeriods: [{ startDate: yesterday, endDate: null }],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: 'goal_archived_daily',
          name: 'Archived daily',
          cadenceDays: 1,
          matchTerms: ['daily'],
          hue: 40,
          activityPeriods: [{ startDate: yesterday, endDate: yesterday }],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]
      state.goalCompletions = []
      localStorage.setItem('balance.appState.v1', JSON.stringify(state))
    },
    { today, threeDaysAgo, yesterday },
  )
  await page.reload()

  await expect(page.locator('.goal-history-name span:not(.goal-color-dot)').allTextContents()).resolves.toEqual([
    'Archived daily',
    'Sooner',
    'Short tie',
    'Long tie',
  ])

  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await expect(
    page.locator('.goal-card .goal-name-input').evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value),
    ),
  ).resolves.toEqual(['Archived daily', 'Sooner', 'Short tie', 'Long tie'])
})

test('goal rhythm counts goals becoming overdue from the viewed day through the next three days', async ({ page }) => {
  const today = todayISO()
  const yesterday = addDays(today, -1)

  await page.evaluate(({ today, yesterday }) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const timestamp = new Date().toISOString()
    state.goals = [
      {
        id: 'goal_daily',
        name: 'Daily goal',
        cadenceDays: 1,
        matchTerms: ['daily'],
        hue: 0,
        activityPeriods: [{ startDate: yesterday, endDate: null }],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 'goal_today',
        name: 'Due today',
        cadenceDays: 1,
        matchTerms: ['today'],
        hue: 40,
        activityPeriods: [{ startDate: today, endDate: null }],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 'goal_three_days',
        name: 'Due in three days',
        cadenceDays: 4,
        matchTerms: ['soon'],
        hue: 80,
        activityPeriods: [{ startDate: today, endDate: null }],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 'goal_four_days',
        name: 'Due in four days',
        cadenceDays: 5,
        matchTerms: ['later'],
        hue: 120,
        activityPeriods: [{ startDate: today, endDate: null }],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]
    state.goalCompletions = []
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, { today, yesterday })
  await page.reload()

  const upcomingSummary = page.locator('.goal-history-toolbar > div > span')
  await expect(upcomingSummary).toHaveText('3 upcoming in the next 3 days')

  await page.getByRole('button', { name: 'Previous day' }).click()

  await expect(upcomingSummary).toHaveText('1 upcoming in the next 3 days')
})

test('n goals template items use goal names instead of matching terms', async ({ page }) => {
  const today = todayISO()

  await page.evaluate((today) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const timestamp = new Date().toISOString()
    state.templates[0].items = [
      {
        id: 'template_item_goals',
        startMinutes: null,
        endMinutes: null,
        options: [{ id: 'option_goals', text: '1 goals', html: '1 goals', probability: 100 }],
        children: [],
      },
    ]
    state.goals = [
      {
        id: 'goal_music',
        name: 'Write music',
        cadenceDays: 3,
        matchTerms: ['beat'],
        hue: 278,
        activityPeriods: [{ startDate: today, endDate: null }],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, today)
  await page.reload()

  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await expect(page.getByRole('listitem', { name: 'Plan item: Write music' })).toBeVisible()
  await expect(page.getByRole('listitem', { name: 'Plan item: beat' })).toHaveCount(0)
})

test('goal rhythm hover text includes match keywords', async ({ page }) => {
  await createGoal(page, 'Exercise', 3, 'lift, swim')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  await expect(page.locator('.goal-history-name', { hasText: 'Exercise' })).toHaveAttribute(
    'title',
    'Exercise: every 3 days\n2 days left before default\nMatch keywords: lift, swim',
  )
})

test('goal rhythm bolds the current day and keeps it bold when another day is selected', async ({ page }) => {
  await createGoal(page, 'Exercise', 3, 'lift, swim')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  // The current day owns the `today` class and bold text, regardless of which
  // day is selected.
  const todayHead = page.locator('.goal-date-head.today')
  await expect(todayHead).toHaveCount(1)
  await expect(todayHead).toHaveClass(/viewed/)
  await expect(todayHead.locator('strong')).toHaveCSS('font-weight', '700')

  const todayTitle = (await todayHead.getAttribute('title')) ?? todayISO()
  const tomorrow = addDays(todayTitle, 1)

  await page.getByRole('button', { name: 'Next day' }).click()

  const tomorrowHead = page.locator(`.goal-date-head[title="${tomorrow}"]`)
  await expect(tomorrowHead).toHaveClass(/viewed/)
  await expect(tomorrowHead).not.toHaveClass(/today/)
  await expect(tomorrowHead.locator('strong')).toHaveCSS('font-weight', '600')
  await expect(page.locator(`.goal-day-cell[title*="${tomorrow}"]`)).toHaveClass(/viewed/)

  // Selecting another day moves the highlight but not the bold current-day mark.
  await expect(todayHead).not.toHaveClass(/viewed/)
  await expect(todayHead).toHaveClass(/today/)
  await expect(todayHead.locator('strong')).toHaveCSS('font-weight', '700')
})

test('goal rhythm grows a column for the new day after the clock rolls over', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-06-16T12:00:00') })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await createGoal(page, 'Exercise', 1, 'lift, swim')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  await expect(page.locator('.goal-date-head[title="2026-06-16"]')).toHaveCount(1)
  await expect(page.locator('.goal-date-head[title="2026-06-17"]').first()).toHaveClass(/future/)

  // The day rolls over while the app stays open. Without a reactive clock the
  // date list would stay anchored to the previous day until an input like the
  // Days slider forces a recompute.
  await page.clock.setFixedTime(new Date('2026-06-17T12:00:00'))
  await page.clock.runFor(61_000)

  await expect(page.locator('.goal-date-head[title="2026-06-17"]').first()).not.toHaveClass(/future/)
  await expect(page.locator('.goal-date-head[title="2026-06-17"].today')).toHaveCount(1)
})

test('clicking a plan item goal badge reveals that goal in the rhythm panel', async ({ page }) => {
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

  const badge = row.locator('.plan-goal-badge', { hasText: 'Exercise' })
  await expect(badge).toBeVisible()

  const goalRow = page.locator('.goal-history-name[data-goal-id]', { hasText: 'Exercise' })
  await expect(goalRow).toHaveCount(1)
  await expect(goalRow).not.toHaveClass(/goal-row-focus/)

  await badge.click()
  await expect(goalRow).toHaveClass(/goal-row-focus/)
})

test('clicking a goal rhythm row scrolls to that goal on the goals page', async ({ page }) => {
  const targetGoal = 'Goal 18'

  for (let index = 1; index <= 28; index += 1) {
    await createGoal(page, `Goal ${index}`, 1, `goal-${index}`)
  }

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  const targetRow = page.locator('.goal-history-name[data-goal-id]', { hasText: targetGoal })
  const targetCard = page.locator('.goal-card', { has: page.getByLabel(`Goal name: ${targetGoal}`) })

  await targetRow.click()
  await expect(page.getByRole('button', { name: 'Goals', exact: true })).toHaveClass(/active/)
  await expect(targetCard).toHaveClass(/goal-card-focus/)
  await expect.poll(() => goalCardCenterOffset(page, targetGoal)).toBeLessThanOrEqual(1)

  await resetActiveScrollTop(page)
  await targetRow.click()
  await expect(targetCard).toHaveClass(/goal-card-focus/)
  await expect.poll(() => goalCardCenterOffset(page, targetGoal)).toBeLessThanOrEqual(1)
})

test('goal rhythm copy button copies the goal name without opening the row', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5174' })
  await createGoal(page, 'Exercise', 3, 'lift, swim')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  const row = page.locator('.goal-history-name[data-goal-id]', { hasText: 'Exercise' })
  const copyButton = row.getByRole('button', { name: 'Copy Exercise' })
  await expect(copyButton.locator('svg')).toBeVisible()

  const buttonIsLeftOfCadence = await row.evaluate((element) => {
    const button = element.querySelector<HTMLElement>('.goal-copy-button')
    const cadence = Array.from(element.querySelectorAll('small')).find((small) => small.textContent === '3d')
    if (!button || !cadence) return false
    return button.getBoundingClientRect().right <= cadence.getBoundingClientRect().left
  })
  expect(buttonIsLeftOfCadence).toBe(true)

  await copyButton.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Exercise')
  await expect(copyButton).toHaveAttribute('title', 'Copied goal name')
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveClass(/active/)

  await row.click()
  await expect(page.getByRole('button', { name: 'Goals', exact: true })).toHaveClass(/active/)
})

test('goal rhythm uses dark segment and open-circle colors in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await createGoal(page, 'Exercise', 3, 'lift, swim')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  const activeCell = page.locator('.goal-day-cell.active').first()
  await expect(activeCell).toBeVisible()
  await expect(activeCell).toHaveCSS('background-color', 'rgb(23, 79, 65)')
  await expect(activeCell.locator('.goal-cell-mark.open')).toHaveCSS('border-color', 'rgba(58, 136, 116, 0.7)')
})

test('gray controls toggle without being obscured and goal cards omit frozen-history text', async ({ page }) => {
  await page.getByRole('button', { name: 'Goals', exact: true }).click()

  const newGoalGray = page.getByRole('button', { name: 'Make this goal gray' })
  await newGoalGray.click()
  await expect(newGoalGray).toHaveAttribute('aria-pressed', 'true')
  await newGoalGray.click()
  await expect(newGoalGray).toHaveAttribute('aria-pressed', 'false')

  await createGoal(page, 'Exercise', 3, 'lift, swim')
  const goalGray = page.getByRole('button', { name: 'Make Exercise gray' })
  await goalGray.click()
  await expect(goalGray).toHaveAttribute('aria-pressed', 'true')
  await goalGray.click()
  await expect(goalGray).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.goal-card-meta')).toHaveText('0 saved completions')
  await expect(page.getByText(/history before .* is frozen/i)).toHaveCount(0)
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

async function resetActiveScrollTop(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>('.workspace')
    if (workspace && workspace.scrollHeight > workspace.clientHeight) {
      workspace.scrollTop = 0
      return
    }
    window.scrollTo({ top: 0 })
  })
}

async function goalCardCenterOffset(page: import('@playwright/test').Page, goalName: string) {
  return page.evaluate((name) => {
    const workspace = document.querySelector<HTMLElement>('.workspace')
    const card = [...document.querySelectorAll<HTMLElement>('.goal-card')].find((candidate) =>
      candidate.querySelector<HTMLInputElement>('.goal-name-input')?.value === name,
    )
    if (!workspace || !card) return null
    const workspaceScrolls = workspace.scrollHeight > workspace.clientHeight
    const containerTop = workspaceScrolls ? workspace.getBoundingClientRect().top : 0
    const containerHeight = workspaceScrolls ? workspace.clientHeight : window.innerHeight
    const cardRect = card.getBoundingClientRect()
    const cardCenter = cardRect.top + cardRect.height / 2
    return Math.abs(Math.round(cardCenter - (containerTop + containerHeight / 2)))
  }, goalName)
}
