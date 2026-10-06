import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Measures moving between day pages with a large synthetic workspace. Every
// value here is generated; nothing reads a real database.
const PLAN_COUNT = performanceSize('BALANCE_DAY_NAV_PLANS', 730)
const ITEMS_PER_PLAN = performanceSize('BALANCE_DAY_NAV_ITEMS_PER_PLAN', 24)
const LIST_COUNT = performanceSize('BALANCE_DAY_NAV_LISTS', 365)
const GOAL_COUNT = performanceSize('BALANCE_DAY_NAV_GOALS', 40)
const NOTE_COUNT = performanceSize('BALANCE_DAY_NAV_NOTES', 60)
const STEP_COUNT = performanceSize('BALANCE_DAY_NAV_STEPS', 30)
const ROUNDS = performanceSize('BALANCE_DAY_NAV_ROUNDS', 2)
const THEME_ID = process.env.BALANCE_DAY_NAV_THEME ?? 'graphite'
const REPORT_DIR = process.env.BALANCE_DAY_NAV_REPORT_DIR ?? 'artifacts/day-navigation-performance'
const REVISION = process.env.BALANCE_DAY_NAV_REVISION ?? 'local'
// The app opens on the current Balance day (which starts at 5 a.m.), so the
// synthetic workspace is centered on it instead of a fixed date.
const ACTIVE_DATE = balanceToday()

