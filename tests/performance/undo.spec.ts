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

      localStorage.setItem('balance:activePlanDate', performanceDate(planCount - 1))
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

for (const reloaded of [false, true]) {
  test(`native undo and redo reveal the item ${reloaded ? 'after a backend reload' : 'using cached history'}`, async ({ page }) => {
    await page.addInitScript(() => {
      type Runtime = typeof globalThis & {
        isTauri: boolean
        __historyCalls: Array<{ command: string; expectedOperationId: unknown }>
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: string }; currentWebview: { label: string } }
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
          transformCallback: () => number
        }
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void }
      }
      const runtime = globalThis as Runtime
      const state = {
        schemaVersion: 1,
        deviceId: 'device_native_test',
        localSequence: 1,
        historyRevision: 0,
        activePlanDate: '2026-08-16',
        templates: [],
        plans: [{
          id: 'plan_today',
          date: '2026-08-16',
          title: 'Today',
          dailyReminder: '',
          generatedFromTemplateId: null,
          createdAt: '2026-08-16T00:00:00Z',
          items: [{
            id: 'plan_item_native',
            text: 'Original text',
            html: 'Original text',
            done: false,
            startMinutes: null,
            endMinutes: null,
            children: [],
          }],
        }],
        listTemplates: [],
        lists: [],
        metrics: [],
        metricEntries: [],
        notes: [],
        goals: [],
        goalCompletions: [],
        operations: [],
      }
      localStorage.setItem('balance:activePlanDate', '2026-08-16')
      let persistedOperation: { id: string; sequence: number; payload: { patch: { text: string; html: string } } } | null = null
      runtime.isTauri = true
      runtime.__historyCalls = []
      runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
      runtime.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => 1,
        invoke: async (command, args) => {
          switch (command) {
            case 'read_app_state':
              return JSON.stringify(state)
            case 'persist_operation':
              persistedOperation = JSON.parse(String(args?.operationJson))
              Object.assign(state.plans[0].items[0], persistedOperation!.payload.patch)
              return null
            case 'undo_last_operation':
            case 'redo_last_operation': {
              const operation = persistedOperation as { id: string; sequence: number } | null
              if (!operation) throw new Error('History command ran before persistence')
              runtime.__historyCalls.push({ command, expectedOperationId: args?.expectedOperationId })
              return JSON.stringify({
                operationId: operation.id,
                localSequence: operation.sequence + runtime.__historyCalls.length,
                operationType: 'patch_plan_item',
                state: new URLSearchParams(location.search).has('reload-history')
                  ? { ...state, plans: [{ ...state.plans[0], items: [{ ...state.plans[0].items[0], text: command === 'undo_last_operation' ? 'Original text' : 'Changed text', html: command === 'undo_last_operation' ? 'Original text' : 'Changed text' }] }] }
                  : null,
                canRedo: command === 'undo_last_operation',
              })
            }
            case 'get_recovery_key_status':
              return { confirmed: true, recoveryKey: null, databasePath: '/tmp/synthetic-native.sqlite3' }
            case 'get_export_settings':
              return {
                exportDirectory: '/tmp',
                defaultExportDirectory: '/tmp',
                usesDefaultExportDirectory: true,
                autoJsonExportEnabled: false,
                autoJsonExportTime: '23:55',
                lastAutoJsonExportDate: null,
                lastAutoJsonExportPath: null,
                lastAutoJsonExportError: null,
                lastAutoJsonExportErrorAt: null,
                autoJsonExportErrorAckAt: null,
              }
            case 'get_sync_settings':
              return { enabled: false, pairingCode: null, relayUrl: '' }
            case 'get_database_maintenance_status':
              return {
                due: false,
                lastCompletedAt: null,
                checkpointCoordinator: true,
                databaseBytes: 0,
                reclaimableBytes: 0,
                reclaimablePercent: 0,
                operationCount: 0,
                operationBytes: 0,
                checkpointRecommended: false,
              }
            case 'build_info':
              return { version: 'test', commit: 'test' }
            default:
              return null
          }
        },
      }
    })

    await page.goto(reloaded ? '/?reload-history=1' : '/')
    const editor = page.locator('[data-plan-text-input]').first()
    await expect(editor).toHaveText('Original text')
    await editor.evaluate((element) => {
      ;(element as HTMLElement).focus()
      element.textContent = 'Changed text'
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Changed text' }))
    })
    await expect(editor).toHaveText('Changed text')
    if (reloaded) {
      await page.evaluate(async () => {
        const modulePath = '/src/lib/store.ts'
        const { plannerStore } = await import(/* @vite-ignore */ modulePath)
        await plannerStore.reloadFromBackend()
        plannerStore.setActivePlanDate('2026-08-17')
      })
    }

    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })))
    await expect.poll(() => page.evaluate(() => {
      const runtime = globalThis as typeof globalThis & {
        __historyCalls: Array<{ command: string; expectedOperationId: unknown }>
      }
      return runtime.__historyCalls
    })).toHaveLength(1)
    await expect.poll(() => page.evaluate(() => {
      const runtime = globalThis as typeof globalThis & {
        __historyCalls: Array<{ command: string; expectedOperationId: unknown }>
      }
      return runtime.__historyCalls[0]?.expectedOperationId
    })).toBe(reloaded ? null : 'op_device_native_test_2')
    await expect(editor).toHaveText('Original text')
    await expect(page.getByLabel('Day date', { exact: true })).toHaveValue('2026-08-16')
    await expect(page.locator('[data-plan-item-id]').first()).toBeInViewport()
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })))
    await expect(editor).toHaveText('Changed text')

    const calls = await page.evaluate(() => {
      const runtime = globalThis as typeof globalThis & {
        __historyCalls: Array<{ command: string; expectedOperationId: unknown }>
      }
      return runtime.__historyCalls
    })
    expect(calls).toHaveLength(2)
    expect(calls[0].command).toBe('undo_last_operation')
    expect(calls[0].expectedOperationId).toBe(reloaded ? null : 'op_device_native_test_2')
    expect(calls[1]).toEqual({ command: 'redo_last_operation', expectedOperationId: calls[0].expectedOperationId })
  })

}
