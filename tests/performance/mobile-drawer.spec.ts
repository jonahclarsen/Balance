import { expect, test, type Page } from '@playwright/test'

const PLAN_COUNT = performanceSize('BALANCE_MOBILE_DRAWER_PERF_PLANS', 365)
const ITEMS_PER_PLAN = performanceSize('BALANCE_MOBILE_DRAWER_PERF_ITEMS_PER_PLAN', 20)
const GOAL_COUNT = performanceSize('BALANCE_MOBILE_DRAWER_PERF_GOALS', 80)
const CYCLE_COUNT = performanceSize('BALANCE_MOBILE_DRAWER_PERF_CYCLES', 12)
const IDLE_SAMPLE_MS = performanceSize('BALANCE_MOBILE_DRAWER_PERF_IDLE_MS', 1_200)
const OPEN_SAMPLE_MS = performanceSize('BALANCE_MOBILE_DRAWER_PERF_OPEN_MS', 300)
const CLOSE_SAMPLE_MS = performanceSize('BALANCE_MOBILE_DRAWER_PERF_CLOSE_MS', 260)
const TAP_HOLD_MS = performanceSize('BALANCE_MOBILE_DRAWER_PERF_TAP_HOLD_MS', 50)
const THEME_ID = process.env.BALANCE_MOBILE_DRAWER_PERF_THEME ?? 'iridescent'
const ACTIVE_DATE = '2026-08-16'

type ActionSample = {
  dispatchMs: number
  firstPaintMs: number
  firstMovementMs: number
  tenPercentMs: number
  halfwayMs: number
  settleMs: number
  frameIntervals: number[]
}

function performanceSize(variable: string, fallback: number) {
  const value = Number(process.env[variable])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

function summarizeDurations(values: number[]) {
  return {
    count: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(0, ...values),
  }
}

function summarizeActions(samples: ActionSample[]) {
  return {
    count: samples.length,
    dispatch: summarizeDurations(samples.map((sample) => sample.dispatchMs)),
    firstPaint: summarizeDurations(samples.map((sample) => sample.firstPaintMs)),
    firstMovement: summarizeDurations(samples.map((sample) => sample.firstMovementMs)),
    tenPercent: summarizeDurations(samples.map((sample) => sample.tenPercentMs)),
    halfway: summarizeDurations(samples.map((sample) => sample.halfwayMs)),
    settle: summarizeDurations(samples.map((sample) => sample.settleMs)),
    frameIntervals: summarizeDurations(samples.flatMap((sample) => sample.frameIntervals)),
    framesOver32Ms: samples.flatMap((sample) => sample.frameIntervals).filter((duration) => duration > 32).length,
    framesOver50Ms: samples.flatMap((sample) => sample.frameIntervals).filter((duration) => duration > 50).length,
  }
}

async function installSyntheticWorkspace(page: Page) {
  await page.addInitScript(
    ({ planCount, itemsPerPlan, goalCount, activeDate, themeId }) => {
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
      const state = {
        schemaVersion: 1,
        deviceId: 'device_mobile_drawer_perf',
        localSequence: 1,
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
        lists: [],
        metrics: [],
        metricEntries: [],
        notes: [],
        goals,
        goalCompletions: [],
        operations: [{
          id: 'op_fixture_1',
          deviceId: 'device_mobile_drawer_perf',
          sequence: 1,
          type: 'fixture_operation',
          timestamp: '2026-01-01T00:00:00Z',
          payload: { synthetic: true },
        }],
      }

      localStorage.setItem('balance.appState.v1', JSON.stringify(state))
    },
    { planCount: PLAN_COUNT, itemsPerPlan: ITEMS_PER_PLAN, goalCount: GOAL_COUNT, activeDate: ACTIVE_DATE, themeId: THEME_ID },
  )
}

async function sampleFrames(page: Page, durationMs: number) {
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

function metricMap(metrics: Array<{ name: string; value: number }>) {
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]))
}

function rendererDelta(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  const milliseconds = (name: string) => ((after[name] ?? 0) - (before[name] ?? 0)) * 1_000
  return {
    taskDurationMs: milliseconds('TaskDuration'),
    scriptDurationMs: milliseconds('ScriptDuration'),
    layoutDurationMs: milliseconds('LayoutDuration'),
    recalcStyleDurationMs: milliseconds('RecalcStyleDuration'),
  }
}

test.beforeEach(async ({ page }, testInfo) => {
  await installSyntheticWorkspace(page)
  if (testInfo.project.name.includes('6x-cpu')) {
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  }
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Primary navigation drawer' })).toBeHidden()
})

