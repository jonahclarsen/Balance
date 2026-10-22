import { expect, test, type Page } from '@playwright/test'

// The native side of incremental reads is src-tauri/src/state_changes.rs; this
// synthetic backend mirrors its contract so the store's merge, guards, and
// fallbacks run in the browser. Real-engine coverage: history-persistence.spec.ts.
async function startBackend(page: Page) {
  await page.addInitScript(() => {
    const runtime = window as any
    const hash = (text: string) => {
      let value = 2166136261
      for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619)
      return (value >>> 0).toString(16)
    }
    const always = (key: string, value: unknown) => key === 'operations' || value === null || typeof value !== 'object'
    const keyed = (value: unknown): value is { id: string }[] => Array.isArray(value) &&
      value.every(record => typeof record?.id === 'string') && new Set(value.map(record => record.id)).size === value.length
    const respond = (state: Record<string, unknown>, known: any) => {
      if (!known) {
        const fingerprints = { values: {} as Record<string, string>, collections: {} as Record<string, unknown> }
        for (const [key, value] of Object.entries(state)) {
          if (always(key, value)) continue
          if (keyed(value)) fingerprints.collections[key] = { ids: value.map(record => record.id), hashes: value.map(record => hash(JSON.stringify(record))) }
          else fingerprints.values[key] = hash(JSON.stringify(value))
        }
        return { state: structuredClone(state), fingerprints }
      }
      const changes = { values: {} as Record<string, unknown>, valueHashes: {} as Record<string, string>, collections: {} as Record<string, unknown> }
      for (const [key, value] of Object.entries(state)) {
        if (always(key, value)) { changes.values[key] = structuredClone(value); continue }
        if (keyed(value)) {
          const previous = known.collections[key]
          const previousHashes = new Map(previous?.ids.map((id: string, index: number) => [id, previous.hashes[index]]))
          const ids = value.map(record => record.id)
          const changed = value.filter(record => previousHashes.get(record.id) !== hash(JSON.stringify(record)))
          if (changed.length === 0 && previous && JSON.stringify(previous.ids) === JSON.stringify(ids)) continue
          changes.collections[key] = { ids, records: structuredClone(changed), hashes: changed.map(record => hash(JSON.stringify(record))) }
          continue
        }
        const valueHash = hash(JSON.stringify(value))
        if (known.values[key] === valueHash) continue
        changes.values[key] = structuredClone(value)
        changes.valueHashes[key] = valueHash
      }
      return { changes }
    }

    runtime.isTauri = true
    runtime.__reads = []
    runtime.__rejectNextSave = false
    runtime.__dropNextRecord = false
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    runtime.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        if (command === 'read_app_state_changes') {
          if (!runtime.__backend) {
            const plannerPath = '/src/lib/planner.ts'
            const { createInitialState, todayISO, shiftCalendarDateISO } = await import(/* @vite-ignore */ plannerPath)
            const state = createInitialState()
            const today = todayISO()
            state.plans = Array.from({ length: 30 }, (_, day) => ({
              id: `synthetic-plan-${day}`, date: shiftCalendarDateISO(today, -day), title: `Synthetic day ${day}`,
              dailyReminder: '', generatedFromTemplateId: null, createdAt: '2026-10-01T00:00:00.000Z',
              items: [{ id: `synthetic-item-${day}`, text: `Synthetic task ${day}`, html: `Synthetic task ${day}`,
                done: false, startMinutes: null, endMinutes: null, children: [] }],
            }))
            runtime.__backend = { ...state, canRedo: false }
          }
          const response = respond(runtime.__backend, args.known)
          if (runtime.__dropNextRecord && 'changes' in response) {
            // Claim a record is unchanged that the frontend never received.
            runtime.__dropNextRecord = false
            const plans = (response.changes.collections as any).plans
            if (plans) { plans.records = []; plans.hashes = [] }
          }
          runtime.__reads.push({ known: args.known != null,
            records: 'changes' in response ? Object.values(response.changes.collections).reduce((sum: number, change: any) => sum + change.records.length, 0) : null })
          return response
        }
        if (command === 'persist_operation') {
          if (runtime.__rejectNextSave) { runtime.__rejectNextSave = false; return false }
          // Store what startup saves (today's theme) so held and stored state agree.
          const operation = JSON.parse(args.operationJson)
          if (operation.type === 'patch_preferences') Object.assign(runtime.__backend.preferences, operation.payload.patch)
          else runtime.__unstoredOperations = [...(runtime.__unstoredOperations ?? []), operation.type]
          runtime.__backend.localSequence = operation.sequence
          return true
        }
        if (command === 'get_sync_settings') return { enabled: false, pairingCode: null, relayUrl: '' }
        if (command === 'get_database_maintenance_status') return { due: false }
        if (command === 'get_recovery_key_status') return { confirmed: true, recoveryKey: null, databasePath: '/synthetic.sqlite3' }
        if (command === 'build_info') return { version: 'test', commit: 'test' }
        return null
      },
    }
  })
  await page.goto('/')
  await expect(page.getByText('Synthetic task 0')).toBeVisible()
}

