import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('offline typing agrees with the encrypted database through two undos and redos', async ({ page, context }, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'balance-note-undo-ci-'))
  writeFileSync(join(root, 'SYNTHETIC_FIXTURES_ONLY'), '')
  const operations: any[] = []
  const history: any[] = []
  function native(command: string, args: any = {}) {
    writeFileSync(join(root, 'request.json'), JSON.stringify({ root, command, args }))
    execFileSync(resolve(process.env.BALANCE_NOTE_UNDO_ENGINE!), [
      'tests::note_undo_ci_driver', '--exact', '--ignored', '--nocapture',
    ], { env: { ...process.env, BALANCE_NOTE_UNDO_REQUEST: join(root, 'request.json') } })
    const response = JSON.parse(readFileSync(join(root, 'response.json'), 'utf8'))
    if (command === 'persist_operation') operations.push(JSON.parse(args.operationJson))
    if (command === 'undo_last_operation' || command === 'redo_last_operation') {
      const result = JSON.parse(response.result)
      history.push({ command, expectedOperationId: args.expectedOperationId, actualOperationId: result.operationId,
        databaseText: response.text, fullState: result.state !== null,
        responseBytes: Buffer.byteLength(response.result), nativeMs: response.commandMs, openMs: response.openMs })
    }
    return response
  }
  try {
    native('seed')
    await page.exposeFunction('noteUndoNative', (command: string, args: any) => native(command, args).result)
    await page.addInitScript(() => {
      const runtime = window as any
      runtime.isTauri = true
      runtime.__TAURI_INTERNALS__ = { invoke: runtime.noteUndoNative }
    })
    // Import the actual store without starting unrelated app UI or sync services.
    await page.route('**/note-undo-ci', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }))
    await page.goto('/note-undo-ci')
    await page.evaluate(async () => {
      const path = '/src/lib/store.ts'
      const { plannerStore } = await import(/* @vite-ignore */ path)
      await plannerStore.ready
      ;(window as any).noteUndoStore = plannerStore
    })
    await context.setOffline(true)
    // Keep authored key times deterministic despite host/process startup delays.
    // Saves still use real IPC responses and real encrypted database commits.
    const start = Date.UTC(2026, 8, 1)
    for (let index = 0; index < 6; index++) {
      await page.clock.setFixedTime(new Date(start + index * 100 + (index >= 3 ? 2000 : 0)))
      await page.evaluate(async (text) => {
        const store = (window as any).noteUndoStore
        store.patchNoteItem('note_ci', 'item_ci', { text, html: text })
        await store.flushPendingOperations()
      }, 'abcdef'.slice(0, index + 1))
    }
    const historyCount = native('inspect').historyCount
    for (const direction of ['undo', 'undo', 'redo', 'redo']) {
      const ui = await page.evaluate(async (direction) => {
        const store = (window as any).noteUndoStore
        const started = performance.now()
        await store[direction]()
        const elapsedMs = performance.now() - started
        let text = ''
        store.subscribe((state: any) => { text = state.notes.find((note: any) => note.id === 'note_ci').items[0].text })()
        return { text, elapsedMs }
      }, direction)
      Object.assign(history.at(-1), { frontendText: ui.text, frontendMs: ui.elapsedMs })
    }
    const expected = ['abc', '', 'abc', 'abcdef']
    const correct = history.every((entry, index) => entry.databaseText === expected[index] && entry.frontendText === expected[index])
    const report = { revision: process.env.BALANCE_NOTE_UNDO_REVISION, offline: true, workspaceItems: 90000,
      operationCount: operations.length, distinctOperationIds: new Set(operations.map(op => op.id)).size,
      historyCount, expected, correct, history }
    const json = JSON.stringify(report, null, 2)
    writeFileSync(testInfo.outputPath('note-undo.json'), json)
    writeFileSync(process.env.BALANCE_NOTE_UNDO_REPORT!, json)
    await testInfo.attach('note-undo.json', { body: json, contentType: 'application/json' })
    console.log(`NOTE_UNDO_CI ${JSON.stringify(report)}`)
    expect(report.operationCount).toBe(6)
    expect(report.distinctOperationIds).toBe(6)
    expect(report.correct, 'Frontend and database must both undo/redo entire typing bursts').toBe(true)
    expect(report.historyCount).toBe(2)
    expect(history.every(entry => !entry.fullState && entry.responseBytes < 1024)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