function balanceToday() {
  const now = new Date(Date.now() - 5 * 60 * 60 * 1000)
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function performanceSize(variable: string, fallback: number) {
  const value = Number(process.env[variable])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

function summarize(values: number[]) {
  return {
    count: values.length,
    medianMs: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(Math.max(...values)),
  }
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

async function installSyntheticWorkspace(page: Page) {
  await page.addInitScript(
    ({ planCount, itemsPerPlan, listCount, goalCount, noteCount, activeDate, themeId }) => {
      const shift = (days: number) => {
        const date = new Date(`${activeDate}T12:00:00Z`)
        date.setUTCDate(date.getUTCDate() + days)
        return date.toISOString().slice(0, 10)
      }
      // Plans cover the past and a few future days so navigation crosses
      // generated days in both directions.
      const planDate = (index: number) => shift(index - (planCount - 8))
      const item = (prefix: string, index: number, depth = 0): any => {
        const goalTerm = index % 3 === 0 ? ` term-${index % goalCount}` : ''
        const text = `${prefix} task ${index}${goalTerm}`
        const timed = depth === 0 && index % 4 === 1
        return {
          id: `${prefix}_item_${index}`,
          text,
          html: text,
          done: index % 4 === 0,
          startMinutes: timed ? 480 + index * 15 : null,
          endMinutes: timed ? 495 + index * 15 : null,
          children: depth === 0 && index % 5 === 0
            ? Array.from({ length: 3 }, (_, child) => item(`${prefix}_item_${index}`, child, depth + 1))
            : [],
        }
      }
      const plans = Array.from({ length: planCount }, (_, planIndex) => ({
        id: `plan_${planIndex}`,
        date: planDate(planIndex),
        title: `Plan ${planIndex}`,
        dailyReminder: '',
        generatedFromTemplateId: 'template_0',
        createdAt: '2026-01-01T00:00:00Z',
        items: Array.from({ length: itemsPerPlan }, (_, itemIndex) => item(`plan_${planIndex}`, itemIndex)),
      }))
      const listTemplates = Array.from({ length: 3 }, (_, index) => ({
        id: `list_template_${index}`,
        name: `List ${index}`,
        maxExpectedWords: 0,
        items: [],
        archivedItems: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }))
      const lists = Array.from({ length: listCount }, (_, listIndex) => ({
        id: `list_${listIndex}`,
        date: planDate(planCount - 1 - Math.floor(listIndex / 3)),
        listTemplateId: `list_template_${listIndex % 3}`,
        createdAt: '2026-01-01T00:00:00Z',
        items: Array.from({ length: 12 }, (_, itemIndex) => item(`list_${listIndex}`, itemIndex)),
      }))
      const goals = Array.from({ length: goalCount }, (_, goalIndex) => ({
        id: `goal_${goalIndex}`,
        name: `Goal ${goalIndex}`,
        nameHtml: `Goal ${goalIndex}`,
        cadenceDays: 1 + (goalIndex % 7),
        matchTerms: [`term-${goalIndex}`],
        matchTermsHtml: `term-${goalIndex}`,
        hue: Math.floor((goalIndex * 360) / goalCount),
        lightness: 50,
        activityPeriods: [{ startDate: '2024-01-01', endDate: null }],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }))
      const goalCompletions = plans.flatMap((plan, planIndex) => plan.items
        .filter((entry: any, index: number) => entry.done && index % 3 === 0)
        .map((entry: any) => ({
          goalId: `goal_${Number(entry.text.split('term-')[1]) % goalCount}`,
          date: plan.date,
          itemIds: [entry.id],
          matchedTerms: [entry.text.split(' ').at(-1)],
          computedAt: `2026-01-01T00:00:${String(planIndex % 60).padStart(2, '0')}Z`,
        })))
      const notes = Array.from({ length: noteCount }, (_, noteIndex) => ({
        id: `note_${noteIndex}`,
        title: `Note ${noteIndex}`,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        items: Array.from({ length: 30 }, (_, itemIndex) => ({
          id: `note_${noteIndex}_${itemIndex}`,
          kind: 'paragraph',
          text: `Synthetic paragraph ${itemIndex}`,
          html: `Synthetic paragraph ${itemIndex}`,
          done: false,
          children: [],
        })),
      }))
      const templates = [{
        id: 'template_0',
        name: 'Weekday',
        items: Array.from({ length: itemsPerPlan }, (_, itemIndex) => ({
          id: `template_0_item_${itemIndex}`,
          startMinutes: null,
          endMinutes: null,
          options: [{ id: `template_0_option_${itemIndex}`, text: `Template task ${itemIndex}`, html: `Template task ${itemIndex}`, probability: 1 }],
          children: [],
        })),
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }]
      const state = {
        schemaVersion: 1,
        deviceId: 'device_day_navigation_perf',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: activeDate,
        preferences: { themeId, doneTintColor: '', checkboxColor: '', databaseLoadingMessages: [] },
        templates,
        plans,
        listTemplates,
        lists,
        metrics: [],
        metricEntries: [],
        notes,
        goals,
        goalCompletions,
        operations: [],
      }
      // A year or two of days exceeds the browser storage quota, so serve the
      // workspace through a stand-in for the desktop app's native bridge. This
      // also exercises the same store path as the macOS app.
      const stateJson = JSON.stringify(state)
      const runtime = window as any
      runtime.isTauri = true
      runtime.__TAURI_INTERNALS__ = {
        invoke: async (command: string) => {
          if (command === 'read_app_state') return stateJson
          if (command === 'get_recovery_key_status') return { confirmed: true, recoveryKey: null, databasePath: '/synthetic/fixture.sqlite3' }
          if (command === 'get_sync_settings') return { enabled: false, pairingCode: null, relayUrl: '' }
          if (command === 'get_database_maintenance_status') return { due: false, operationCount: 0, operationBytes: 0, checkpointRecommended: false }
          if (command === 'get_export_settings') return { autoJsonExportEnabled: false, exportDirectory: '/synthetic', defaultExportDirectory: '/synthetic' }
          if (command === 'build_info') return { version: 'test', commit: 'synthetic' }
          if (command === 'pending_deep_links') return []
          if (command === 'persist_operations' || command === 'persist_operation') return true
          return null
        },
        transformCallback: () => 1,
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      }
      runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
    },
    {
      planCount: PLAN_COUNT,
      itemsPerPlan: ITEMS_PER_PLAN,
      listCount: LIST_COUNT,
      goalCount: GOAL_COUNT,
      noteCount: NOTE_COUNT,
      activeDate: ACTIVE_DATE,
      themeId: THEME_ID,
    },
  )
}

// Sends the desktop Option-Q / Option-W shortcuts inside the page so Playwright
// IPC latency is excluded. "Painted" waits for the frame after the update.
async function profileDaySteps(page: Page, steps: number) {
  return page.evaluate(async (steps) => {
    const samples: { dispatchMs: number; paintMs: number }[] = []
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    for (let index = 0; index < steps; index += 1) {
      // Walk back across generated days, then forward across the boundary
      // into ungenerated future days.
      const code = index < steps / 2 ? 'KeyQ' : 'KeyW'
      const dateBefore = document.querySelector<HTMLInputElement>('input.today-date-input')?.value
      const started = performance.now()
      window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'KeyQ' ? 'œ' : '∑', altKey: true, bubbles: true, cancelable: true }))
      const dispatched = performance.now()
      await frame()
      const dateAfter = document.querySelector<HTMLInputElement>('input.today-date-input')?.value
      if (!dateAfter || dateAfter === dateBefore) throw new Error(`Day did not change from ${dateBefore}`)
      samples.push({ dispatchMs: dispatched - started, paintMs: performance.now() - started })
    }
    return samples
  }, steps)
}

type ProfileNode = {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  hitCount?: number
  children?: number[]
}

