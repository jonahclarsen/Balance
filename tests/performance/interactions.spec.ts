import { expect, test, type Page } from '@playwright/test'

const PLAN_COUNT = performanceSize('BALANCE_INTERACTION_PERF_PLANS', 365)
const ITEMS_PER_PLAN = performanceSize('BALANCE_INTERACTION_PERF_ITEMS_PER_PLAN', 20)
const LIST_COUNT = performanceSize('BALANCE_INTERACTION_PERF_LISTS', 180)
const ITEMS_PER_LIST = performanceSize('BALANCE_INTERACTION_PERF_ITEMS_PER_LIST', 20)
const GOAL_COUNT = performanceSize('BALANCE_INTERACTION_PERF_GOALS', 80)
const EXISTING_OPERATION_COUNT = performanceSize('BALANCE_INTERACTION_PERF_OPERATIONS', 5_000)
const EDIT_COUNT = performanceSize('BALANCE_INTERACTION_PERF_EDITS', 24)
const GOAL_EDIT_COUNT = performanceSize('BALANCE_INTERACTION_PERF_GOAL_EDITS', 8)
const IMAX_TOGGLE_COUNT = performanceSize('BALANCE_IMAX_PERF_TOGGLES', 10)
const THEME_ID = process.env.BALANCE_INTERACTION_PERF_THEME ?? 'iridescent'
const IRIDESCENT_MOTION_PROFILE = process.env.BALANCE_INTERACTION_PERF_IRIDESCENT_MOTION ?? 'full'
const CLICK_COUNT = performanceSize('BALANCE_INTERACTION_PERF_CLICKS', 12)
const FRAME_SAMPLE_MS = performanceSize('BALANCE_INTERACTION_PERF_FRAME_SAMPLE_MS', 1_500)
const ACTIVE_DATE = '2026-08-16'
const EDITOR_SELECTOR = `[data-plan-text-input-id="plan_${PLAN_COUNT - 1}_item_1"]`

type Sample = {
  dispatchMs: number
  paintMs: number
}

const IRIDESCENT_MOTION_STYLES: Record<string, string> = {
  static: '',
  'only-background': `
    :root[data-theme='iridescent'] body::before {
      animation: iridescent-background-breathe 18s ease-in-out infinite alternate !important;
    }
  `,
  'only-sidebar': `
    :root[data-theme='iridescent'] .sidebar {
      animation: iridescent-sidebar-breathe 22s ease-in-out infinite alternate !important;
    }
  `,
  'only-borders': `
    :root[data-theme='iridescent'] {
      --iridescent-border-animation: iridescent-border-turn 34s linear infinite !important;
    }
  `,
  'only-borders-2fps': `
    :root[data-theme='iridescent'] {
      --iridescent-border-animation: iridescent-border-turn 34s steps(68, end) infinite !important;
    }
  `,
  'only-borders-4fps': `
    :root[data-theme='iridescent'] {
      --iridescent-border-animation: iridescent-border-turn 34s steps(136, end) infinite !important;
    }
  `,
  'only-borders-8fps': `
    :root[data-theme='iridescent'] {
      --iridescent-border-animation: iridescent-border-turn 34s steps(272, end) infinite !important;
    }
  `,
  'only-borders-15fps': `
    :root[data-theme='iridescent'] {
      --iridescent-border-animation: iridescent-border-turn 34s steps(510, end) infinite !important;
    }
  `,
  'only-borders-30fps': `
    :root[data-theme='iridescent'] {
      --iridescent-border-animation: iridescent-border-turn 34s steps(1020, end) infinite !important;
    }
  `,
  'only-active-nav': `
    :root[data-theme='iridescent'] :is(
      .sidebar nav button.active,
      .list-template-tabs .rail-chip.active
    ) {
      animation: iridescent-active-nav-breathe 12s ease-in-out infinite alternate !important;
    }
  `,
  'only-brand': `
    :root[data-theme='iridescent'] :is(.sidebar-brand-heading h1, .mobile-app-title strong) {
      animation: iridescent-brand-flow 42s ease-in-out infinite alternate !important;
    }
  `,
}

