import { expect, test } from '@playwright/test'

const playwrightOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '5123'}`

async function selectDeviceThemeForTest(page: import('@playwright/test').Page, themeId: string) {
  await page.evaluate((selectedThemeId) => localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({
    version: 1,
    themeId: selectedThemeId,
    randomThemeStartDate: '',
    doneTintColor: '',
    checkboxColor: '',
  })), themeId)
  await page.reload()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('goals warn when their inserted name does not match any configured term', async ({ page }) => {
  await page.getByRole('button', { name: 'Manage goals' }).click()
  const warning = page.getByText('Goal name doesn’t match any term, so its inserted item won’t match.')
  const newTerms = page.getByLabel('New goal matching terms')

  await page.getByLabel('New goal name').fill('Write music')
  await newTerms.fill('beat')
  await expect(warning).toBeVisible()
  await expect(newTerms).toHaveClass(/goal-rules-editor-mismatch/)

  await newTerms.fill('music, beat')
  await expect(warning).toHaveCount(0)
  await page.getByRole('button', { name: 'Add goal', exact: true }).click()

  const savedTerms = page.getByLabel('Matching terms for Write music')
  await savedTerms.fill('beat')
  await expect(warning).toBeVisible()
  await expect(savedTerms).toHaveClass(/goal-rules-editor-mismatch/)

  await page.getByLabel('Goal name: Write music').fill('Write beat')
  await expect(warning).toHaveCount(0)
})

test('a new goal receives the color previewed by the add button and has no color editor', async ({ page }) => {
  await page.getByRole('button', { name: 'Manage goals' }).click()
  const addButton = page.getByRole('button', { name: 'Add goal', exact: true })
  const previewHue = await addButton.evaluate((button) =>
    Number(getComputedStyle(button).getPropertyValue('--goal-hue')),
  )
  const previewColor = await addButton.evaluate((button) => getComputedStyle(button).backgroundColor)

  await createGoal(page, 'Exercise', 3, 'lift, swim')

  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return { hue: state.goals[0].hue, lightness: state.goals[0].lightness }
  })).toEqual({ hue: previewHue, lightness: 50 })
  await expect(page.locator('.goal-card-accent')).toHaveCSS('background-color', previewColor)
  await expect(page.getByLabel('New goal color')).toHaveCount(0)
  await expect(page.getByLabel('Color for Exercise')).toHaveCount(0)

  const nextHue = await addButton.evaluate((button) =>
    Number(getComputedStyle(button).getPropertyValue('--goal-hue')),
  )
  expect(nextHue).not.toBe(previewHue)
})

test('the mobile goal search stays compact without goal color controls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile-only interaction')
  await page.setViewportSize({ width: 360, height: 760 })
  await createGoal(page, 'Exercise', 3, 'lift, swim')

  const search = page.locator('.goal-search-input')
  expect((await search.boundingBox())?.height).toBeLessThanOrEqual(44)
  await expect(page.getByLabel('Color for Exercise')).toHaveCount(0)
})

test('the goal rhythm search clear button remains visible without focus on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile-only interaction')

  const search = page.getByRole('searchbox', { name: 'Search goals' })
  const clearSearch = page.getByRole('button', { name: 'Clear goal search' })

  await search.fill('exercise')
  await search.blur()
  await expect(clearSearch).toBeVisible()

  await clearSearch.click()
  await expect(search).toHaveValue('')
  await expect(clearSearch).toHaveCount(0)
})

test('goal rhythm offers nine persistent visual modes with one highlighted selection', async ({ page }) => {
  const rhythm = page.getByRole('region', { name: 'Goal history' })
  const modeTrigger = page.getByRole('button', { name: 'Choose Goal Rhythm style' })
  const modeMenu = page.getByRole('menu', { name: 'Goal Rhythm style options' })

  await expect(modeMenu).toBeHidden()
  await expect(rhythm).toHaveAttribute('data-rhythm-mode', 'flow')

  await modeTrigger.hover({ force: true })
  await expect(modeMenu).toBeVisible()
  await expect(page.getByRole('menuitemradio')).toHaveCount(9)
  for (const mode of [
    'Flow',
    'Flow Tint',
    'Flow Halo',
    'Mosaic',
    'Columns',
    'Signal',
    'Ledger',
    'Aurora',
    'Constellation',
  ]) {
    await expect(page.getByRole('menuitemradio', { name: mode, exact: true })).toHaveCount(1)
  }
  await expect(page.getByRole('menuitemradio', { name: 'Flow Dots', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitemradio', { name: 'Flow Tide', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitemradio', { name: 'Flow Line', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitemradio', { name: 'Flow Ghost', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitemradio', { name: 'Flow Orbit', exact: true })).toHaveCount(0)

  const storedModeBeforePreview = await page.evaluate(() => localStorage.getItem('balance.goalRhythmMode.v1'))
  const flowOption = page.getByRole('menuitemradio', { name: 'Flow', exact: true })
  const mosaicOption = page.getByRole('menuitemradio', { name: 'Mosaic' })
  await mosaicOption.hover()
  await expect(rhythm).toHaveAttribute('data-rhythm-mode', 'mosaic')
  await expect(flowOption).toHaveAttribute('aria-checked', 'true')
  await expect(mosaicOption).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => localStorage.getItem('balance.goalRhythmMode.v1'))).toBe(storedModeBeforePreview)

  await page.mouse.move(1, 1)
  await expect(rhythm).toHaveAttribute('data-rhythm-mode', 'flow')
  await modeTrigger.hover({ force: true })
  await expect(modeMenu).toBeVisible()

  const selectedRowAlignment = async (name: string) => {
    const [triggerBox, optionBox] = await Promise.all([
      modeTrigger.boundingBox(),
      page.getByRole('menuitemradio', { name, exact: true }).boundingBox(),
    ])
    if (!triggerBox || !optionBox) return null
    const triggerCenterX = triggerBox.x + triggerBox.width / 2
    const optionCenterX = optionBox.x + optionBox.width / 2
    const centerDelta = optionBox.y + optionBox.height / 2 - (triggerBox.y + triggerBox.height / 2)
    return {
      centersAlign: Math.abs(centerDelta) <= 1,
      horizontalCentersAlign: Math.abs(optionCenterX - triggerCenterX) <= 1,
    }
  }

  const highlightedOptions = () => page.getByRole('menuitemradio').evaluateAll((options) => options
    .filter((option) => getComputedStyle(option).backgroundColor !== 'rgba(0, 0, 0, 0)')
    .map((option) => option.textContent?.trim().replace(/^\S+\s+/, '')),
  )

  expect(await selectedRowAlignment('Flow')).toEqual({ centersAlign: true, horizontalCentersAlign: true })
  await page.getByRole('menuitemradio', { name: 'Flow Tint', exact: true }).click()
  await expect(rhythm).toHaveAttribute('data-rhythm-mode', 'flow-tint')
  expect(await highlightedOptions()).toEqual(['Flow Tint'])
  await page.getByRole('menuitemradio', { name: 'Flow Halo', exact: true }).click()
  await expect(rhythm).toHaveAttribute('data-rhythm-mode', 'flow-halo')
  expect(await highlightedOptions()).toEqual(['Flow Halo'])
  await expect.poll(() => page.evaluate(() => localStorage.getItem('balance.goalRhythmMode.v1'))).toBe('flow-halo')
  await page.getByRole('menuitemradio', { name: 'Mosaic' }).click()
  expect(await highlightedOptions()).toEqual(['Mosaic'])
  await page.getByRole('menuitemradio', { name: 'Columns' }).click()
  await expect(rhythm).toHaveAttribute('data-rhythm-mode', 'columns')
  expect(await highlightedOptions()).toEqual(['Columns'])
  await page.getByRole('menuitemradio', { name: 'Signal' }).click()
  await expect(rhythm).toHaveAttribute('data-rhythm-mode', 'signal')
  expect(await highlightedOptions()).toEqual(['Signal'])
  await expect.poll(() => page.evaluate(() => localStorage.getItem('balance.goalRhythmMode.v1'))).toBe('signal')

  await page.reload()
  await expect(rhythm).toHaveAttribute('data-rhythm-mode', 'signal')
  await modeTrigger.hover({ force: true })
  await expect(modeMenu).toBeVisible()
  expect(await selectedRowAlignment('Signal')).toEqual({ centersAlign: true, horizontalCentersAlign: true })

  const auroraOption = page.getByRole('menuitemradio', { name: 'Aurora' })
  await auroraOption.hover()
  await expect(rhythm).toHaveAttribute('data-rhythm-mode', 'aurora')
  await expect(page.getByRole('menuitemradio', { name: 'Signal' })).toHaveAttribute('aria-checked', 'true')
  await expect(auroraOption).toHaveAttribute('aria-checked', 'false')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('balance.goalRhythmMode.v1'))).toBe('signal')

  await page.mouse.move(1, 1)
  await expect(rhythm).toHaveAttribute('data-rhythm-mode', 'signal')
})

test('active and retired flow variants preserve the cadence band with a safe future fallback', async ({ page }) => {
  const historyStart = addDays(todayISO(), -6)
  await page.evaluate((historyStart) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const timestamp = new Date().toISOString()
    state.goals = [{
      id: 'goal_flow_patterns',
      name: 'Flow patterns',
      cadenceDays: 2,
      matchTerms: ['flow'],
      hue: 205,
      activityPeriods: [{ startDate: historyStart, endDate: null }],
      createdAt: timestamp,
      updatedAt: timestamp,
    }]
    state.goalCompletions = []
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, historyStart)
  await page.reload()

  const appearances = await page.evaluate(() => {
    const rhythm = document.querySelector<HTMLElement>('.goal-history-panel')
    const activeCell = document.querySelector<HTMLElement>('.goal-day-cell.active:not(.overdue)')
    const overdueCell = document.querySelector<HTMLElement>('.goal-day-cell.overdue')
    if (!rhythm || !activeCell || !overdueCell) throw new Error('Could not find Flow pattern cells')

    return ['flow', 'flow-tint', 'flow-halo', 'flow-ghost', 'flow-orbit', 'flow-line', 'flow-dots', 'flow-tide', 'future-flow'].map((mode) => {
      rhythm.dataset.rhythmMode = mode
      return {
        mode,
        activeBackground: getComputedStyle(activeCell).backgroundImage,
        activeBackgroundColor: getComputedStyle(activeCell).backgroundColor,
        overdueOverlay: getComputedStyle(overdueCell, '::before').backgroundImage,
        overdueOverlayColor: getComputedStyle(overdueCell, '::before').backgroundColor,
      }
    })
  })

  expect(appearances.map(({ activeBackground }) => activeBackground)).toEqual([
    appearances[0].activeBackground,
    appearances[0].activeBackground,
    appearances[0].activeBackground,
    appearances[0].activeBackground,
    appearances[0].activeBackground,
    appearances[0].activeBackground,
    appearances[0].activeBackground,
    appearances[0].activeBackground,
    'none',
  ])
  expect(appearances[0].overdueOverlay).toContain('repeating-linear-gradient')
  expect(appearances[1].overdueOverlay).toBe('none')
  expect(appearances[2].overdueOverlay).toContain('radial-gradient')
  expect(appearances[3].overdueOverlay).toBe('none')
  expect(appearances[3].overdueOverlayColor).not.toBe(appearances[1].overdueOverlayColor)
  expect(appearances[4].overdueOverlay).toContain('radial-gradient')
  expect(appearances[5].overdueOverlay).toContain('linear-gradient(to top')
  expect(appearances[6].overdueOverlay).toContain('radial-gradient')
  expect(appearances[7].overdueOverlay).toContain('linear-gradient(to top')
  expect(appearances[8].overdueOverlay).toContain('repeating-linear-gradient')
  expect(appearances[8].activeBackgroundColor).not.toBe('rgba(0, 0, 0, 0)')
})

test('retired and unknown saved rhythm modes fall back to Flow without rewriting the saved ID', async ({ page }) => {
  const rhythm = page.getByRole('region', { name: 'Goal history' })

  for (const storedMode of ['flow-line', 'flow-dots', 'flow-tide', 'flow-ghost', 'flow-orbit', 'future-flow']) {
    await page.evaluate((mode) => localStorage.setItem('balance.goalRhythmMode.v1', mode), storedMode)
    await page.reload()
    await expect(rhythm).toHaveAttribute('data-rhythm-mode', 'flow')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('balance.goalRhythmMode.v1'))).toBe(storedMode)
  }
})

test('columns mode joins mosaic tiles vertically by calendar day', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop geometry provides stable pixel measurements')
  await createGoal(page, 'Exercise', 3, 'exercise')
  await createGoal(page, 'Read', 2, 'read')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  const modeTrigger = page.getByRole('button', { name: 'Choose Goal Rhythm style' })
  const todayCells = page.locator(`.goal-day-cell[title*=" · ${todayISO()} · "]`)
  await expect(todayCells).toHaveCount(2)

  const verticalGap = () => todayCells.evaluateAll((cells) => {
    const rectangles = cells
      .map((cell) => cell.getBoundingClientRect())
      .sort((left, right) => left.top - right.top)
    return Math.round(rectangles[1].top - rectangles[0].bottom)
  })

  await modeTrigger.hover({ force: true })
  await page.getByRole('menuitemradio', { name: 'Mosaic' }).click()
  expect(await verticalGap()).toBe(6)

  await page.mouse.move(1, 1)
  await modeTrigger.hover({ force: true })
  await page.getByRole('menuitemradio', { name: 'Columns' }).click()
  expect(await verticalGap()).toBe(0)
  await expect.poll(() => todayCells.evaluateAll((cells) => cells.map((cell) => {
    const style = getComputedStyle(cell)
    return { width: style.width, height: style.height }
  }))).toEqual([
    { width: '24px', height: '30px' },
    { width: '24px', height: '30px' },
  ])
})

test('goal rhythm modes allocate the mobile split to match their visual focus', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile-only layout treatment')
  await page.setViewportSize({ width: 360, height: 760 })

  const modeTrigger = page.getByRole('button', { name: 'Choose Goal Rhythm style' })
  const namePane = page.locator('.goal-history-name-pane')

  await modeTrigger.hover({ force: true })
  await page.getByRole('menuitemradio', { name: 'Signal' }).click()
  const signalWidth = (await namePane.boundingBox())?.width ?? 0
  await page.mouse.move(1, 1)
  await modeTrigger.hover({ force: true })
  await page.getByRole('menuitemradio', { name: 'Ledger' }).click()
  const ledgerWidth = (await namePane.boundingBox())?.width ?? 0

  expect(signalWidth).toBeGreaterThan(0)
  expect(ledgerWidth - signalWidth).toBeGreaterThanOrEqual(70)
})

test('goal cards show completion history for the most recent 14 days', async ({ page }, testInfo) => {
  const currentDate = todayISO()
  const timestamp = new Date().toISOString()
  const completionDates = [addDays(currentDate, -10), addDays(currentDate, -4), currentDate]

  await page.evaluate(
    ({ currentDate, timestamp, completionDates }) => {
      const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
      state.goals = [{
        id: 'goal_recent_history',
        name: 'Exercise',
        nameHtml: 'Exercise',
        cadenceDays: 3,
        matchTerms: ['exercise'],
        matchTermsHtml: 'exercise',
        hue: 165,
        lightness: 50,
        activityPeriods: [{ startDate: addDaysInBrowser(currentDate, -20), endDate: null }],
        createdAt: timestamp,
        updatedAt: timestamp,
      }]
      state.goalCompletions = completionDates.map((date) => ({
        goalId: 'goal_recent_history',
        date,
        itemIds: [`item_${date}`],
        matchedTerms: ['exercise'],
        computedAt: timestamp,
      }))
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
    { currentDate, timestamp, completionDates },
  )
  await page.reload()
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page
      .getByRole('complementary', { name: 'Primary navigation drawer' })
      .getByRole('button', { name: 'Goals', exact: true })
      .click()
  } else {
    await page.getByRole('button', { name: 'Goals', exact: true }).click()
  }

  const history = page.getByRole('region', {
    name: 'Recent 14-day history for Exercise: 3 completions',
  })
  const days = history.locator('.goal-recent-day')
  await expect(history).toBeVisible()
  await expect(days).toHaveCount(14)
  await expect(days.locator('.goal-recent-day-tooltip')).toHaveCount(14)
  await expect(days.first()).toHaveAttribute('data-goal-date', addDays(currentDate, -13))
  await expect(days.last()).toHaveAttribute('data-goal-date', currentDate)
  for (const date of completionDates) {
    await expect(history.locator(`[data-goal-date="${date}"]`)).toHaveClass(/completed/)
  }
  const deadlineDay = history.locator(`[data-goal-date="${addDays(currentDate, -7)}"]`)
  await expect(deadlineDay).toHaveClass(/overdue/)
  await expect(deadlineDay.locator('.goal-cell-mark.overdue-mark')).toHaveText('×')
  const overdueDay = history.locator(`[data-goal-date="${addDays(currentDate, -6)}"]`)
  await expect(overdueDay).toHaveClass(/overdue/)
  await expect(overdueDay.locator('.goal-cell-mark.overdue-mark')).toHaveText('×')
  await expect(history.locator(`[data-goal-date="${currentDate}"]`)).toHaveClass(/today/)
  const historyBox = await history.boundingBox()
  const rulesBox = await page.getByLabel('Matching terms for Exercise').boundingBox()
  const savedCompletionBox = await page.locator('.goal-card-meta').boundingBox()
  const footerBox = await page.locator('.goal-card-footer').boundingBox()
  expect(historyBox).not.toBeNull()
  expect(rulesBox).not.toBeNull()
  expect(savedCompletionBox).not.toBeNull()
  expect(footerBox).not.toBeNull()
  expect(Math.abs(savedCompletionBox!.x - footerBox!.x)).toBeLessThanOrEqual(2)
  if (testInfo.project.name === 'desktop') {
    expect(historyBox!.x).toBeGreaterThan(rulesBox!.x + rulesBox!.width)
    const rulesBottom = rulesBox!.y + rulesBox!.height
    const historyBottom = historyBox!.y + historyBox!.height
    expect(Math.abs(historyBottom - rulesBottom)).toBeLessThanOrEqual(2)
  } else {
    expect(historyBox!.y).toBeGreaterThan(rulesBox!.y + rulesBox!.height)
  }
  expect(savedCompletionBox!.y).toBeGreaterThan(historyBox!.y + historyBox!.height)
  const targetDate = addDays(currentDate, -4)
  const targetDay = history.locator(`[data-goal-date="${targetDate}"]`)
  await targetDay.hover()
  await expect(targetDay.locator('.goal-recent-day-tooltip')).toBeVisible()
  await expect(targetDay).toHaveAttribute('aria-label', /Open .+ in Today view: completed/)
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-goal-recent-history.png`,
    fullPage: true,
  })
  await targetDay.click()
  await expect(page.getByLabel('Day date')).toHaveValue(targetDate)
  await expect(history).toHaveCount(0)
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

