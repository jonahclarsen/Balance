import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fixtureRoot: string | undefined
test.afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
})

for (const structural of [false, true]) for (const cached of [true, false]) for (const direction of ['undo', 'redo'] as const) {
  test(`${direction} with ${cached ? 'cached' : 'full'} history preserves overlapping ${structural ? 'tree edits' : 'text edits'} and refreshes`, async ({ page }) => {
    if (process.env.BALANCE_HISTORY_ENGINE) {
      const root = fixtureRoot = mkdtempSync(join(tmpdir(), 'balance-history-persistence-'))
      writeFileSync(join(root, 'SYNTHETIC_FIXTURES_ONLY'), '')
      await page.exposeFunction('historyNative', (command: string, args: unknown) => {
        const request = join(root, 'request.json')
        writeFileSync(request, JSON.stringify({ command, args }))
        execFileSync(process.env.BALANCE_HISTORY_ENGINE!, ['sync::tests::history_persistence_driver', '--exact', '--ignored'], {
          env: { ...process.env, BALANCE_HISTORY_REQUEST: request },
        })
        const response = JSON.parse(readFileSync(join(root, 'response.json'), 'utf8'))
        if (response.error) throw new Error(response.error)
        return response.result
      })
    }
    await page.route('**/history-persistence', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }))
    await page.goto('/history-persistence')
    const result = await page.evaluate(async ({ direction, cached, structural }) => {
      const runtime = window as any
      const initial = {
        schemaVersion: 1, deviceId: 'synthetic-history', localSequence: 0,
        activePlanDate: '2026-09-16', templates: [],
        plans: [{ id: 'plan', title: 'Synthetic day', createdAt: '2026-09-16T00:00:00Z', date: '2026-09-16', dailyReminder: '', items: [
          { id: 'deleted', text: 'Restore me', html: 'Restore me', done: false, children: [] },
          { id: 'survivor', text: 'Keep me', html: 'Keep me', done: false, children: [] },
          ...(structural ? [{ id: 'empty', text: '', html: '', done: false, children: [] }] : []),
        ] }], operations: [],
      }
      if (runtime.historyNative) await runtime.historyNative('seed', { state: initial })
      let database = structuredClone(initial) as any
      const durable = new Map<string, any>()
      let deleted: any
      let deletedOperation: any
      let release = () => {}
      let started = () => {}
      let delayHistory = false
      const historyStarted = new Promise<void>(resolve => { started = resolve })
      const errors: string[] = []
      runtime.isTauri = true
      runtime.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
        if (!cached && (command === 'undo_last_operation' || command === 'redo_last_operation')) args.expectedOperationId = null
        if (runtime.historyNative) {
          let response: any
          try { response = await runtime.historyNative(command, args) }
          catch (error) { errors.push(String(error)); throw error }
          if (delayHistory && (command === 'undo_last_operation' || command === 'redo_last_operation')) {
            await new Promise<void>(resolve => { release = resolve; started() })
          }
          return response
        }
        if (command === 'read_app_state') return JSON.stringify(database)
        if (command === 'persist_operation') {
          const operation = JSON.parse(args.operationJson)
          const previous = durable.get(operation.id)
          if (previous && ['deviceId', 'sequence', 'type', 'payload'].some(field => JSON.stringify(previous[field]) !== JSON.stringify(operation[field]))) {
            const error = 'codec: cannot change an already persisted sync operation; use a new operation id'
            errors.push(error)
            throw new Error(error)
          }
          if (previous) return true
          durable.set(operation.id, operation)
          database.localSequence = operation.sequence
          if (operation.type === 'delete_plan_items') {
            deletedOperation = operation
            deleted = database.plans[0].items[0]
            database.plans[0].items = database.plans[0].items.filter((item: any) => !operation.payload.itemIds.includes(item.id))
          } else if (operation.type === 'backspace_plan_item_at_start') {
            database.plans[0].items = database.plans[0].items.filter((item: any) => item.id !== 'empty')
          } else if (operation.type === 'patch_plan_item') {
            Object.assign(database.plans[0].items.find((item: any) => item.id === operation.payload.itemId), operation.payload.patch)
          }
          return true
        }
        if (command === 'undo_last_operation' || command === 'redo_last_operation') {
          const undo = command === 'undo_last_operation'
          const sequence = ++database.localSequence
          const id = `op_${database.deviceId}_${sequence}`
          durable.set(id, { id, deviceId: database.deviceId, sequence, type: undo ? 'history_undo' : 'history_redo', payload: {} })
          database.plans[0].items = undo ? [deleted, ...database.plans[0].items] : database.plans[0].items.filter((item: any) => item.id !== deleted.id)
          const response = JSON.stringify({ operationId: deletedOperation.id, operationType: 'delete_plan_items',
            localSequence: sequence, canRedo: undo, state: cached ? null : database })
          if (delayHistory) await new Promise<void>(resolve => { release = resolve; started() })
          return response
        }
        throw new Error(`Unexpected command ${command}`)
      } }
      const path = '/src/lib/store.ts'
      const { plannerStore: store } = await import(/* @vite-ignore */ path)
      await store.ready
      store.deletePlanItems('plan', ['deleted'])
      await store.flushPendingOperations()
      if (direction === 'redo') await store.undo()
      delayHistory = true
      const history = store[direction]()
      await historyStarted
      if (structural) store.backspacePlanItemAtStart('plan', 'empty')
      store.patchPlanItem('plan', 'survivor', { text: 'Edited during history', html: 'Edited during history' })
      let flushed = false
      const flushing = store.flushPendingOperations().then(() => { flushed = true }).catch(() => {})
      const refresh = store.reloadFromBackend().catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 20))
      const flushedBeforeAcknowledgement = flushed
      release()
      await history
      await flushing
      await refresh
      await store.flushPendingOperations().catch(() => {})
      let live: any
      store.subscribe((state: any) => { live = state })()
      if (runtime.historyNative) database = JSON.parse(await runtime.historyNative('read_app_state'))
      const replayed = runtime.historyNative ? JSON.parse(await runtime.historyNative('replay')) : database
      return { errors, flushedBeforeAcknowledgement, replayed: replayed.plans[0].items.map((item: any) => ({ id: item.id, text: item.text })), frontend: live.plans[0].items.map((item: any) => ({ id: item.id, text: item.text })),
        database: database.plans[0].items.map((item: any) => ({ id: item.id, text: item.text })),
        sequences: (runtime.historyNative ? database.operations.filter((operation: any) => operation.sequence > 0) : [...durable.values()]).map((operation: any) => operation.sequence) }
    }, { direction, cached, structural })
    expect(result.errors).toEqual([])
    expect(result.flushedBeforeAcknowledgement).toBe(false)
    const items = [ ...(direction === 'undo' ? [{ id: 'deleted', text: 'Restore me' }] : []),
      { id: 'survivor', text: 'Edited during history' } ]
    expect(result.frontend).toEqual(items)
    expect(result.database).toEqual(items)
    expect(result.replayed).toEqual(items)
    expect(new Set(result.sequences).size).toBe(result.sequences.length)
  })
}