async function refresh(page: Page, change?: string) {
  return page.evaluate(async (change) => {
    const runtime = window as any
    const storePath = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ storePath)
    let before: any
    plannerStore.subscribe((state: any) => { before = state })()
    if (change === 'background-edit') Object.assign(runtime.__backend.plans[0].items[0], { text: 'Synthetic background edit', html: 'Synthetic background edit' })
    if (change === 'new-plan') runtime.__backend.plans.push({ ...runtime.__backend.plans[29], id: 'synthetic-plan-new', date: '2020-01-01' })
    const readsBefore = runtime.__reads.length
    await plannerStore.reloadFromBackend()
    let after: any
    plannerStore.subscribe((state: any) => { after = state })()
    return {
      unstoredOperations: runtime.__unstoredOperations ?? [],
      reads: runtime.__reads.slice(readsBefore),
      sameWorkspace: before === after,
      reusedPlans: after.plans.filter((plan: any) => before.plans.includes(plan)).length,
      planCount: after.plans.length,
      firstItem: after.plans.find((plan: any) => plan.id === 'synthetic-plan-0').items[0].text,
    }
  }, change)
}

test('a background change refreshes only the changed day', async ({ page }) => {
  await startBackend(page)
  const result = await refresh(page, 'background-edit')
  expect(result.unstoredOperations).toEqual([])
  expect(result.reads).toEqual([{ known: true, records: 1 }])
  expect(result.firstItem).toBe('Synthetic background edit')
  expect(result.reusedPlans).toBe(29)
  await expect(page.getByText('Synthetic background edit')).toBeVisible()
})

test('an unchanged refresh leaves the workspace untouched', async ({ page }) => {
  await startBackend(page)
  await refresh(page)
  const result = await refresh(page)
  expect(result.reads).toEqual([{ known: true, records: 0 }])
  expect(result.sameWorkspace).toBe(true)
})

test('an unchanged record the frontend lacks forces a complete reread', async ({ page }) => {
  await startBackend(page)
  await page.evaluate(() => { (window as any).__dropNextRecord = true })
  const result = await refresh(page, 'new-plan')
  expect(result.reads).toEqual([{ known: true, records: 0 }, { known: false, records: null }])
  expect(result.planCount).toBe(31)
})

test('a rejected save rereads the complete workspace', async ({ page }) => {
  await startBackend(page)
  await page.evaluate(() => { (window as any).__rejectNextSave = true })
  const task = page.locator('[data-plan-text-input-id="synthetic-item-0"]').first()
  await task.click()
  await page.keyboard.press('End')
  // One keystroke is one save, so the rejection covers the whole edit.
  await page.keyboard.type('!')
  await expect.poll(() => page.evaluate(() => (window as any).__reads.slice(1).some((read: any) => !read.known))).toBe(true)
  // The backend never stored the rejected text, so the complete read restores it.
  await expect(task).toHaveText('Synthetic task 0')
})