test('goal urgency order updates on the next Goals page visit', async ({ page }) => {
  const currentDate = todayISO()
  const timestamp = new Date().toISOString()

  await page.evaluate(
    ({ currentDate, timestamp }) => {
      const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
      state.plans = [
        {
          id: 'plan_today',
          date: currentDate,
          title: 'Today',
          dailyReminder: '',
          generatedFromTemplateId: null,
          createdAt: timestamp,
          items: [
            {
              id: 'item_alpha',
              text: 'alpha',
              html: 'alpha',
              done: true,
              startMinutes: null,
              endMinutes: null,
              children: [],
            },
          ],
        },
      ]
      state.goals = [
        {
          id: 'goal_edit',
          name: 'Edit me',
          nameHtml: 'Edit me',
          cadenceDays: 3,
          matchTerms: ['alpha'],
          matchTermsHtml: 'alpha',
          hue: 180,
          lightness: 50,
          activityPeriods: [{ startDate: currentDate, endDate: null }],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: 'goal_other',
          name: 'Other goal',
          nameHtml: 'Other goal',
          cadenceDays: 3,
          matchTerms: ['other'],
          matchTermsHtml: 'other',
          hue: 240,
          lightness: 50,
          activityPeriods: [{ startDate: currentDate, endDate: null }],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]
      state.goalCompletions = [
        {
          goalId: 'goal_edit',
          date: currentDate,
          itemIds: ['item_alpha'],
          matchedTerms: ['alpha'],
          computedAt: timestamp,
        },
      ]
      localStorage.setItem('balance.appState.v1', JSON.stringify(state))
    },
    { currentDate, timestamp },
  )
  await page.reload()
  await navigateTo(page, 'Goals')

  const cards = page.locator('.goal-card')
  const goalCardOrder = () => cards.evaluateAll((elements) => elements.map((element) => element.dataset.goalId))
  await expect.poll(goalCardOrder).toEqual(['goal_other', 'goal_edit'])

  const editor = page.getByRole('textbox', { name: 'Matching terms for Edit me' })
  await editor.fill('beta')

  await expect(editor).toBeFocused()
  await expect.poll(goalCardOrder).toEqual(['goal_other', 'goal_edit'])

  await editor.press('Tab')
  await expect.poll(goalCardOrder).toEqual(['goal_other', 'goal_edit'])

  await navigateTo(page, 'Today')
  await navigateTo(page, 'Goals')
  await expect.poll(goalCardOrder).toEqual(['goal_edit', 'goal_other'])
})

test('goal names preserve rich text and turn a pasted URL into a link', async ({ page }) => {
  await createGoal(page, 'Exercise daily', 3, 'lift, swim')

  const editor = page.getByRole('textbox', { name: 'Goal name: Exercise daily' })
  await editor.evaluate((element) => {
    const text = element.firstChild
    if (!text) throw new Error('Expected goal-name text')

    element.focus()
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 8)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'https://example.com/exercise')
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
  })

  const link = editor.getByRole('link', { name: 'Exercise' })
  await expect(link).toHaveAttribute('href', 'https://example.com/exercise')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const goal = state.goals?.[0]
        return { name: goal?.name, nameHtml: goal?.nameHtml }
      }),
    )
    .toEqual({
      name: 'Exercise daily',
      nameHtml: '<a href="https://example.com/exercise" target="_blank" rel="noreferrer">Exercise</a> daily',
    })

  await page.reload()
  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Goal name: Exercise daily' }).getByRole('link', { name: 'Exercise' })).toBeVisible()
})