const DISABLE_IRIDESCENT_MOTION = `
  :root[data-theme='iridescent'] {
    --iridescent-border-animation: none !important;
  }

  :root[data-theme='iridescent'] body::before,
  :root[data-theme='iridescent'] .sidebar {
    animation: none !important;
  }

  :root[data-theme='iridescent'] :is(
    .sidebar nav button.active,
    .list-template-tabs .rail-chip.active
  ),
  :root[data-theme='iridescent'] :is(
    .sidebar-brand-heading h1,
    .mobile-app-title strong
  ) {
    animation: none !important;
  }
`

const KEEP_ONLY_FOCUSED_BORDER_MOTION = `
  :root[data-theme='iridescent'] {
    --iridescent-border-animation: none !important;
  }

  :root[data-theme='iridescent'] .sidebar nav button.active::after,
  :root[data-theme='iridescent'] .plan-row .item-text:focus::after {
    animation: iridescent-border-turn 34s linear infinite !important;
  }
`

function performanceSize(variable: string, fallback: number) {
  const value = Number(process.env[variable])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

function summarize(samples: Sample[]) {
  const dispatch = samples.map((sample) => sample.dispatchMs)
  const paint = samples.map((sample) => sample.paintMs)
  return {
    count: samples.length,
    dispatch: {
      medianMs: percentile(dispatch, 0.5),
      p95Ms: percentile(dispatch, 0.95),
      maxMs: Math.max(...dispatch),
    },
    paint: {
      medianMs: percentile(paint, 0.5),
      p95Ms: percentile(paint, 0.95),
      maxMs: Math.max(...paint),
    },
  }
}

function summarizeDurations(values: number[]) {
  return {
    count: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  }
}

async function installSyntheticWorkspace(page: Page) {
  await page.addInitScript(
    ({ planCount, itemsPerPlan, listCount, itemsPerList, goalCount, operationCount, activeDate, themeId }) => {
      const planDate = (index: number) => {
        if (index === planCount - 1) return activeDate
        const date = new Date(`${activeDate}T12:00:00Z`)
        date.setUTCDate(date.getUTCDate() - (planCount - 1 - index))
        return date.toISOString().slice(0, 10)
      }
      const item = (prefix: string, index: number) => ({
        id: `${prefix}_item_${index}`,
        text: `${prefix} task ${index}`,
        html: `${prefix} task ${index}`,
        done: index % 4 === 0,
        startMinutes: null,
        endMinutes: null,
        children: [],
      })
      const plans = Array.from({ length: planCount }, (_, planIndex) => ({
        id: `plan_${planIndex}`,
        date: planDate(planIndex),
        title: `Plan ${planIndex}`,
        dailyReminder: '',
        generatedFromTemplateId: null,
        createdAt: '2026-01-01T00:00:00Z',
        items: Array.from({ length: itemsPerPlan }, (_, itemIndex) => item(`plan_${planIndex}`, itemIndex)),
      }))
      const lists = Array.from({ length: listCount }, (_, listIndex) => ({
        id: `list_${listIndex}`,
        date: planDate(listIndex % planCount),
        listTemplateId: `list_template_${listIndex}`,
        createdAt: '2026-01-01T00:00:00Z',
        items: Array.from({ length: itemsPerList }, (_, itemIndex) => item(`list_${listIndex}`, itemIndex)),
      }))
      const goals = Array.from({ length: goalCount }, (_, goalIndex) => ({
        id: `goal_${goalIndex}`,
        name: `Goal ${goalIndex}`,
        nameHtml: `Goal ${goalIndex}`,
        cadenceDays: 3,
        matchTerms: [`term-${goalIndex}`, `alternate-${goalIndex}`],
        matchTermsHtml: `term-${goalIndex}, alternate-${goalIndex}`,
        hue: Math.floor((goalIndex * 360) / goalCount),
        lightness: 50,
        activityPeriods: [{ startDate: '2026-01-01', endDate: null }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }))
      const operations = Array.from({ length: operationCount }, (_, index) => ({
        id: `op_fixture_${index + 1}`,
        deviceId: 'device_interaction_perf',
        sequence: index + 1,
        type: 'fixture_operation',
        timestamp: '2026-01-01T00:00:00Z',
        payload: { index },
      }))
      const state = {
        schemaVersion: 1,
        deviceId: 'device_interaction_perf',
        localSequence: operationCount,
        historyRevision: 0,
        activePlanDate: activeDate,
        preferences: {
          themeId,
          doneTintColor: '',
          checkboxColor: '',
          databaseLoadingMessages: [],
        },
        templates: [],
        plans,
        listTemplates: [],
        lists,
        metrics: [],
        metricEntries: [],
        notes: [],
        goals,
        goalCompletions: [],
        operations,
      }

      localStorage.setItem('balance.appState.v1', JSON.stringify(state))

      // The production Tauri app persists only the coalesced operation through
      // native IPC. Disable the browser fallback's whole-state localStorage
      // write so this profile measures the same frontend update/render path.
      const originalSetItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'balance.appState.v1') return
        return originalSetItem.call(this, key, value)
      }
    },
    {
      planCount: PLAN_COUNT,
      itemsPerPlan: ITEMS_PER_PLAN,
      listCount: LIST_COUNT,
      itemsPerList: ITEMS_PER_LIST,
      goalCount: GOAL_COUNT,
      operationCount: EXISTING_OPERATION_COUNT,
      activeDate: ACTIVE_DATE,
      themeId: THEME_ID,
    },
  )
}

