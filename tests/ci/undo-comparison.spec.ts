import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// This harness is copied unchanged into every revision. Real store + SQLCipher;
// the bridge adds process/Playwright overhead, reported separately from native work.
for (const [size, plans, entries] of [['small', 75, 300], ['large', 1500, 10000], ['xlarge', 4500, 30000]] as const) {
  test(`undo comparison: ${size}`, async ({ page }) => {
    page.on('pageerror', error => console.log(`SYNTHETIC_PAGE_ERROR ${error.message}`))
    const root = mkdtempSync(join(tmpdir(), 'balance-undo-comparison-'))
    writeFileSync(join(root, 'SYNTHETIC_FIXTURES_ONLY'), '')
    const calls: any[] = []
    function native(command: string, args: any = {}) {
      if (!['seed', 'verify', 'read_app_state', 'persist_operation', 'undo_last_operation', 'redo_last_operation'].includes(command)) {
        if (command === 'get_recovery_key_status') return { confirmed: true, recoveryKey: null, databasePath: join(root, 'fixture.sqlite3') }
        if (command === 'get_sync_settings') return { enabled: false, pairingCode: null, relayUrl: '' }
        if (command === 'get_database_maintenance_status') return { due: false, operationCount: 0, operationBytes: 0, checkpointRecommended: false }
        if (command === 'get_export_settings') return { autoJsonExportEnabled: false, exportDirectory: root, defaultExportDirectory: root }
        if (command === 'build_info') return { version: 'test', commit: 'synthetic' }
        return null
      }
      writeFileSync(join(root, 'request.json'), JSON.stringify({ root, command, args }))
      execFileSync(resolve(process.env.BALANCE_UNDO_ENGINE!), ['tests::undo_comparison_driver', '--exact', '--ignored'], {
        env: { ...process.env, BALANCE_UNDO_REQUEST: join(root, 'request.json') }, stdio: 'pipe',
      })
      const response = JSON.parse(readFileSync(join(root, 'response.json'), 'utf8'))
      if (command.includes('last_operation')) {
        const result = JSON.parse(response.result)
        calls.push({ command, nativeMs: response.commandMs, openMs: response.openMs,
          operationMs: response.operationMs, housekeepingMs: response.housekeepingMs, fullState: result.state !== null, retainedHistory: response.historyCount, responseBytes: Buffer.byteLength(response.result) })
      }
      return response.result
    }
    try {
      native('seed', { plans, entries })
      await page.exposeFunction('undoNative', native)
      await page.addInitScript(() => {
        const runtime = window as any
        runtime.isTauri = true
        runtime.__TAURI_INTERNALS__ = {
          invoke: runtime.undoNative, transformCallback: () => 1,
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        }
        runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
      })
      await page.route('**/undo-comparison', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }))
      await page.goto('/undo-comparison')
      const navigationExists = existsSync('src/lib/historyNavigation.ts')
      await page.evaluate(async (navigationExists) => {
        const path = '/src/lib/store.ts'
        const { plannerStore } = await import(/* @vite-ignore */ path)
        await plannerStore.ready
        const runtime = window as any
        runtime.store = plannerStore
        plannerStore.subscribe((state: any) => { runtime.state = state })
        if (navigationExists) {
          const path = '/src/lib/historyNavigation.ts'
          runtime.destination = (await import(/* @vite-ignore */ path)).historyDestination
        }
      }, navigationExists)
      for (const scenario of ['plan-text', 'plan-pending', 'remove-time', 'paste-tree', 'note-text', 'metric-first', 'metric-last',
        'list-check', 'list-check-pending', 'list-text', 'list-template-text', 'plan-after-reload']) {
        console.log(`UNDO_SCENARIO ${process.env.BALANCE_UNDO_REVISION}/${size}/${scenario}`)
        await page.evaluate(async (scenario) => {
          const { store, state } = window as any
          const plan = state.plans[0]
          ;(window as any).probe = () => {
            const state = (window as any).state
            if (scenario === 'note-text') return state.notes[0].items[0].text
            if (scenario === 'list-template-text') return state.listTemplates[0].items[0].text
            if (scenario.startsWith('list-')) {
              const row = state.lists.at(-1).items[0]
              return JSON.stringify([row.text, row.done, row.doneAt ?? null])
            }
            if (scenario.startsWith('metric-')) {
              const entry = scenario === 'metric-first' ? state.metricEntries[0] : state.metricEntries.at(-1)
              return entry.answers[0].value
            }
            const item = state.plans[0].items[0]
            return JSON.stringify([item.text, item.startMinutes, item.endMinutes, item.children.map((child: any) => child.text)])
          }
          ;(window as any).expectedBeforeProbe = (window as any).probe()
          if (scenario.startsWith('plan-')) store.patchPlanItem(plan.id, plan.items[0].id, { text: 'Changed', html: 'Changed' })
          if (scenario === 'remove-time') store.patchPlanItem(plan.id, plan.items[0].id, { startMinutes: null, endMinutes: null, timeHidden: null })
          if (scenario === 'note-text') store.patchNoteItem('note_ci', 'item_ci', { text: 'Changed', html: 'Changed' })
          if (scenario === 'list-template-text') store.patchListTemplateItem('list_template_ci', 'lt_item_0', { text: 'Changed', html: 'Changed' })
          if (scenario.startsWith('list-check') || scenario === 'list-text') {
            const list = state.lists.at(-1)
            const patch = scenario === 'list-text' ? { text: 'Changed', html: 'Changed' } : { done: true }
            store.patchListItem(list.id, list.items[0].id, patch)
          }
          if (scenario.startsWith('metric-')) {
            const entry = scenario === 'metric-first' ? state.metricEntries[0] : state.metricEntries.at(-1)
            store.upsertMetricAnswer(entry.metricId, entry.date, 'question_ci', 'Changed')
          }
          if (scenario === 'paste-tree') {
            const item = (id: string) => ({ id, text: 'Pasted', html: 'Pasted', done: false, startMinutes: null, endMinutes: null, children: [] })
            store.pastePlanItems(plan.id, [{ ...item('paste_root'), children: Array.from({ length: 10 }, (_, i) => item(`paste_${i}`)) }], plan.items[0].id, 'replace')
          }
          if (!scenario.endsWith('-pending')) await store.flushPendingOperations()
          if (scenario === 'plan-after-reload') await store.reloadFromBackend()
          ;(window as any).expectedAfterProbe = (window as any).probe()
          const after = (window as any).state
          ;(window as any).expectedAfter = JSON.stringify({ plans: after.plans, notes: after.notes, metricEntries: after.metricEntries, lists: after.lists, listTemplates: after.listTemplates })
        }, scenario)
        const samples = scenario === 'plan-after-reload' ? 2 : 4
        for (let sample = 0; sample < samples; sample++) {
          for (const direction of ['undo', 'redo']) {
            const result = await page.evaluate(async (direction) => {
              const runtime = window as any
              const before = runtime.state
              const started = performance.now()
              await runtime.store[direction]()
              const storeMs = performance.now() - started
              const revealStarted = performance.now()
              const destination = runtime.destination?.(before, runtime.state)
              const revealMs = performance.now() - revealStarted
              return { changed: runtime.state.historyRevision !== before.historyRevision, storeMs, revealMs, totalMs: storeMs + revealMs, destination: destination?.view }
            }, direction)
            expect(result.changed).toBe(true)
            expect(calls.at(-1).retainedHistory).toBeGreaterThanOrEqual(entries)
            if (process.env.BALANCE_UNDO_REVISION === 'candidate' && scenario === 'plan-after-reload') {
              expect(calls.at(-1).fullState, 'Unchanged refresh must preserve the fast native history response').toBe(false)
            }
            expect(await page.evaluate((direction) => {
              const r = window as any
              return r.probe() === (direction === 'undo' ? r.expectedBeforeProbe : r.expectedAfterProbe)
            }, direction), `${scenario} ${direction} restores the expected content`).toBe(true)
            const record = { revision: process.env.BALANCE_UNDO_REVISION, round: process.env.BALANCE_UNDO_ROUND,
              size, plans, items: plans * 60, entries, scenario, sample, direction, navigationExists, ...calls.at(-1), ...result }
            appendFileSync(process.env.BALANCE_UNDO_REPORT!, JSON.stringify(record) + '\n')
            if (scenario.startsWith('metric-') && navigationExists) expect(result.destination).toBe('metrics')
          }
        }
        // Correctness is outside timing: restored frontend and persisted data agree.
        expect(await page.evaluate(() => {
          const r = window as any
          return JSON.stringify({ plans: r.state.plans, notes: r.state.notes, metricEntries: r.state.metricEntries, lists: r.state.lists, listTemplates: r.state.listTemplates }) === r.expectedAfter
        })).toBe(true)
        const visible = await page.evaluate(() => {
          const r = window as any
          return { plan: r.state.plans[0], note: r.state.notes[0], entries: r.state.metricEntries,
            list: r.state.lists.at(-1), listTemplate: r.state.listTemplates[0] }
        })
        const persisted = native('verify', { planId: visible.plan.id, listId: visible.list.id })
        expect(persisted.list.items[0]).toEqual(visible.list.items[0])
        expect(persisted.listTemplate.items[0].text).toBe(visible.listTemplate.items[0].text)
        expect(persisted.plan.items[0].text).toBe(visible.plan.items[0].text)
        expect(persisted.plan.items[0].children.map((i: any) => i.text)).toEqual(visible.plan.items[0].children.map((i: any) => i.text))
        expect(persisted.plan.items[0].startMinutes).toBe(visible.plan.items[0].startMinutes)
        expect(persisted.plan.items[0].endMinutes).toBe(visible.plan.items[0].endMinutes)
        expect(persisted.note.items[0].text).toBe(visible.note.items[0].text)
        expect(persisted.entries).toEqual(visible.entries)
        // Leave each scenario at its original value, preventing merged edits.
        await page.evaluate(async () => { await (window as any).store.undo() })
      }
      // Exercise actual keyboard undo and the Svelte renderer for the reported
      // task interactions as well as the isolated store/reveal stages above.
      await page.evaluate(() => localStorage.setItem('balance:activePlanDate', (window as any).state.plans[0].date))
      await page.goto('/')
      await page.evaluate(async () => {
        const path = '/src/lib/store.ts'
        const { plannerStore: store } = await import(/* @vite-ignore */ path)
        await store.ready
        let state: any
        store.subscribe((value: any) => { state = value })()
        store.subscribe((value: any) => { (window as any).state = value })
        store.setActivePlanDate(state.plans[0].date)
        await store.flushPendingOperations()
      })
      const editor = page.locator('[data-plan-text-input]').first()
      await expect(editor).toBeVisible({ timeout: 60_000 })
      // Keyboard undo through the real app handler, timed until the store
      // changes plus two animation frames for the renderer.
      async function keyboardHistory(direction: 'undo' | 'redo') {
        return page.evaluate(async (direction) => {
          const path = '/src/lib/store.ts'
          const { plannerStore: store } = await import(/* @vite-ignore */ path)
          let revision = 0
          store.subscribe((state: any) => { revision = state.historyRevision })()
          const initial = revision
          const start = performance.now()
          const done = new Promise<void>((resolve) => {
            const unsubscribe = store.subscribe((state: any) => {
              if (state.historyRevision !== initial) { unsubscribe(); resolve() }
            })
          })
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: true, shiftKey: direction === 'redo', bubbles: true, cancelable: true }))
          await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(Error(`Keyboard ${direction} did not update the store`)), 60_000))])
          await new Promise(requestAnimationFrame)
          await new Promise(requestAnimationFrame)
          return { totalMs: performance.now() - start }
        }, direction)
      }
      function report(scenario: string, sample: number, direction: string, result: object) {
        appendFileSync(process.env.BALANCE_UNDO_REPORT!, JSON.stringify({ revision: process.env.BALANCE_UNDO_REVISION,
          round: process.env.BALANCE_UNDO_ROUND, size, plans, items: plans * 60, entries,
          scenario, sample, direction, ...calls.at(-1), ...result }) + '\n')
      }
      for (const scenario of ['rendered-text', 'rendered-remove-time', 'rendered-paste']) {
        for (let sample = 0; sample < 4; sample++) {
          await editor.focus()
          const expected = await editor.textContent()
          await page.evaluate(async (scenario) => {
            const path = '/src/lib/store.ts'
            const { plannerStore: store } = await import(/* @vite-ignore */ path)
            let state: any
            store.subscribe((value: any) => { state = value })()
            const plan = state.plans.find((p: any) => p.date === state.activePlanDate)
            const target = plan.items[0]
            if (scenario === 'rendered-text') store.patchPlanItem(plan.id, target.id, { text: 'Rendered changed', html: 'Rendered changed' })
            if (scenario === 'rendered-remove-time') store.patchPlanItem(plan.id, target.id, { startMinutes: null, endMinutes: null, timeHidden: null })
            if (scenario === 'rendered-paste') {
              const item = (id: string) => ({ id, text: 'Rendered pasted', html: 'Rendered pasted', done: false, startMinutes: null, endMinutes: null, children: [] })
              store.pastePlanItems(plan.id, [{ ...item('rendered_root'), children: Array.from({ length: 10 }, (_, i) => item(`rendered_${i}`)) }], target.id, 'replace')
            }
          }, scenario)
          const result = await keyboardHistory('undo')
          expect(await editor.textContent()).toBe(expected)
          report(scenario, sample, 'undo', result)
        }
      }
      // The reported slow case: undo and redo on the Lists page (template text)
      // and on a generated list in List History (check-off), with the page
      // rendered and the keyboard handler revealing the destination.
      async function openView(name: string) {
        const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
        if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') await menu.click()
        await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('button', { name, exact: true }).click()
      }
      // List History has no sidebar entry until it has been opened once; its
      // shortcut is Alt+H (Alt+R before Sept 16).
      async function openListHistory(rowSelector: string) {
        for (const code of ['KeyH', 'KeyR']) {
          await page.evaluate((code) => window.dispatchEvent(new KeyboardEvent('keydown', { key: code.slice(3).toLowerCase(), code, altKey: true, bubbles: true, cancelable: true })), code)
          if (await page.locator(rowSelector).first().isVisible({ timeout: 5_000 }).catch(() => false)) return
        }
      }
      for (const [scenario, viewName, rowSelector] of [
        ['rendered-list-template-text', 'Lists', '.template-list [contenteditable="true"]'],
        ['rendered-list-check', 'List History', '.list-panel [data-plan-item-id]'],
      ] as const) {
        if (viewName === 'List History') await openListHistory(rowSelector)
        else await openView(viewName)
        const row = page.locator(rowSelector).first()
        await expect(row).toBeVisible({ timeout: 60_000 })
        for (let sample = 0; sample < 4; sample++) {
          const before = await page.evaluate(async (scenario) => {
            const path = '/src/lib/store.ts'
            const { plannerStore: store } = await import(/* @vite-ignore */ path)
            // window.state follows the live store, so the probe sees the edit.
            const state = () => (window as any).state
            const probe = () => scenario === 'rendered-list-check'
              ? JSON.stringify(state().lists.find((list: any) => list.date === state().activePlanDate).items[0])
              : state().listTemplates[0].items[0].text
            const original = probe()
            if (scenario === 'rendered-list-template-text') {
              store.patchListTemplateItem('list_template_ci', 'lt_item_0', { text: 'Rendered changed', html: 'Rendered changed' })
            } else {
              const list = state().lists.find((list: any) => list.date === state().activePlanDate)
              store.patchListItem(list.id, list.items[0].id, { done: true })
            }
            await store.flushPendingOperations()
            return { original, changed: probe() }
          }, scenario)
          expect(before.changed).not.toBe(before.original)
          const undo = await keyboardHistory('undo')
          const probeAfterUndo = await page.evaluate((scenario) => {
            const state = (window as any).state
            return scenario === 'rendered-list-check'
              ? JSON.stringify(state.lists.find((list: any) => list.date === state.activePlanDate).items[0])
              : state.listTemplates[0].items[0].text
          }, scenario)
          expect(probeAfterUndo).toBe(before.original)
          report(scenario, sample, 'undo', undo)
          const redo = await keyboardHistory('redo')
          report(scenario, sample, 'redo', redo)
          // Leave the row as it started so every sample measures the same edit.
          await keyboardHistory('undo')
        }
        if (scenario === 'rendered-list-check') {
          await expect(row).toBeVisible()
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