test('goal rhythm catches up after live goal-name editing pauses', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop goal-form navigation is covered here')
  await createGoal(page, 'Exercise', 3, 'lift, swim')

  await page.getByRole('textbox', { name: 'Goal name: Exercise' }).fill('Daily exercise')

  const rhythm = page.getByRole('region', { name: 'Goal history' })
  await expect(rhythm.locator('.goal-history-name', { hasText: 'Daily exercise' })).toBeVisible({ timeout: 8_000 })
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

test('clicking a goal rhythm date opens that day in Today view', async ({ page }) => {
  const selectedDate = await page.locator('.date-input').inputValue()
  const targetDate = addDays(selectedDate, 2)

  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await page.locator(`[data-goal-date="${targetDate}"]`).click()

  await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveClass(/active/)
  await expect(page.locator('.date-input')).toHaveValue(targetDate)
})

test('a matching plan item previews its goal, then shows completion when checked', async ({ page }, testInfo) => {
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await createGoal(page, 'Exercise', 1, 'lift, swim')

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  const matchingText = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.plans?.[0]?.items?.find((item: { text: string }) => /lift|swim/i.test(item.text))?.text ?? ''
  })
  expect(matchingText).not.toBe('')

  const row = page.getByRole('listitem', { name: `Plan item: ${matchingText}` })
  const goalBadge = row.locator('.plan-goal-badge', { hasText: 'Exercise' })
  await expect(goalBadge).toBeVisible()
  await expect(goalBadge.locator('span')).toHaveCount(0)

  await row.getByRole('checkbox', { name: 'Complete item' }).check()

  await expect(goalBadge.locator('span')).toHaveText('✓')
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
        return payload?.entityChanges?.upserts?.filter(
          (upsert: { collection: string }) => upsert.collection === 'goalCompletions',
        ).length ?? -1
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
  await expect(goalBadge).toBeVisible()
  await expect(goalBadge.locator('span')).toHaveCount(0)
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.goalCompletions?.length ?? -1
      }),
    )
    .toBe(0)
})

test('a not-yet-due goal previews when its single-word term matches at a word boundary', async ({ page }) => {
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await createGoal(page, 'DJ practice', 7, 'dj')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  const row = page.locator('[data-plan-item-id]').first()
  const editor = row.locator('[contenteditable="true"]')
  await editor.fill('adjust the playlist')
  await expect(row.locator('.plan-goal-badge')).toHaveCount(0)

  await editor.fill('Practice (DJ), then rest')
  const goalBadge = row.getByRole('button', { name: 'DJ practice — show in goal rhythm' })
  await expect(goalBadge).toBeVisible()
  await expect(goalBadge.locator('span')).toHaveCount(0)

  await row.getByRole('checkbox', { name: 'Complete item' }).check()
  await expect(row.locator('.plan-goal-badge', { hasText: 'DJ practice' })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.goalCompletions?.[0]?.matchedTerms ?? []
      }),
    )
    .toEqual(['dj'])
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