async function profileEdits(page: Page, selector: string, direction: 'type' | 'backspace', editCount = EDIT_COUNT) {
  return page.locator(selector).evaluate(
    async (element, { editCount, direction }) => {
      const editor = element as HTMLDivElement
      const samples: Sample[] = []
      editor.focus()

      for (let index = 0; index < editCount; index += 1) {
        if (direction === 'type') editor.textContent = `${editor.textContent ?? ''}x`
        else editor.textContent = (editor.textContent ?? '').slice(0, -1)

        const started = performance.now()
        editor.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          data: direction === 'type' ? 'x' : null,
          inputType: direction === 'type' ? 'insertText' : 'deleteContentBackward',
        }))
        const dispatched = performance.now()
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        samples.push({ dispatchMs: dispatched - started, paintMs: performance.now() - started })
      }

      return samples
    },
    { editCount, direction },
  )
}

async function profileIdleFrames(page: Page, durationMs = FRAME_SAMPLE_MS) {
  return page.evaluate(async (durationMs) => {
    const intervals: number[] = []
    await new Promise<void>((resolve) => {
      const started = performance.now()
      let previous = started
      const sample = (now: number) => {
        intervals.push(now - previous)
        previous = now
        if (now - started >= durationMs) resolve()
        else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    return intervals.slice(1)
  }, durationMs)
}

async function profileIdleRenderer(page: Page) {
  const session = await page.context().newCDPSession(page)
  await session.send('Performance.enable')
  const readMetrics = async () => {
    const result = await session.send('Performance.getMetrics') as {
      metrics: Array<{ name: string; value: number }>
    }
    return new Map(result.metrics.map(({ name, value }) => [name, value]))
  }
  const before = await readMetrics()
  const frameIntervals = await profileIdleFrames(page)
  const after = await readMetrics()
  await session.detach()

  const elapsedSeconds = (after.get('Timestamp') ?? 0) - (before.get('Timestamp') ?? 0)
  const durationMs = (name: string) => ((after.get(name) ?? 0) - (before.get(name) ?? 0)) * 1_000
  const taskDurationMs = durationMs('TaskDuration')
  return {
    frameIntervals,
    renderer: {
      elapsedMs: elapsedSeconds * 1_000,
      taskDurationMs,
      taskUtilizationPercent: elapsedSeconds > 0 ? taskDurationMs / (elapsedSeconds * 10) : 0,
      scriptDurationMs: durationMs('ScriptDuration'),
      layoutDurationMs: durationMs('LayoutDuration'),
      recalcStyleDurationMs: durationMs('RecalcStyleDuration'),
    },
  }
}

async function profileTaskActions(page: Page, editorSelector: string, clickCount = CLICK_COUNT) {
  return page.locator(editorSelector).evaluate(
    async (element, clickCount) => {
      const editor = element as HTMLDivElement
      const checkbox = editor.closest('.plan-row')?.querySelector<HTMLInputElement>('input.check')
      if (!checkbox) throw new Error('Could not find task checkbox')
      const focus: Sample[] = []
      const checkboxClicks: Sample[] = []

      for (let index = 0; index < clickCount; index += 1) {
        editor.blur()
        const focusStarted = performance.now()
        editor.focus()
        const focusDispatched = performance.now()
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        focus.push({ dispatchMs: focusDispatched - focusStarted, paintMs: performance.now() - focusStarted })

        const clickStarted = performance.now()
        checkbox.click()
        const clickDispatched = performance.now()
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        checkboxClicks.push({ dispatchMs: clickDispatched - clickStarted, paintMs: performance.now() - clickStarted })
      }

      return { focus, checkboxClicks, checked: checkbox.checked }
    },
    clickCount,
  )
}

async function profileImaxToggles(page: Page, toggleCount = 10) {
  return page.getByRole('button', { name: 'Enter IMAX mode' }).evaluate(
    async (element, toggleCount) => {
      const button = element as HTMLButtonElement
      const entering: Sample[] = []
      const exiting: Sample[] = []

      for (let index = 0; index < toggleCount; index += 1) {
        for (const [pressed, samples] of [[true, entering], [false, exiting]] as const) {
          const started = performance.now()
          button.click()
          const dispatched = performance.now()
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          if (button.getAttribute('aria-pressed') !== String(pressed)) {
            throw new Error(`Expected IMAX aria-pressed=${pressed}`)
          }
          samples.push({ dispatchMs: dispatched - started, paintMs: performance.now() - started })
        }
      }

      return { entering, exiting }
    },
    toggleCount,
  )
}

test.beforeEach(async ({ page }, testInfo) => {
  await installSyntheticWorkspace(page)
  if (testInfo.project.name.includes('6x-cpu')) {
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  }
  await page.goto('/')
  if (IRIDESCENT_MOTION_PROFILE === 'full-focused-borders') {
    await page.addStyleTag({ content: KEEP_ONLY_FOCUSED_BORDER_MOTION })
  } else if (IRIDESCENT_MOTION_PROFILE !== 'full') {
    const selectedMotion = IRIDESCENT_MOTION_STYLES[IRIDESCENT_MOTION_PROFILE]
    if (selectedMotion === undefined) {
      throw new Error(`Unknown Iridescent motion profile: ${IRIDESCENT_MOTION_PROFILE}`)
    }
    await page.addStyleTag({ content: `${DISABLE_IRIDESCENT_MOTION}\n${selectedMotion}` })
  }
  await expect(page.locator(EDITOR_SELECTOR)).toBeVisible()
})

test('profiles common typing and backspacing paths', async ({ page }, testInfo) => {
  await page.locator(EDITOR_SELECTOR).focus()
  const motionAnimations = await page.evaluate(() => {
    const activeNav = document.querySelector<HTMLElement>('.sidebar nav button.active')!
    const focusedEditor = document.querySelector<HTMLElement>('.plan-row .item-text:focus')!
    const taskList = focusedEditor.closest('.list-panel') as HTMLElement
    const brand = document.querySelector<HTMLElement>('.sidebar-brand-heading h1')!
    const pseudoAnimation = (element: HTMLElement) => {
      const styles = getComputedStyle(element, '::after')
      return {
        name: styles.animationName,
        timingFunction: styles.animationTimingFunction,
      }
    }
    return {
      background: getComputedStyle(document.body, '::before').animationName,
      sidebar: getComputedStyle(document.querySelector<HTMLElement>('.sidebar')!).animationName,
      border: getComputedStyle(focusedEditor, '::after').animationName,
      sidebarBorder: pseudoAnimation(activeNav),
      focusedTaskBorder: pseudoAnimation(focusedEditor),
      taskListBorder: pseudoAnimation(taskList),
      activeNav: getComputedStyle(activeNav).animationName,
      brand: getComputedStyle(brand).animationName,
    }
  })
  const idle = await profileIdleRenderer(page)
  const taskActions = await profileTaskActions(page, EDITOR_SELECTOR)
  const typing = await profileEdits(page, EDITOR_SELECTOR, 'type')
  const backspacing = await profileEdits(page, EDITOR_SELECTOR, 'backspace')
  const profile = {
    project: testInfo.project.name,
    fixture: {
      plans: PLAN_COUNT,
      planItems: PLAN_COUNT * ITEMS_PER_PLAN,
      lists: LIST_COUNT,
      listItems: LIST_COUNT * ITEMS_PER_LIST,
      goals: GOAL_COUNT,
      existingOperations: EXISTING_OPERATION_COUNT,
      themeId: THEME_ID,
      iridescentMotionProfile: IRIDESCENT_MOTION_PROFILE,
      motionAnimations,
    },
    idleFrameIntervals: summarizeDurations(idle.frameIntervals),
    idleRenderer: idle.renderer,
    taskFocus: summarize(taskActions.focus),
    checkboxClick: summarize(taskActions.checkboxClicks),
    typing: summarize(typing),
    backspacing: summarize(backspacing),
  }

  console.log(`INTERACTION_PERF ${JSON.stringify(profile)}`)
  await testInfo.attach(`interaction-performance-${testInfo.project.name}.json`, {
    body: JSON.stringify(profile, null, 2),
    contentType: 'application/json',
  })
  const paintP95BudgetMs = testInfo.project.name.includes('6x-cpu') ? 1_200 : 200
  if (!process.env.BALANCE_INTERACTION_PERF_PROFILE_ONLY) {
    expect(profile.taskFocus.paint.p95Ms).toBeLessThan(paintP95BudgetMs)
    expect(profile.checkboxClick.paint.p95Ms).toBeLessThan(paintP95BudgetMs)
    expect(profile.typing.paint.p95Ms).toBeLessThan(paintP95BudgetMs)
    expect(profile.backspacing.paint.p95Ms).toBeLessThan(paintP95BudgetMs)
  }
  await expect(page.locator(EDITOR_SELECTOR)).toContainText('task')
})

test('profiles goal-name edits that legitimately change the goal collection', async ({ page }, testInfo) => {
  if (testInfo.project.name.includes('android-like')) {
    await page.getByRole('button', { name: 'Open navigation' }).click()
  }
  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  const selector = '[data-rich-text-input-id="goal-name:goal_0"]'
  await expect(page.locator(selector)).toBeVisible()

  const typing = await profileEdits(page, selector, 'type', GOAL_EDIT_COUNT)
  const backspacing = await profileEdits(page, selector, 'backspace', GOAL_EDIT_COUNT)
  const profile = {
    project: testInfo.project.name,
    goals: GOAL_COUNT,
    typing: summarize(typing),
    backspacing: summarize(backspacing),
  }

  console.log(`GOAL_INTERACTION_PERF ${JSON.stringify(profile)}`)
  await testInfo.attach(`goal-interaction-performance-${testInfo.project.name}.json`, {
    body: JSON.stringify(profile, null, 2),
    contentType: 'application/json',
  })
  const paintP95BudgetMs = testInfo.project.name.includes('6x-cpu') ? 1_200 : 250
  if (!process.env.BALANCE_INTERACTION_PERF_PROFILE_ONLY) {
    expect(profile.typing.paint.p95Ms).toBeLessThan(paintP95BudgetMs)
    expect(profile.backspacing.paint.p95Ms).toBeLessThan(paintP95BudgetMs)
  }
})

test('profiles entering and exiting IMAX mode', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('android-like'), 'IMAX is desktop-only')

  const samples = await profileImaxToggles(page, IMAX_TOGGLE_COUNT)
  const profile = {
    project: testInfo.project.name,
    goals: GOAL_COUNT,
    entering: summarize(samples.entering),
    exiting: summarize(samples.exiting),
  }

  console.log(`IMAX_INTERACTION_PERF ${JSON.stringify(profile)}`)
  await testInfo.attach(`imax-interaction-performance-${testInfo.project.name}.json`, {
    body: JSON.stringify(profile, null, 2),
    contentType: 'application/json',
  })
  if (!process.env.BALANCE_IMAX_PERF_PROFILE_ONLY) {
    expect(profile.exiting.paint.medianMs).toBeLessThan(250)
  }
})