function summarizeCpuProfile(profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }) {
  const selfMicros = new Map<number, number>()
  profile.samples.forEach((id, index) => selfMicros.set(id, (selfMicros.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0)))
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const label = (node: ProfileNode) => {
    const file = node.callFrame.url.split('/').slice(-1)[0]?.split('?')[0] || '(native)'
    return `${node.callFrame.functionName || '(anonymous)'} ${file}:${node.callFrame.lineNumber + 1}`
  }
  const self = new Map<string, number>()
  const total = new Map<string, number>()
  for (const [id, micros] of selfMicros) {
    const node = byId.get(id)
    if (!node) continue
    self.set(label(node), (self.get(label(node)) ?? 0) + micros)
    const seen = new Set<string>()
    for (let cursor: number | undefined = id; cursor !== undefined; cursor = parent.get(cursor)) {
      const name = label(byId.get(cursor)!)
      if (seen.has(name)) continue
      seen.add(name)
      total.set(name, (total.get(name) ?? 0) + micros)
    }
  }
  const top = (map: Map<string, number>) => [...map]
    .filter(([name]) => !name.startsWith('(idle)') && !name.startsWith('(root)') && !name.startsWith('(program)'))
    .sort((left, right) => right[1] - left[1])
    .slice(0, 40)
    .map(([name, micros]) => ({ name, ms: round(micros / 1000) }))
  return { selfTop: top(self), totalTop: top(total) }
}

test('profiles moving between day pages', async ({ page, browserName }, testInfo) => {
  test.setTimeout(240_000)
  page.on('pageerror', (error) => console.log(`DAY_NAVIGATION_PAGE_ERROR ${error.message}`))
  page.on('console', (message) => { if (message.type() === 'error') console.log(`DAY_NAVIGATION_CONSOLE ${message.text()}`) })
  await installSyntheticWorkspace(page)
  await page.goto('/')
  await expect(page.locator(`[data-plan-text-input-id="plan_${PLAN_COUNT - 8}_item_1"]`)).toBeVisible({ timeout: 60_000 })
  // Let startup work settle before measuring.
  await page.waitForTimeout(1_500)

  // Warm up the code paths so JIT tiering is comparable between revisions.
  await profileDaySteps(page, 6)

  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null
  const metrics = async () => {
    if (!cdp) return new Map<string, number>()
    const result = await cdp.send('Performance.getMetrics') as { metrics: { name: string; value: number }[] }
    return new Map(result.metrics.map(({ name, value }) => [name, value]))
  }
  if (cdp) {
    await cdp.send('Performance.enable')
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
    await cdp.send('Profiler.start')
  }
  const before = await metrics()
  const samples: { dispatchMs: number; paintMs: number }[] = []
  for (let roundIndex = 0; roundIndex < ROUNDS; roundIndex += 1) samples.push(...await profileDaySteps(page, STEP_COUNT))
  const after = await metrics()
  let cpu: ReturnType<typeof summarizeCpuProfile> | null = null
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop') as any
    mkdirSync(REPORT_DIR, { recursive: true })
    writeFileSync(join(REPORT_DIR, `${REVISION}-${testInfo.project.name}.cpuprofile`), JSON.stringify(profile))
    cpu = summarizeCpuProfile(profile)
  }
  const delta = (name: string) => round(((after.get(name) ?? 0) - (before.get(name) ?? 0)) * 1000)
  const report = {
    revision: REVISION,
    project: testInfo.project.name,
    browser: browserName,
    workspace: { plans: PLAN_COUNT, itemsPerPlan: ITEMS_PER_PLAN, lists: LIST_COUNT, goals: GOAL_COUNT, notes: NOTE_COUNT },
    steps: samples.length,
    dispatch: summarize(samples.map((sample) => sample.dispatchMs)),
    paint: summarize(samples.map((sample) => sample.paintMs)),
    paintSamplesMs: samples.map((sample) => round(sample.paintMs)),
    renderer: cdp ? {
      scriptMs: delta('ScriptDuration'),
      recalcStyleMs: delta('RecalcStyleDuration'),
      layoutMs: delta('LayoutDuration'),
      taskMs: delta('TaskDuration'),
    } : null,
    cpu,
  }
  mkdirSync(REPORT_DIR, { recursive: true })
  writeFileSync(join(REPORT_DIR, `${REVISION}-${testInfo.project.name}.json`), JSON.stringify(report, null, 2))
  console.log(`DAY_NAVIGATION_PERF ${JSON.stringify({ ...report, cpu: undefined })}`)
  if (cpu) {
    console.log('Top self time:')
    for (const entry of cpu.selfTop.slice(0, 25)) console.log(`  ${entry.ms.toFixed(1).padStart(8)} ms  ${entry.name}`)
    console.log('Top total time:')
    for (const entry of cpu.totalTop.slice(0, 25)) console.log(`  ${entry.ms.toFixed(1).padStart(8)} ms  ${entry.name}`)
  }
  expect(samples.length).toBe(STEP_COUNT * ROUNDS)
})