test('old goal snapshots survive rule edits and archived goals leave rhythm', async ({ page }, testInfo) => {
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

  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Archive', exact: true })).toBeVisible()
  await expect(page.getByText('Archived', { exact: true })).toBeVisible()
  await expect(page.locator('.goal-history-name', { hasText: 'Exercise' })).toHaveCount(0)
  await expect(page.locator(`.goal-day-cell[title="Exercise · ${oldDate} · completed"]`)).toHaveCount(0)

  const dialogMessages: string[] = []
  page.on('dialog', async (dialog) => {
    dialogMessages.push(dialog.message())
    await dialog.dismiss()
  })
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => dialogMessages.length).toBe(1)
  expect(dialogMessages[0]).toContain('Permanently delete “Exercise” and its 1 saved completion?')
  await expect(page.getByLabel('Goal name: Exercise')).toBeVisible()

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-goals-archived-history.png`,
    fullPage: true,
  })
})

test('a completion resets a rolling deadline and late days stay overdue', async ({ page }, testInfo) => {
  const historyStart = addDays(todayISO(), -120)
  const firstCompletion = addDays(todayISO(), -7)
  const coverageEnd = addDays(firstCompletion, 3)
  const dueDate = addDays(firstCompletion, 4)
  const firstOverdueDate = addDays(firstCompletion, 5)
  const lastOverdueDate = addDays(firstCompletion, 6)
  const secondCompletion = addDays(firstCompletion, 7)

  await page.evaluate(
    ({ historyStart, firstCompletion, secondCompletion }) => {
      const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
      state.goals = [
        {
          id: 'goal_beats',
          name: 'Make a beat',
          cadenceDays: 4,
          matchTerms: ['beat'],
          hue: 278,
          activityPeriods: [{ startDate: historyStart, endDate: null }],
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
    { historyStart, firstCompletion, secondCompletion },
  )
  await page.reload()

  await expect(page.getByLabel('Days of goal history')).toHaveCount(0)
  await expect(page.locator('.goal-date-head').first()).toHaveAttribute('data-goal-date', historyStart)
  await expect(page.locator('.goal-date-head')).toHaveCount(127)
  await expect
    .poll(async () => {
      const timelineScroll = await page.locator('.goal-history-scroll').evaluate((element) => ({
        scrollLeft: element.scrollLeft,
        maxScrollLeft: element.scrollWidth - element.clientWidth,
      }))
      return timelineScroll.scrollLeft > 0 && Math.abs(timelineScroll.scrollLeft - timelineScroll.maxScrollLeft) <= 1
    })
    .toBe(true)

  await expect(page.locator(`.goal-day-cell[title="Make a beat · ${firstCompletion} · completed"]`)).toHaveClass(/segment-start/)
  await expect(page.locator(`.goal-day-cell[title="Make a beat · ${coverageEnd} · active"]`)).toHaveClass(/segment-end/)
  const missedDeadline = page.locator(`.goal-day-cell[title="Make a beat · ${dueDate} · overdue"]`)
  await expect(missedDeadline).toHaveClass(/segment-start/)
  await expect(missedDeadline.locator('.overdue-mark')).toHaveText('×')
  await expect(page.locator(`.goal-day-cell[title="Make a beat · ${firstOverdueDate} · overdue"] .overdue-mark`)).toHaveText('×')
  await expect(page.locator(`.goal-day-cell[title="Make a beat · ${lastOverdueDate} · overdue"]`)).toHaveClass(/segment-end/)
  await expect(page.locator(`.goal-day-cell[title="Make a beat · ${secondCompletion} · completed"]`)).toHaveClass(/segment-start/)
  await expect(page.locator('.goal-history-name', { hasText: 'Make a beat' }).locator('.goal-lapse')).toHaveText('4d left')

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-goal-cadence-segments.png`,
    fullPage: true,
  })
})

test('editing cadence preserves the old Goal Rhythm schedule after reload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goal Rhythm is desktop-only')
  const today = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.activePlanDate as string
  })
  const historyStart = addDays(today, -2)
  const completionDate = addDays(today, -1)
  const tomorrow = addDays(today, 1)

  await page.evaluate(
    ({ historyStart, completionDate }) => {
      const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
      const timestamp = new Date().toISOString()
      state.goals = [
        {
          id: 'goal_read',
          name: 'Read',
          nameHtml: 'Read',
          cadenceDays: 1,
          matchTerms: ['read'],
          matchTermsHtml: 'read',
          hue: 200,
          lightness: 50,
          activityPeriods: [{ startDate: historyStart, endDate: null }],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]
      state.goalCompletions = [
        {
          goalId: 'goal_read',
          date: completionDate,
          itemIds: ['item_read'],
          matchedTerms: ['read'],
          computedAt: timestamp,
        },
      ]
      localStorage.setItem('balance.appState.v1', JSON.stringify(state))
    },
    { historyStart, completionDate },
  )
  await page.reload()

  await page.getByRole('button', { name: 'Manage goals' }).click()
  await page.getByLabel('Cadence days for Read').fill('2')
  await page.getByLabel('Cadence days for Read').press('Tab')
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.goals?.[0]?.cadenceHistory
  })).toEqual([
    { startDate: historyStart, cadenceDays: 1 },
    { startDate: today, cadenceDays: 2 },
  ])

  await page.reload()
  await expect(page.locator(`.goal-day-cell[title="Read · ${completionDate} · completed"]`)).toHaveClass(/segment-end/)
  await expect(page.locator(`.goal-day-cell[title="Read · ${today} · active"]`)).toHaveClass(/segment-start/)
  await expect(page.locator(`.goal-day-cell[title="Read · ${today} · active"]`)).not.toHaveClass(/relieved/)
  await expect(page.locator(`.goal-day-cell[title="Read · ${tomorrow} · active"]`)).toHaveClass(/segment-end/)
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
  await expect(page.locator(`.goal-day-cell[title="Read · ${deadline} · overdue"] .overdue-mark`)).toHaveText('×')
  await expect(page.locator(`.goal-day-cell[title="Read · ${secondStart} · overdue"] .overdue-mark`)).toHaveText('×')
  const actionableToday = page.locator(`.goal-day-cell[title="Read · ${todayISO()} · active"]`)
  await expect(actionableToday).toHaveClass(/segment-end/)
  await expect(actionableToday.locator('.goal-cell-mark.open')).toBeVisible()

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
  await expect(page.locator(`.goal-day-cell[title="Read · ${deadline} · overdue"]`)).toBeVisible()
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

  const currentEnd = page.locator(`.goal-day-cell[title="Overlapping history · ${todayISO()} · active"]`)
  await expect(currentEnd).toHaveClass(/segment-end/)
  await expect(currentEnd).toHaveCSS('border-bottom-right-radius', '999px')
})

