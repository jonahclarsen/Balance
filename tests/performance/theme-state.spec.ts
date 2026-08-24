import { expect, test, type Page } from '@playwright/test'

type ThemePerformanceRuntime = typeof globalThis & {
  __balanceThemeStorageWrites?: Record<string, number>
  __balanceSuppressAppStateWrites?: boolean
}

const STARTUP_WARMUPS = 5
const STARTUP_SAMPLES = 40
const NO_OP_BATCHES = 40
const NO_OP_CALLS_PER_BATCH = 250

function stats(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right)
  const percentile = (fraction: number) => sorted[Math.ceil((sorted.length - 1) * fraction)]
  return {
    medianMs: percentile(0.50),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1)!,
  }
}

async function useSixTimesCpuSlowdown(page: Page) {
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setCPUThrottlingRate', { rate: 6 })
}

test('device theme bootstrap stays effectively instant across repeated startups', async ({ page }) => {
  await useSixTimesCpuSlowdown(page)
  await page.addInitScript(() => {
    localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({
      version: 1,
      themeId: 'random',
      randomThemeStartDate: '',
      doneTintColor: '',
      checkboxColor: '',
      iridescentGradient: {
        contrast: 100,
        backgroundSaturation: 100,
        backgroundLightness: 0,
        angle: 145,
        reach: 34,
        colors: [
          { hue: 330, saturation: 85, lightness: 62, strength: 13 },
          { hue: 188, saturation: 66, lightness: 53, strength: 14 },
          { hue: 37, saturation: 84, lightness: 59, strength: 13 },
        ],
      },
    }))
  })

  const samples: number[] = []
  for (let index = 0; index < STARTUP_WARMUPS + STARTUP_SAMPLES; index += 1) {
    await page.goto('/')
    const duration = await page.evaluate(() => {
      const entry = performance.getEntriesByName('balance-device-theme-bootstrap').at(-1)
      if (!entry) throw new Error('Missing device-theme bootstrap performance measure')
      return entry.duration
    })
    if (index >= STARTUP_WARMUPS) samples.push(duration)
  }

  const profile = {
    kind: 'startup-bootstrap',
    cpuSlowdown: 6,
    warmups: STARTUP_WARMUPS,
    samples: STARTUP_SAMPLES,
    ...stats(samples),
  }
  console.log(`THEME_PERF ${JSON.stringify(profile)}`)
  expect(profile.p95Ms).toBeLessThan(10)
})

test('today observation stays cheap with 3,264 historical themes', async ({ page }) => {
  await useSixTimesCpuSlowdown(page)
  await page.addInitScript(() => {
    localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({
      version: 1,
      themeId: 'graphite',
      randomThemeStartDate: '',
      doneTintColor: '',
      checkboxColor: '',
    }))
    const runtime = globalThis as ThemePerformanceRuntime
    runtime.__balanceThemeStorageWrites = {}
    const originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      const writes = runtime.__balanceThemeStorageWrites!
      writes[key] = (writes[key] ?? 0) + 1
      if (key === 'balance.appState.v1' && runtime.__balanceSuppressAppStateWrites) return
      return originalSetItem.call(this, key, value)
    }
  })
  await page.goto('/')

  await page.evaluate(() => {
    const key = 'balance.appState.v1'
    const state = JSON.parse(localStorage.getItem(key) ?? 'null')
    const started = new Date('2000-01-01T12:00:00Z')
    for (let index = 0; index < 3_264; index += 1) {
      const date = new Date(started.getTime() + index * 86_400_000).toISOString().slice(0, 10)
      state.preferences[`dayTheme/${date}`] = index % 2 === 0 ? 'graphite' : 'pink'
    }
    localStorage.setItem(key, JSON.stringify(state))
  })
  await page.reload()

  const dailyPlan = page.getByRole('region', { name: 'Daily plan' })
  await expect(dailyPlan).toBeVisible()
  const date = await dailyPlan.locator('.date-input').inputValue()
  await expect.poll(() => page.evaluate((day) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') ?? 'null')
    return state?.preferences?.[`dayTheme/${day}`]
  }, date)).toBe('graphite')

  const profile = await page.evaluate(async ({ date, batches, callsPerBatch }) => {
    const runtime = globalThis as ThemePerformanceRuntime
    const loadStore = new Function('return import("/src/lib/store.ts")') as () => Promise<{
      plannerStore: {
        recordDayTheme: (day: string, themeId: string) => boolean
      }
    }>
    const { plannerStore } = await loadStore()
    let liveState: { localSequence: number; operations: Array<unknown> } | null = null
    const unsubscribe = plannerStore.subscribe((state) => {
      liveState = state
    })
    const sequenceBefore = liveState!.localSequence
    runtime.__balanceThemeStorageWrites = {}

    const samples: number[] = []
    let reportedChanges = 0
    for (let batch = 0; batch < batches; batch += 1) {
      const started = performance.now()
      for (let call = 0; call < callsPerBatch; call += 1) {
        if (plannerStore.recordDayTheme(date, 'graphite')) reportedChanges += 1
      }
      samples.push((performance.now() - started) / callsPerBatch)
    }

    const appStateWrites = runtime.__balanceThemeStorageWrites?.['balance.appState.v1'] ?? 0
    runtime.__balanceSuppressAppStateWrites = true
    const changedStarted = performance.now()
    const changed = plannerStore.recordDayTheme('2099-01-01', 'ocean')
    const changedCommitMs = performance.now() - changedStarted
    runtime.__balanceSuppressAppStateWrites = false
    const latestOperation = liveState!.operations.at(-1)
    unsubscribe()
    return {
      samples,
      calls: batches * callsPerBatch,
      reportedChanges,
      operationDelta: liveState!.localSequence - sequenceBefore - (changed ? 1 : 0),
      appStateWrites,
      historicalDayThemes: 3_264,
      changedCommitMs,
      changedOperationBytes: JSON.stringify(latestOperation).length,
      changedOperationDelta: changed ? 1 : 0,
    }
  }, { date, batches: NO_OP_BATCHES, callsPerBatch: NO_OP_CALLS_PER_BATCH })

  const output = {
    kind: 'today-theme-no-op',
    cpuSlowdown: 6,
    calls: profile.calls,
    ...stats(profile.samples),
    reportedChanges: profile.reportedChanges,
    operationDelta: profile.operationDelta,
    appStateWrites: profile.appStateWrites,
    networkOperations: profile.operationDelta,
    historicalDayThemes: profile.historicalDayThemes,
    changedCommitMs: profile.changedCommitMs,
    changedOperationBytes: profile.changedOperationBytes,
    changedOperationDelta: profile.changedOperationDelta,
  }
  console.log(`THEME_PERF ${JSON.stringify(output)}`)
  expect(output.reportedChanges).toBe(0)
  expect(output.operationDelta).toBe(0)
  expect(output.appStateWrites).toBe(0)
  expect(output.p95Ms).toBeLessThan(0.1)
  expect(output.changedOperationDelta).toBe(1)
  expect(output.changedCommitMs).toBeLessThan(25)
})
