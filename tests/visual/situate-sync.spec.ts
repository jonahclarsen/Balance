import { expect, test, type Page } from '@playwright/test'

// Only a Mac starts the shared record, and the mobile project reports Android.
test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36' })

// A synthetic backend holds Situate's rules.json and the replicated planner state.
async function start(page: Page, setup: { description?: string; remoteDescription?: string }) {
  await page.addInitScript((setup) => {
    const runtime = window as any
    runtime.isTauri = true
    runtime.__operations = []
    runtime.__saves = []
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    runtime.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        if (command === 'read_app_state_changes') {
          const plannerPath = '/src/lib/planner.ts'
          const { createInitialState } = await import(/* @vite-ignore */ plannerPath)
          const corePath = '/src/lib/situate/core.ts'
          const sharingPath = '/src/lib/situate/sharing.ts'
          const { defaults } = await import(/* @vite-ignore */ corePath)
          const { sharedRules } = await import(/* @vite-ignore */ sharingPath)
          const situateRules = setup.remoteDescription
            ? [(({ modes, ...rules }) => ({ ...rules, modes: modes.map((mode: any) => mode.id === 'dolo' ? { ...mode, description: setup.remoteDescription } : mode) }))(sharedRules(defaults()))]
            : []
          return { state: { ...createInitialState(), situateRules, canRedo: false } }
        }
        if (command === 'situate_load') {
          if (!runtime.__rules && setup.description) {
            const corePath = '/src/lib/situate/core.ts'
            const { defaults } = await import(/* @vite-ignore */ corePath)
            const doc = defaults()
            runtime.__rules = { ...doc, modes: doc.modes.map((mode: any) => mode.id === 'dolo' ? { ...mode, description: setup.description } : mode) }
          }
          return runtime.__rules ?? null
        }
        if (command === 'situate_save') { runtime.__rules = args.document; runtime.__saves.push(args.document); return null }
        if (command === 'persist_operation') { runtime.__operations.push(JSON.parse(args.operationJson)); return true }
        if (command === 'get_sync_settings') return { enabled: false, pairingCode: null, relayUrl: '' }
        if (command === 'get_database_maintenance_status') return { due: false }
        if (command === 'get_recovery_key_status') return { confirmed: true, recoveryKey: null, databasePath: '/synthetic.sqlite3' }
        if (command === 'build_info') return { version: 'test', commit: 'test' }
        return null
      },
    }
  }, setup)
  await page.goto('/')
}

const situateOperations = (page: Page) => page.evaluate(() => (window as any).__operations
  .flatMap((operation: any) => operation.payload?.entityChanges?.upserts ?? [])
  .filter((upsert: any) => upsert.collection === 'situateRules'))
const doloDescription = (page: Page) => page.evaluate(() =>
  (window as any).__rules?.modes.find((mode: any) => mode.id === 'dolo').description)

test('a Mac publishes its customized rules once', async ({ page }) => {
  await start(page, { description: 'Synthetic Mac text' })
  await expect.poll(() => situateOperations(page).then(upserts => upserts.length), { timeout: 10_000 }).toBe(1)
  const [upsert] = await situateOperations(page)
  expect(upsert.value.modes.find((mode: any) => mode.id === 'dolo').description).toBe('Synthetic Mac text')
  expect(await page.evaluate(() => (window as any).__rules.syncBase.id)).toBe('rules')
  await page.waitForTimeout(1500)
  expect(await situateOperations(page)).toHaveLength(1)
})

test('rules from another device replace older local text without publishing', async ({ page }) => {
  await start(page, { description: 'Synthetic old text', remoteDescription: 'Synthetic shared text' })
  await expect.poll(() => doloDescription(page), { timeout: 10_000 }).toBe('Synthetic shared text')
  await page.waitForTimeout(1500)
  expect(await situateOperations(page)).toHaveLength(0)
})

test.describe('on a phone', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36' })
  test('customized rules wait for the shared copy', async ({ page }) => {
    await start(page, { description: 'Synthetic phone text' })
    await page.waitForTimeout(2500)
    expect(await situateOperations(page)).toHaveLength(0)
    expect(await doloDescription(page)).toBe('Synthetic phone text')
  })
})