test('profiles repeated mobile hamburger drawer openings', async ({ page }, testInfo) => {
  const session = await page.context().newCDPSession(page)
  await session.send('Performance.enable')
  const readMetrics = async () => metricMap((await session.send('Performance.getMetrics')).metrics)

  const closedIdleBefore = await readMetrics()
  const closedIdleFrames = await sampleFrames(page, IDLE_SAMPLE_MS)
  const closedIdleRenderer = rendererDelta(closedIdleBefore, await readMetrics())

  const cycleRendererBefore = await readMetrics()
  const actions = await page.evaluate(
    async ({ cycleCount, openSampleMs, closeSampleMs, tapHoldMs }) => {
      const menuButton = document.querySelector<HTMLButtonElement>('.mobile-menu-button')
      const closeButton = document.querySelector<HTMLButtonElement>('.mobile-drawer-close-button')
      const drawer = document.querySelector<HTMLElement>('.sidebar')
      const backdrop = document.querySelector<HTMLElement>('.mobile-drawer-backdrop')
      if (!menuButton || !closeButton || !drawer || !backdrop) throw new Error('Missing mobile drawer controls')

      const longTasks: number[] = []
      const observer = typeof PerformanceObserver !== 'undefined'
        ? new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) longTasks.push(entry.duration)
          })
        : null
      observer?.observe({ type: 'longtask' })

      const measure = (
        button: HTMLButtonElement,
        sampleMs: number,
        direction: 'opening' | 'closing',
      ) => new Promise<ActionSample>((resolve) => {
        const drawerWidth = drawer.getBoundingClientRect().width
        const started = performance.now()
        if (direction === 'opening') {
          button.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            isPrimary: true,
            pointerId: 1,
            pointerType: 'touch',
          }))
          window.setTimeout(() => {
            button.dispatchEvent(new PointerEvent('pointerup', {
              bubbles: true,
              button: 0,
              isPrimary: true,
              pointerId: 1,
              pointerType: 'touch',
            }))
            button.click()
          }, tapHoldMs)
        } else {
          button.click()
        }
        const dispatched = performance.now()
        const intervals: number[] = []
        let previous = started
        let frameCount = 0
        let firstPaintMs = 0
        let firstMovementMs: number | null = null
        let tenPercentMs: number | null = null
        let halfwayMs: number | null = null
        let settleMs: number | null = null
        const sample = (now: number) => {
          intervals.push(now - previous)
          previous = now
          frameCount += 1
          const openProgress = Math.max(0, Math.min(1, 1 + drawer.getBoundingClientRect().left / drawerWidth))
          const actionProgress = direction === 'opening' ? openProgress : 1 - openProgress
          if (firstMovementMs == null && actionProgress >= 0.01) firstMovementMs = now - started
          if (tenPercentMs == null && actionProgress >= 0.1) tenPercentMs = now - started
          if (halfwayMs == null && actionProgress >= 0.5) halfwayMs = now - started
          if (frameCount === 1) {
            const transitions = [drawer, backdrop]
              .flatMap((element) => element.getAnimations())
              .filter((animation) => Number.isFinite(Number(animation.effect?.getComputedTiming().iterations)))
            if (transitions.length === 0) {
              settleMs = now - started
            } else {
              void Promise.allSettled(transitions.map((animation) => animation.finished)).then(() => {
                settleMs = performance.now() - started
              })
            }
          }
          if (frameCount === 2) firstPaintMs = now - started
          if (
            now - started >= sampleMs
            && frameCount >= 2
            && firstMovementMs != null
            && tenPercentMs != null
            && halfwayMs != null
            && settleMs != null
          ) {
            resolve({
              dispatchMs: dispatched - started,
              firstPaintMs,
              firstMovementMs,
              tenPercentMs,
              halfwayMs,
              settleMs,
              frameIntervals: intervals.slice(1),
            })
          } else {
            requestAnimationFrame(sample)
          }
        }
        requestAnimationFrame(sample)
      })

      const opening: ActionSample[] = []
      const closing: ActionSample[] = []
      for (let index = 0; index < cycleCount; index += 1) {
        opening.push(await measure(menuButton, openSampleMs, 'opening'))
        if (menuButton.getAttribute('aria-expanded') !== 'true') throw new Error('Drawer did not open')
        closing.push(await measure(closeButton, closeSampleMs, 'closing'))
        if (menuButton.getAttribute('aria-expanded') !== 'false') throw new Error('Drawer did not close')
      }
      observer?.disconnect()
      return { opening, closing, longTasks }
    },
    {
      cycleCount: CYCLE_COUNT,
      openSampleMs: OPEN_SAMPLE_MS,
      closeSampleMs: CLOSE_SAMPLE_MS,
      tapHoldMs: TAP_HOLD_MS,
    },
  )
  const cycleRenderer = rendererDelta(cycleRendererBefore, await readMetrics())

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.waitForTimeout(OPEN_SAMPLE_MS)
  const openIdleBefore = await readMetrics()
  const openIdleFrames = await sampleFrames(page, IDLE_SAMPLE_MS)
  const openIdleRenderer = rendererDelta(openIdleBefore, await readMetrics())
  await page.getByRole('complementary', { name: 'Primary navigation drawer' })
    .getByRole('button', { name: 'Close navigation' }).click()

  const profile = {
    project: testInfo.project.name,
    fixture: {
      plans: PLAN_COUNT,
      planItems: PLAN_COUNT * ITEMS_PER_PLAN,
      goals: GOAL_COUNT,
      themeId: THEME_ID,
      cycles: CYCLE_COUNT,
      tapHoldMs: TAP_HOLD_MS,
    },
    closedIdle: {
      sampleMs: IDLE_SAMPLE_MS,
      frameIntervals: summarizeDurations(closedIdleFrames),
      renderer: closedIdleRenderer,
    },
    opening: summarizeActions(actions.opening),
    closing: summarizeActions(actions.closing),
    cycles: {
      renderer: cycleRenderer,
      rendererTaskMsPerOpenClose: cycleRenderer.taskDurationMs / CYCLE_COUNT,
      longTasks: summarizeDurations(actions.longTasks),
      longTaskTotalMs: actions.longTasks.reduce((total, duration) => total + duration, 0),
    },
    openIdle: {
      sampleMs: IDLE_SAMPLE_MS,
      frameIntervals: summarizeDurations(openIdleFrames),
      renderer: openIdleRenderer,
    },
  }

  console.log(`MOBILE_DRAWER_PERF ${JSON.stringify(profile)}`)
  await testInfo.attach(`mobile-drawer-performance-${testInfo.project.name}.json`, {
    body: JSON.stringify(profile, null, 2),
    contentType: 'application/json',
  })
  await expect(page.getByRole('complementary', { name: 'Primary navigation drawer' })).toBeHidden()
})
