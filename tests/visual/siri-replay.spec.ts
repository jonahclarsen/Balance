import { expect, test } from '@playwright/test'

for (const reload of [false, true]) {
  test(`Siri request replay on the next day ${reload ? 'after' : 'without'} backend reload`, async ({ page }) => {
    // Import the real store in a blank browser document: no app, sync scheduler,
    // installed database, screenshots, or platform integration is involved.
    await page.route('**/siri-replay-harness', (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Synthetic Siri replay</title>',
    }))
    await page.goto('/siri-replay-harness')
    const result = await page.evaluate(async (reload) => {
      const plannerPath = '/src/lib/planner.ts'
      const storePath = '/src/lib/store.ts'
      const linksPath = '/src/lib/deepLinks.ts'
      const { createInitialState, createPlanItem } = await import(/* @vite-ignore */ plannerPath)
      const { parseBalanceDeepLink } = await import(/* @vite-ignore */ linksPath)
      const initial = createInitialState()
      initial.plans = ['2026-09-05', '2026-09-06'].map((date) => ({
        id: `synthetic-${date}`, date, title: date, dailyReminder: '',
        generatedFromTemplateId: null, createdAt: `${date}T12:00:00Z`,
        items: [{ ...createPlanItem(), text: 'Synthetic unfinished task', html: 'Synthetic unfinished task' }],
      }))
      initial.operations = []
      let persisted = JSON.stringify(initial)
      const persistedRequests: string[] = []
      const receipts = new Set<string>()
      // read_app_state intentionally returns plans but no operation history,
      // matching read_app_state_from_database_with_progress in lib.rs.
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args?: { operationJson?: string }) => {
            if (command === 'read_app_state') return persisted
            if (command === 'has_processed_siri_request') return receipts.has((args as { requestId: string }).requestId)
            if (command === 'persist_operation') {
              const operation = JSON.parse(args!.operationJson!)
              if (receipts.has(operation.payload.requestId)) return false
              receipts.add(operation.payload.requestId)
              persistedRequests.push(operation.payload.requestId)
              return true
            }
            throw new Error(`Unexpected native command: ${command}`)
          },
        },
      })
      const { plannerStore, databaseLoadError } = await import(/* @vite-ignore */ storePath)
      await plannerStore.ready
      let loadError = ''
      databaseLoadError.subscribe((value: string) => { loadError = value })()
      if (loadError) throw new Error(loadError)
      let snapshot: typeof initial
      const unsubscribe = plannerStore.subscribe((state: typeof initial) => { snapshot = state })
      const request = parseBalanceDeepLink('balance://add?text=Synthetic%20Siri%20capture&request=synthetic-replay-001')!
      const firstAdded = await plannerStore.addPlanItemFromSiri(request.text, request.requestId, '2026-09-05')
      await plannerStore.flushPendingOperations()
      // Use the real store's resulting plans as the synthetic persisted state.
      persisted = JSON.stringify({ ...snapshot!, operations: [] })
      if (reload) await plannerStore.reloadFromBackend()
      const operationsBeforeReplay = snapshot!.operations.length
      const replayAdded = await plannerStore.addPlanItemFromSiri(request.text, request.requestId, '2026-09-06')
      await plannerStore.flushPendingOperations()
      const dates = snapshot!.plans.filter((plan: typeof initial.plans[number]) =>
        JSON.stringify(plan.items).includes(request.text),
      ).map((plan: typeof initial.plans[number]) => plan.date).sort()
      unsubscribe()
      return { firstAdded, replayAdded, dates, operationsBeforeReplay, persistedRequests }
    }, reload)

    console.log(JSON.stringify({ backendReload: reload, ...result }))
    expect(result.firstAdded).toBe(true)
    expect(result.operationsBeforeReplay).toBe(reload ? 0 : 1)
    expect(result.persistedRequests).toEqual(['synthetic-replay-001'])
    expect(result.replayAdded, 'The same request ID must never insert a second task').toBe(false)
    expect(result.dates).toEqual(['2026-09-05'])
  })
}