test('goal rhythm puts overdue goals last while the goals page keeps urgency order', async ({ page }) => {
  const today = todayISO()
  const fiveDaysAgo = addDays(today, -5)
  const threeDaysAgo = addDays(today, -3)
  const yesterday = addDays(today, -1)

  await page.evaluate(
    ({ today, fiveDaysAgo, threeDaysAgo, yesterday }) => {
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
          id: 'goal_overdue',
          name: 'Overdue',
          cadenceDays: 3,
          matchTerms: ['overdue'],
          hue: 220,
          activityPeriods: [{ startDate: fiveDaysAgo, endDate: null }],
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
    { today, fiveDaysAgo, threeDaysAgo, yesterday },
  )
  await page.reload()

  await expect(page.locator('.goal-history-name span:not(.goal-color-dot)').allTextContents()).resolves.toEqual([
    'Sooner',
    'Short tie',
    'Long tie',
    'Overdue',
  ])

  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await expect(
    page.locator('.goal-card .goal-name-input').evaluateAll((inputs) =>
      inputs.map((input) => input.textContent),
    ),
  ).resolves.toEqual(['Overdue', 'Sooner', 'Short tie', 'Long tie', 'Archived daily'])
  await expect(page.getByRole('heading', { name: 'Archive', exact: true })).toBeVisible()
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

test('day generation opens the goal doability review for legacy overdue and repeatedly missed goals', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date('2026-08-31T12:00:00') })
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const timestamp = '2026-08-01T12:00:00.000Z'
    const baseGoal = {
      nameHtml: '',
      cadenceDays: 1,
      matchTerms: ['goal'],
      matchTermsHtml: 'goal',
      hue: 165,
      lightness: 50,
      activityPeriods: [{ startDate: '2026-08-26', endDate: null }],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const extraGoals = Array.from({ length: 12 }, (_, index) => ({
      ...baseGoal,
      id: `goal_extra_${index}`,
      name: `Review goal ${index + 1}`,
      nameHtml: `Review goal ${index + 1}`,
    }))
    state.goals = [
      {
        ...baseGoal,
        id: 'goal_legacy',
        name: 'Call someone',
        nameHtml: 'Call someone',
        presentationTrackingStartedAt: '2026-08-29T08:00:00.000Z',
      },
      {
        ...baseGoal,
        id: 'goal_tracked',
        name: 'Draw briefly',
        nameHtml: 'Draw briefly',
        presentationTrackingStartedAt: timestamp,
      },
      ...extraGoals,
    ]
    state.goalCompletions = []
    state.plans = ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29'].map((date) => ({
      id: `plan_${date}`,
      date,
      title: date,
      dailyReminder: '',
      generatedFromTemplateId: state.templates[0].id,
      generatedGoalIds: ['goal_tracked'],
      createdAt: `${date}T08:00:00.000Z`,
      items: [],
    }))
    state.activePlanDate = '2026-08-31'
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()

  if (testInfo.project.name === 'mobile') {
    const emptyState = page.locator('.empty-state')
    await emptyState.getByRole('radio', { name: 'Default day' }).check()
    await emptyState.getByRole('button', { name: 'Generate today' }).click()
  } else {
    await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  }

  const modal = page.getByRole('dialog', { name: 'Are your goals attainable?' })
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('heading', { name: 'Are your goals attainable?' })).toBeVisible()
  await expect(modal.getByText("It's easy for the goal system to get clogged. From our experience, goals work best when they are:")).toBeVisible()
  await expect(modal.getByRole('heading', { name: 'Goal check-in' })).toHaveCount(0)
  await expect(modal.getByRole('heading', { name: 'Goals to review' })).toHaveCount(0)
  await expect(modal.getByText('Call someone').locator('..')).toContainText('5 days overdue')
  await expect(modal.getByText('Draw briefly').locator('..')).toContainText('4 days missed')
  await expect(modal.locator('.mascot img')).toBeVisible()
  await expect.poll(async () => {
    const mascot = await modal.locator('.mascot').boundingBox()
    const heading = await modal.getByRole('heading', { name: 'Are your goals attainable?' }).boundingBox()
    return Boolean(mascot && heading && mascot.y + mascot.height <= heading.y)
  }).toBe(true)
  await expect(modal.getByTestId('goal-review-sizing')).toHaveCount(0)
  await expect(modal).toHaveCSS('--overlay-max-width', '1096px')
  await expect(modal).toHaveCSS('--overlay-height', '705px')
  await expect(modal.locator('.modal-resize-handle, .column-resize-handle, .mascot-resize-handle')).toHaveCount(0)
  const closePlacement = await modal.evaluate((element) => {
    const modalBounds = element.getBoundingClientRect()
    const closeBounds = element.querySelector<HTMLElement>('.overlay-floating-close')?.getBoundingClientRect()
    return closeBounds
      ? {
          leftGap: closeBounds.left - modalBounds.left,
          rightGap: modalBounds.right - closeBounds.right,
        }
      : null
  })
  expect(closePlacement).not.toBeNull()
  expect(closePlacement?.leftGap).toBeGreaterThanOrEqual(10)
  expect(closePlacement?.leftGap).toBeLessThanOrEqual(12)
  expect(closePlacement?.rightGap).toBeGreaterThan(100)
  await expect.poll(() => modal.locator('.goals-to-review ul').evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  )).toBe(true)
  await expect.poll(() => modal.locator('.overlay-body').evaluate(
    (element) => element.scrollHeight <= element.clientHeight + 1,
  )).toBe(true)

  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.goals.every((goal: { presentationTrackingStartedAt?: string }) => Boolean(goal.presentationTrackingStartedAt))
  })).toBe(true)

  if (testInfo.project.name === 'desktop') {
    const panels = await modal.locator('.review-layout').evaluate((element) => {
      const guidance = element.querySelector<HTMLElement>('.guidance')!
      const goals = element.querySelector<HTMLElement>('.goals-to-review')!
      return [guidance.getBoundingClientRect().width, goals.getBoundingClientRect().width]
    })
    expect(Math.abs(panels[0] / panels[1] - 639 / 407)).toBeLessThan(0.01)
    await expect(modal.locator('.mascot')).toHaveCSS('height', '393px')

    await page.getByRole('button', { name: 'Goals', exact: true }).click()
    await expect(modal).toHaveCount(0)
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect(modal).toBeVisible()
  }

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-goal-doability-review.png`,
    fullPage: true,
  })

  await modal.getByRole('button', { name: 'Review Call someone: 5 days overdue' }).click()
  await expect(modal).toHaveCount(0)
  if (testInfo.project.name === 'desktop') {
    await expect(page.getByRole('button', { name: 'Goals', exact: true })).toHaveClass(/active/)
  }
  await expect(page.locator('.goal-card[data-goal-id="goal_legacy"]')).toHaveClass(/goal-card-focus/)

  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByRole('complementary', { name: 'Primary navigation drawer' })
      .getByRole('button', { name: 'Today', exact: true })
      .click()
  } else {
    await page.getByRole('button', { name: 'Today', exact: true }).click()
  }
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('button', { name: 'Review Call someone: 5 days overdue' })).toBeVisible()
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
  await page.clock.install({ time: new Date('2026-06-16T12:00:00') })
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await createGoal(page, 'Exercise', 3, 'lift, swim')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  // The current day owns the `today` class and bold text, regardless of which
  // day is selected.
  const todayHead = page.locator('.goal-date-head.today')
  await expect(todayHead).toHaveCount(1)
  await expect(todayHead).toHaveClass(/viewed/)
  await expect(todayHead.locator('strong')).toHaveCSS('font-weight', '700')

  const todayDate = (await todayHead.getAttribute('data-goal-date')) ?? todayISO()
  const tomorrow = addDays(todayDate, 1)

  await page.getByRole('button', { name: 'Next day' }).click()

  const tomorrowHead = page.locator(`.goal-date-head[data-goal-date="${tomorrow}"]`)
  await expect(tomorrowHead).toHaveClass(/viewed/)
  await expect(tomorrowHead).not.toHaveClass(/today/)
  await expect(tomorrowHead.locator('strong')).toHaveCSS('font-weight', '600')
  await expect(page.locator(`.goal-day-cell[title*="${tomorrow}"]`)).toHaveClass(/viewed/)

  // Selecting another day moves the highlight but not the bold current-day mark.
  await expect(todayHead).not.toHaveClass(/viewed/)
  await expect(todayHead).toHaveClass(/today/)
  await expect(todayHead.locator('strong')).toHaveCSS('font-weight', '700')
})

test('goal rhythm leaves space between adjacent two-digit August date labels', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Goal Rhythm is desktop-only')
  await page.clock.install({ time: new Date('2026-08-10T12:00:00') })
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await createGoal(page, 'Exercise', 3, 'lift, swim')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  const augustTenth = page.locator('.goal-date-head[data-goal-date="2026-08-10"] strong')
  const augustEleventh = page.locator('.goal-date-head[data-goal-date="2026-08-11"] strong')
  await expect(augustTenth).toHaveText('Aug 10')
  await expect(augustEleventh).toHaveText('Aug 11')

  const labelGap = await augustTenth.evaluate((label, nextSelector) => {
    const nextLabel = document.querySelector<HTMLElement>(nextSelector)
    if (!nextLabel) throw new Error(`Missing adjacent date label: ${nextSelector}`)
    const textBounds = (element: Element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return range.getBoundingClientRect()
    }
    return textBounds(nextLabel).left - textBounds(label).right
  }, '.goal-date-head[data-goal-date="2026-08-11"] strong')

  expect(labelGap).toBeGreaterThanOrEqual(2.5)
})

test('goal rhythm grows a column for the new day after the clock rolls over', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-06-16T12:00:00') })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await createGoal(page, 'Exercise', 1, 'lift, swim')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  await expect(page.locator('.goal-date-head[data-goal-date="2026-06-16"]')).toHaveCount(1)
  await expect(page.locator('.goal-date-head[data-goal-date="2026-06-17"]').first()).toHaveClass(/future/)

  // The day rolls over while the app stays open. Without a reactive clock the
  // date list would stay anchored to the previous day.
  await page.clock.setFixedTime(new Date('2026-06-17T12:00:00'))
  await page.clock.runFor(61_000)

  await expect(page.locator('.goal-date-head[data-goal-date="2026-06-17"]').first()).not.toHaveClass(/future/)
  await expect(page.locator('.goal-date-head[data-goal-date="2026-06-17"].today')).toHaveCount(1)
})

test('long tasks use a vertical desktop goal stack and a wrapping mobile goal row', async ({ page }, testInfo) => {
  const taskText = [
    'Stack the research notes into a careful project update that explains every open question,',
    'captures the decisions from the longer planning conversation, and records the follow-up work',
    'for the design review, implementation pass, documentation pass, and final release checklist.',
  ].join(' ')

  await page.evaluate((text) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const date = new Date().toISOString().slice(0, 10)
    const timestamp = new Date().toISOString()

    state.activePlanDate = date
    state.plans = [
      {
        id: 'long_goal_plan',
        date,
        dailyReminder: '',
        items: [
          {
            id: 'long_goal_item',
            text,
            html: text,
            done: false,
            startMinutes: null,
            endMinutes: null,
            children: [],
          },
        ],
      },
    ]
    state.goals = ['Health routines', 'Creative practice', 'Personal projects'].map((name, index) => ({
      id: `stacked_goal_${index}`,
      name,
      cadenceDays: 1,
      matchTerms: ['stack'],
      matchTermsHtml: 'stack',
      hue: 80 + index * 90,
      lightness: 50,
      activityPeriods: [{ startDate: date, endDate: null }],
      createdAt: timestamp,
      updatedAt: timestamp,
    }))
    state.goalCompletions = []
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, taskText)
  await page.reload()

  const row = page.locator('[data-plan-item-id="long_goal_item"]')
  const badges = row.locator('.plan-goal-badge')
  await expect(badges).toHaveCount(3)

  const geometry = await row.evaluate((element) => {
    const text = element.querySelector<HTMLElement>('.item-text')
    const badgeElements = Array.from(element.querySelectorAll<HTMLElement>('.plan-goal-badge'))
    if (!text || badgeElements.length !== 3) throw new Error('Missing long task layout elements')

    const textRect = text.getBoundingClientRect()
    const badgeRects = badgeElements.map((badge) => badge.getBoundingClientRect())
    return {
      textHeight: textRect.height,
      textBottom: textRect.bottom,
      badgeStackHeight: badgeRects.reduce((height, rect) => height + rect.height, 0) + 8,
      badgeRights: badgeRects.map((rect) => rect.right),
      badgeTops: badgeRects.map((rect) => rect.top),
    }
  })

  if (testInfo.project.name === 'desktop') {
    expect(geometry.textHeight).toBeGreaterThanOrEqual(geometry.badgeStackHeight)
    expect(Math.max(...geometry.badgeRights) - Math.min(...geometry.badgeRights)).toBeLessThanOrEqual(1)
    expect(geometry.badgeTops[1]).toBeGreaterThan(geometry.badgeTops[0])
    expect(geometry.badgeTops[2]).toBeGreaterThan(geometry.badgeTops[1])
  } else {
    expect(Math.abs(geometry.badgeTops[1] - geometry.badgeTops[0])).toBeLessThanOrEqual(1)
    expect(geometry.badgeTops[2]).toBeGreaterThan(geometry.badgeTops[1])
    expect(geometry.badgeTops[0]).toBeGreaterThanOrEqual(geometry.textBottom)
  }

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-long-task-stacked-goals.png`,
    fullPage: true,
  })
})

test('goal rhythm uses one smooth scroll surface across its name and timeline panes', async ({ page }, testInfo) => {
  await selectDeviceThemeForTest(page, 'iridescent')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'iridescent')
  const historyStart = addDays(todayISO(), -120)

  await page.evaluate((historyStart) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const timestamp = new Date().toISOString()
    state.goals = Array.from({ length: 24 }, (_, index) => ({
      id: `goal_scroll_${index}`,
      name: `Scroll goal ${index + 1}`,
      cadenceDays: 1,
      matchTerms: [`scroll-${index + 1}`],
      hue: index * 15,
      activityPeriods: [{ startDate: historyStart, endDate: null }],
      createdAt: timestamp,
      updatedAt: timestamp,
    }))
    state.goalCompletions = []
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, historyStart)
  await page.reload()

  const timeline = page.locator('.goal-history-scroll')
  const names = page.locator('.goal-history-name-pane')
  const firstName = page.locator('.goal-history-name').first()
  await expect(page.locator('.goal-day-cell.overdue').first()).toBeVisible()
  await expect(firstName).toHaveCSS('position', 'static')
  await expect.poll(() => goalRhythmPaneGap(page)).toBe(0)

  const scrollOwnership = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.goal-history-scroll')
    const nameList = document.querySelector<HTMLElement>('.goal-history-name-scroll')
    const timelinePane = document.querySelector<HTMLElement>('.goal-history-timeline')
    if (!scroller || !nameList || !timelinePane) throw new Error('Could not find Goal Rhythm panes')
    return {
      scrollerOverflowY: getComputedStyle(scroller).overflowY,
      nameOverflowY: getComputedStyle(nameList).overflowY,
      timelineOverflowY: getComputedStyle(timelinePane).overflowY,
    }
  })
  expect(scrollOwnership).toEqual({
    scrollerOverflowY: 'auto',
    nameOverflowY: 'visible',
    timelineOverflowY: 'visible',
  })
  await expect(page.locator('.goal-history-corner')).toHaveCount(0)
  await expect(page.locator('.goal-history-name-backdrop')).toHaveCount(1)
  await expect(page.locator('.goal-history-name-header')).toHaveCount(1)

  const modeGeometry = await page.evaluate((modes) => {
    const rhythm = document.querySelector<HTMLElement>('.goal-history-panel')
    if (!rhythm) throw new Error('Could not find Goal Rhythm')

    const measurements = modes.map((mode) => {
      rhythm.dataset.rhythmMode = mode
      const nameRows = [...document.querySelectorAll<HTMLElement>('.goal-history-name')]
      const dayRows = [...document.querySelectorAll<HTMLElement>('.goal-history-day-row')]
      const deltas = nameRows.slice(0, 12).map((nameRow, index) => {
        const activeCell = dayRows[index]?.querySelector<HTMLElement>('.goal-day-cell.active')
        if (!activeCell) throw new Error(`Could not find active cell for row ${index}`)
        const nameRect = nameRow.getBoundingClientRect()
        const cellRect = activeCell.getBoundingClientRect()
        return {
          top: Math.abs(Math.round(nameRect.top - cellRect.top)),
          height: Math.abs(Math.round(nameRect.height - cellRect.height)),
        }
      })
      return {
        mode,
        maximumTopDifference: Math.max(...deltas.map((delta) => delta.top)),
        maximumHeightDifference: Math.max(...deltas.map((delta) => delta.height)),
      }
    })
    rhythm.dataset.rhythmMode = 'flow'
    return measurements
  }, ['flow', 'flow-tint', 'flow-halo', 'flow-ghost', 'flow-orbit', 'flow-line', 'flow-dots', 'flow-tide', 'mosaic', 'columns', 'signal', 'ledger', 'aurora', 'constellation'])
  expect(modeGeometry).toEqual([
    { mode: 'flow', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'flow-tint', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'flow-halo', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'flow-ghost', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'flow-orbit', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'flow-line', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'flow-dots', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'flow-tide', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'mosaic', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'columns', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'signal', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'ledger', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'aurora', maximumTopDifference: 0, maximumHeightDifference: 0 },
    { mode: 'constellation', maximumTopDifference: 0, maximumHeightDifference: 0 },
  ])

  const nameBox = await names.boundingBox()
  const scrollBox = await timeline.boundingBox()
  if (!nameBox || !scrollBox) throw new Error('Could not measure Goal Rhythm panes')

  await timeline.evaluate((element) => {
    element.scrollLeft = 0
    element.scrollTop = 0
  })
  await page.mouse.move(nameBox.x + nameBox.width / 2, nameBox.y + Math.min(70, nameBox.height / 2))
  await page.mouse.wheel(0, 180)
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => goalRhythmScrollTopDifference(page)).toBe(0)

  const afterNameScroll = await timeline.evaluate((element) => element.scrollTop)
  await page.mouse.move(
    scrollBox.x + nameBox.width + Math.min(60, Math.max(1, scrollBox.width - nameBox.width) / 2),
    scrollBox.y + Math.min(70, scrollBox.height / 2),
  )
  await page.mouse.wheel(0, 180)
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(afterNameScroll)
  await expect.poll(() => goalRhythmScrollTopDifference(page)).toBe(0)

  const beforeReverse = await timeline.evaluate((element) => element.scrollTop)
  await page.mouse.move(nameBox.x + nameBox.width / 2, nameBox.y + Math.min(70, nameBox.height / 2))
  await page.mouse.wheel(0, -90)
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeLessThan(beforeReverse)
  await expect.poll(() => goalRhythmScrollTopDifference(page)).toBe(0)
  const stickyHeaderOffsets = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.goal-history-scroll')
    const names = document.querySelector<HTMLElement>('.goal-history-name-header')
    const dates = document.querySelector<HTMLElement>('.goal-history-date-row')
    if (!scroller || !names || !dates) throw new Error('Could not find Goal Rhythm headers')
    const scrollerTop = scroller.getBoundingClientRect().top
    return {
      names: Math.round(names.getBoundingClientRect().top - scrollerTop),
      dates: Math.round(dates.getBoundingClientRect().top - scrollerTop),
    }
  })
  expect(stickyHeaderOffsets).toEqual({ names: 0, dates: 0 })

  await timeline.evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth
  })
  await expect.poll(() => goalRhythmPaneGap(page)).toBe(0)
  const namePaneCoverage = await timeline.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight
    const pane = document.querySelector<HTMLElement>('.goal-history-name-backdrop')
    if (!pane) throw new Error('Could not find Goal Rhythm name backdrop')
    const paneStyle = getComputedStyle(pane)
    const paneRect = pane.getBoundingClientRect()
    const scrollRect = element.getBoundingClientRect()
    return {
      topDifference: Math.round(paneRect.top - scrollRect.top),
      bottomDifference: Math.round(paneRect.bottom - scrollRect.bottom),
      backgroundColor: paneStyle.backgroundColor,
    }
  })
  expect(namePaneCoverage.topDifference).toBe(0)
  expect(namePaneCoverage.bottomDifference).toBe(0)
  expect(namePaneCoverage.backgroundColor).not.toMatch(/^rgba\(/)

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-goal-rhythm-split-scroll.png`,
    fullPage: true,
  })
})

test('clicking a plan item goal badge reveals that goal in the rhythm panel', async ({ page }) => {
  await selectDeviceThemeForTest(page, 'iridescent')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'iridescent')
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

  const currentDate = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.activePlanDate as string
  })
  await page.evaluate(({ currentDate, overdueStart }) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const exercise = state.goals?.find((goal: { name: string }) => goal.name === 'Exercise')
    if (!exercise) throw new Error('Expected the Exercise goal')

    const timestamp = new Date().toISOString()
    const decoys = Array.from({ length: 30 }, (_, index) => ({
      id: `goal_decoy_${index}`,
      name: `Decoy goal ${index + 1}`,
      nameHtml: `Decoy goal ${index + 1}`,
      cadenceDays: index < 20 ? 1 : 3,
      matchTerms: [`decoy-${index + 1}`],
      matchTermsHtml: `decoy-${index + 1}`,
      hue: index * 12,
      lightness: 50,
      activityPeriods: [{ startDate: index < 20 ? currentDate : overdueStart, endDate: null }],
      createdAt: timestamp,
      updatedAt: timestamp,
    }))
    state.goals = [...decoys.slice(0, 20), exercise, ...decoys.slice(20)]
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, { currentDate, overdueStart: addDays(currentDate, -5) })
  await page.reload()
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  const goalRow = page.locator('.goal-history-name[data-goal-id]', { hasText: 'Exercise' })
  await expect(goalRow).toHaveCount(1)
  await scrollGoalRhythmAwayFromRow(page, 'Exercise')
  await expect.poll(() => goalRhythmRowIsFullyVisible(page, 'Exercise')).toBe(false)
  await expect(goalRow).not.toHaveClass(/goal-row-focus/)

  await page.keyboard.press('Alt+a')
  await expect(page.locator('.goal-history-panel')).toHaveCount(0)
  await page.evaluate(() => {
    const testWindow = window as Window & {
      goalHighlightAnimationStarts?: number
      goalHighlightAnimationEnds?: number
      goalRevealEventOrder?: string[]
    }
    testWindow.goalHighlightAnimationStarts = 0
    testWindow.goalHighlightAnimationEnds = 0
    testWindow.goalRevealEventOrder = []
    document.addEventListener('scroll', (event) => {
      if (
        event.target instanceof HTMLElement
        && event.target.matches('.goal-history-scroll')
        && !testWindow.goalRevealEventOrder?.includes('scroll')
      ) {
        testWindow.goalRevealEventOrder?.push('scroll')
      }
    }, true)
    document.addEventListener('animationstart', (event) => {
      const target = event.target
      if (
        event.animationName === 'goal-reveal-highlight-fade'
        && target instanceof HTMLElement
        && target.matches('.goal-history-name[data-goal-id]')
        && target.textContent?.includes('Exercise')
      ) {
        testWindow.goalHighlightAnimationStarts = (testWindow.goalHighlightAnimationStarts ?? 0) + 1
        if (!testWindow.goalRevealEventOrder?.includes('highlight')) testWindow.goalRevealEventOrder?.push('highlight')
      }
    })
    document.addEventListener('animationend', (event) => {
      const target = event.target
      if (
        event.animationName === 'goal-reveal-highlight-fade'
        && target instanceof HTMLElement
        && target.matches('.goal-history-name[data-goal-id]')
        && target.textContent?.includes('Exercise')
      ) {
        testWindow.goalHighlightAnimationEnds = (testWindow.goalHighlightAnimationEnds ?? 0) + 1
      }
    })
  })

  await badge.click()
  await expect(page.locator('.goal-history-panel')).toBeVisible()
  await expect(goalRow).toHaveClass(/goal-row-focus/)
  await expect.poll(() => goalRhythmRowCenterOffset(page, 'Exercise')).toBeLessThanOrEqual(1)
  expect(await goalRhythmScrollTopDifference(page)).toBe(0)
  await expect.poll(() => goalHighlightAnimationStarts(page)).toBe(1)
  await page.waitForTimeout(1100)
  const fadingRowOpacity = await goalRevealHighlightOpacity(goalRow)
  expect(fadingRowOpacity).toBeGreaterThan(0)
  expect(fadingRowOpacity).toBeLessThan(1)
  await expect(goalRow).not.toHaveClass(/goal-row-focus/)
  await expect.poll(() => goalHighlightAnimationEnds(page)).toBe(1)

  await scrollGoalRhythmAwayFromRow(page, 'Exercise')
  await expect.poll(() => goalRhythmRowIsFullyVisible(page, 'Exercise')).toBe(false)
  await page.evaluate(() => {
    const testWindow = window as Window & { goalRevealEventOrder?: string[] }
    testWindow.goalRevealEventOrder = []
  })
  await badge.click()
  await expect(goalRow).toHaveClass(/goal-row-focus/)
  await expect.poll(() => goalRhythmRowCenterOffset(page, 'Exercise')).toBeLessThanOrEqual(1)
  await expect.poll(() => goalRevealEventOrder(page)).toEqual(['highlight', 'scroll'])
  expect(await goalRhythmScrollTopDifference(page)).toBe(0)

  const rhythmSearch = page.getByRole('searchbox', { name: 'Search goals' })
  await rhythmSearch.fill('Decoy goal 1')
  await expect(goalRow).toHaveCount(0)
  await badge.click()
  await expect(rhythmSearch).toHaveValue('')
  await expect(goalRow).toHaveCount(1)
  await expect.poll(() => goalRhythmRowCenterOffset(page, 'Exercise')).toBeLessThanOrEqual(1)
})

test('clicking an unchecked goal preview reveals that goal in the rhythm panel', async ({ page }) => {
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await createGoal(page, 'Exercise', 1, 'lift, swim')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  const matchingText = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.plans?.[0]?.items?.find((item: { text: string }) => /lift|swim/i.test(item.text))?.text ?? ''
  })
  expect(matchingText).not.toBe('')

  const row = page.getByRole('listitem', { name: `Plan item: ${matchingText}` })
  const goalPreview = row.getByRole('button', { name: 'Exercise — show in goal rhythm' })
  await expect(goalPreview).toBeVisible()

  const goalRow = page.locator('.goal-history-name[data-goal-id]', { hasText: 'Exercise' })
  await expect(goalRow).not.toHaveClass(/goal-row-focus/)

  await goalPreview.click()
  await expect(goalRow).toHaveClass(/goal-row-focus/)
})

test('clicking a goal card background reveals it without making field labels focus inputs', async ({ page }) => {
  await createGoal(page, 'Exercise', 3, 'lift, swim')

  const card = page.locator('.goal-card', { has: page.getByLabel('Goal name: Exercise') })
  const goalRow = page.locator('.goal-history-name[data-goal-id]', { hasText: 'Exercise' })
  await expect(card).toHaveCSS('cursor', 'auto')
  await expect(goalRow).not.toHaveClass(/goal-row-focus/)

  await card.locator('.goal-card-accent').click()
  await expect(goalRow).toHaveClass(/goal-row-focus/)

  const cadenceInput = page.getByLabel('Cadence days for Exercise')
  await card.getByText('Complete every', { exact: true }).click()
  await expect(cadenceInput).not.toBeFocused()
  await cadenceInput.click()
  await expect(cadenceInput).toBeFocused()

  const startInput = page.getByLabel('Start date for Exercise')
  await card.getByText('Started on', { exact: true }).click()
  await expect(startInput).not.toBeFocused()
  await startInput.click()
  await expect(startInput).toBeFocused()
})

test('clicking a goal rhythm row scrolls to that goal on the goals page', async ({ page }) => {
  await selectDeviceThemeForTest(page, 'iridescent')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'iridescent')
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
  const highlightedCard = await targetCard.evaluate((element) => {
    const highlight = getComputedStyle(element, '::before')
    return {
      animationDuration: highlight.animationDuration,
      animationName: highlight.animationName,
      backgroundImage: highlight.backgroundImage,
      opacity: Number(highlight.opacity),
    }
  })
  expect(highlightedCard.animationName).toBe('goal-card-highlight-fade')
  expect(highlightedCard.animationDuration).toBe('1.6s')
  expect(highlightedCard.backgroundImage).toContain('linear-gradient')
  expect(highlightedCard.opacity).toBe(1)
  await expect(targetCard).not.toHaveClass(/goal-card-focus/)

  await resetActiveScrollTop(page)
  await targetRow.click()
  await expect(targetCard).toHaveClass(/goal-card-focus/)
  await expect.poll(() => goalCardCenterOffset(page, targetGoal)).toBeLessThanOrEqual(1)
})

test('goal rhythm copy button copies the goal name without opening the row', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: playwrightOrigin })
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
  await page.addInitScript(() => { Math.random = () => 165 / 360 })
  await page.reload()
  await page.emulateMedia({ colorScheme: 'dark' })
  await createGoal(page, 'Exercise', 3, 'lift, swim')
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  const activeCell = page.locator('.goal-day-cell.active').first()
  await expect(activeCell).toBeVisible()
  await expect(activeCell).toHaveCSS('background-color', 'rgb(23, 79, 65)')
  await expect(activeCell.locator('.goal-cell-mark.open')).toHaveCSS('border-color', 'rgba(58, 136, 116, 0.7)')
})

test('goal cards show their saved completion count without frozen-history text', async ({ page }) => {
  await createGoal(page, 'Exercise', 3, 'lift, swim')
  await expect(page.locator('.goal-card-meta')).toHaveText('0 saved completions')
  await expect(page.getByLabel('Matching terms for Exercise')).toHaveCSS('cursor', 'text')
  await expect(page.getByText(/history before .* is frozen/i)).toHaveCount(0)
})

test('iridescent goal cards do not draw a decorative corner outline', async ({ page }) => {
  await selectDeviceThemeForTest(page, 'iridescent')
  await createGoal(page, 'Exercise', 3, 'lift, swim')

  const card = page.locator('.goal-card')
  await expect(card).toHaveCSS('border-color', 'rgb(221, 211, 230)')
  await expect.poll(() => card.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('none')
})

test('long goal names truncate without overlapping status or archive actions', async ({ page }) => {
  const name = 'Build a thoughtful and sustainable creative practice that supports every ambitious project without losing sight of rest and reflection'
  await createGoal(page, name, 3, 'creative')
  await page.getByRole('button', { name: 'Archive', exact: true }).click()

  const card = page.locator('.goal-card', { has: page.getByLabel(`Goal name: ${name}`) })
  const layout = await card.evaluate((element) => {
    const nameEditor = element.querySelector<HTMLElement>('.goal-name-input')
    const status = element.querySelector<HTMLElement>('.goal-state')
    const actions = element.querySelector<HTMLElement>('.goal-card-actions')
    if (!nameEditor || !status || !actions) throw new Error('Expected complete goal card')

    const overlaps = (left: DOMRect, right: DOMRect) => !(
      left.right <= right.left || right.right <= left.left || left.bottom <= right.top || right.bottom <= left.top
    )
    const nameRect = nameEditor.getBoundingClientRect()
    const statusRect = status.getBoundingClientRect()
    const actionsRect = actions.getBoundingClientRect()
    return {
      truncated: nameEditor.scrollWidth > nameEditor.clientWidth,
      nameOverlapsStatus: overlaps(nameRect, statusRect),
      nameOverlapsActions: overlaps(nameRect, actionsRect),
      statusOverlapsActions: overlaps(statusRect, actionsRect),
    }
  })

  expect(layout).toEqual({
    truncated: true,
    nameOverlapsStatus: false,
    nameOverlapsActions: false,
    statusOverlapsActions: false,
  })
  await expect(card.locator('.goal-name-input')).toHaveCSS('text-overflow', 'ellipsis')

  const nameEditor = card.locator('.goal-name-input')
  await nameEditor.click()
  await expect(nameEditor).toBeFocused()
  await expect(nameEditor).toHaveCSS('text-overflow', 'clip')
  await expect(nameEditor).toHaveCSS('white-space', 'normal')
  await expect.poll(() => nameEditor.evaluate((element) => {
    const style = getComputedStyle(element)
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2
    const singleLineHeight = lineHeight + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
    return {
      fullyVisible: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
      wraps: element.clientHeight > singleLineHeight + 1,
    }
  })).toEqual({ fullyVisible: true, wraps: true })

  await card.locator('.goal-card-meta').click()
  await expect(nameEditor).not.toBeFocused()
  await expect(nameEditor).toHaveCSS('text-overflow', 'ellipsis')
})

async function createGoal(page: import('@playwright/test').Page, name: string, cadenceDays: number, terms: string) {
  if (!(await page.getByLabel('New goal name').isVisible())) {
    await page.getByRole('button', { name: 'Manage goals' }).click()
  }
  await page.getByLabel('New goal name').fill(name)
  await page.getByLabel('New goal cadence days').fill(String(cadenceDays))
  await page.getByLabel('New goal matching terms').fill(terms)
  await page.getByRole('button', { name: 'Add goal', exact: true }).click()
  await expect(page.getByLabel(`Goal name: ${name}`)).toBeVisible()
}

async function navigateTo(page: import('@playwright/test').Page, view: 'Goals' | 'Today') {
  const viewButton = page.getByRole('button', { name: view, exact: true })
  const openNavigationButton = page.getByRole('button', { name: 'Open navigation' })
  if (await openNavigationButton.isVisible()) await openNavigationButton.click()
  await viewButton.click()
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
      candidate.querySelector<HTMLElement>('.goal-name-input')?.textContent === name,
    )
    if (!workspace || !card) return null
    const workspaceScrolls = workspace.scrollHeight > workspace.clientHeight
    const workspaceRect = workspace.getBoundingClientRect()
    const containerTop = workspaceScrolls ? workspaceRect.top : 0
    const containerHeight = workspaceScrolls ? workspaceRect.height : window.innerHeight
    const cardRect = card.getBoundingClientRect()
    const cardCenter = cardRect.top + cardRect.height / 2
    return Math.abs(Math.round(cardCenter - (containerTop + containerHeight / 2)))
  }, goalName)
}

async function goalRhythmPaneGap(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const timeline = document.querySelector<HTMLElement>('.goal-history-scroll')
    const names = document.querySelector<HTMLElement>('.goal-history-name-pane')
    if (!timeline || !names) return null
    return Math.round(names.getBoundingClientRect().left - timeline.getBoundingClientRect().left)
  })
}

async function goalRhythmScrollTopDifference(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const dayRow = document.querySelector<HTMLElement>('.goal-history-day-row')
    const nameRow = document.querySelector<HTMLElement>('.goal-history-name')
    if (!dayRow || !nameRow) return null
    return Math.round(dayRow.getBoundingClientRect().top - nameRow.getBoundingClientRect().top)
  })
}

async function goalRhythmRowIsFullyVisible(page: import('@playwright/test').Page, goalName: string) {
  return page.evaluate((name) => {
    const viewport = document.querySelector<HTMLElement>('.goal-history-scroll')
    const row = [...document.querySelectorAll<HTMLElement>('.goal-history-name')].find((candidate) =>
      candidate.textContent?.includes(name),
    )
    if (!viewport || !row) return null
    const viewportRect = viewport.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    return rowRect.top >= viewportRect.top + 30 && rowRect.bottom <= viewportRect.bottom
  }, goalName)
}

async function scrollGoalRhythmAwayFromRow(page: import('@playwright/test').Page, goalName: string) {
  await page.evaluate((name) => {
    const viewport = document.querySelector<HTMLElement>('.goal-history-scroll')
    const row = [...document.querySelectorAll<HTMLElement>('.goal-history-name')].find((candidate) =>
      candidate.textContent?.includes(name),
    )
    if (!viewport || !row) throw new Error(`Could not find Goal Rhythm row for ${name}`)

    const rowTop = viewport.scrollTop + row.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    viewport.scrollTop = rowTop < maxTop / 2 ? maxTop : 0
  }, goalName)
}

async function goalRhythmRowCenterOffset(page: import('@playwright/test').Page, goalName: string) {
  return page.evaluate((name) => {
    const viewport = document.querySelector<HTMLElement>('.goal-history-scroll')
    const row = [...document.querySelectorAll<HTMLElement>('.goal-history-name')].find((candidate) =>
      candidate.textContent?.includes(name),
    )
    if (!viewport || !row) return null
    const viewportRect = viewport.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const contentTop = viewportRect.top + 30
    const contentHeight = viewportRect.height - 30
    return Math.abs(Math.round(
      rowRect.top + rowRect.height / 2 - (contentTop + contentHeight / 2),
    ))
  }, goalName)
}

async function goalHighlightAnimationStarts(page: import('@playwright/test').Page) {
  return page.evaluate(() => (
    window as Window & { goalHighlightAnimationStarts?: number }
  ).goalHighlightAnimationStarts ?? 0)
}

async function goalHighlightAnimationEnds(page: import('@playwright/test').Page) {
  return page.evaluate(() => (
    window as Window & { goalHighlightAnimationEnds?: number }
  ).goalHighlightAnimationEnds ?? 0)
}

async function goalRevealEventOrder(page: import('@playwright/test').Page) {
  return page.evaluate(() => (
    window as Window & { goalRevealEventOrder?: string[] }
  ).goalRevealEventOrder ?? [])
}

async function goalRevealHighlightOpacity(locator: import('@playwright/test').Locator) {
  return locator.evaluate((element) => Number(getComputedStyle(element, '::after').opacity))
}
