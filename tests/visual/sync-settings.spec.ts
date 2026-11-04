import { expect, test, type Page } from '@playwright/test'
import { openView } from '../helpers/navigation'

async function openSync(page: Page, mode = 'new') {
  await page.addInitScript((mode) => {
    const runtime = window as any
    runtime.isTauri = true
    runtime.__syncCalls = []
    runtime.__callbacks = []
    runtime.__listeners = {}
    runtime.__stateReads = 0
    const settings = {
      enabled: ['connected', 'incomplete', 'failed'].includes(mode),
      pairingCode: ['connected', 'incomplete', 'failed'].includes(mode) ? 'BALSYNC1:synthetic-settings-fixture' : null,
      relayUrl: ['connected', 'failed'].includes(mode) ? 'https://sync.invalid/synthetic-room' : '',
    }
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
    runtime.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (callback: (event: unknown) => void) => {
        runtime.__callbacks.push(callback)
        return runtime.__callbacks.length - 1
      },
      invoke: async (command: string, args: any) => {
        if (command.startsWith('sync_') || command === 'set_sync_relay_url') runtime.__syncCalls.push(command)
        if (command.startsWith('read_app_state')) runtime.__stateReads += 1
        switch (command) {
          case 'plugin:event|listen':
            runtime.__listeners[args.event] = runtime.__callbacks[args.handler]
            return 1
          case 'get_sync_network_offline': return Boolean(runtime.__offline)
          case 'sync_local_network_once': {
            const pass = runtime.__localNetworkPass
            return typeof pass === 'function' ? pass() : pass ?? null
          }
          case 'get_recovery_key_status': return { confirmed: true, recoveryKey: null, databasePath: '/tmp/synthetic.sqlite3' }
          case 'get_sync_settings':
            if (mode === 'unavailable') throw new Error('Synthetic settings failure')
            return { ...settings }
          case 'set_sync_relay_url': settings.relayUrl = args.relayUrl; return { ...settings }
          case 'sync_new_pairing_code': return 'BALSYNC1:synthetic-new-settings-fixture'
          case 'sync_enable_primary':
          case 'sync_enable_joiner': settings.enabled = true; settings.pairingCode = args.pairingCode; settings.relayUrl = args.relayUrl; return { ...settings }
          case 'sync_relay_once':
            if (mode === 'failed' || mode === 'new-failed') throw new Error('Synthetic server unavailable')
            if (runtime.__syncDelayMs) await new Promise((resolve) => setTimeout(resolve, runtime.__syncDelayMs))
            return { pulledOperations: 0, pushedOperations: 0, stateChanged: false, checkpointCommitted: false }
          case 'plugin:barcode-scanner|check_permissions':
          case 'plugin:barcode-scanner|request_permissions': return { camera: 'granted' }
          case 'plugin:barcode-scanner|scan': return { content: 'BALSYNC1:synthetic-scanned-fixture' }
          case 'pending_deep_links': return []
          case 'build_info': return { version: 'test', commit: 'test' }
          case 'get_export_settings': return { exportDirectory: '/tmp', defaultExportDirectory: '/tmp', usesDefaultExportDirectory: true }
          case 'get_database_maintenance_status': return { due: false }
          default: return null
        }
      },
    }
  }, mode)
  await page.goto('/')
  await openView(page, 'Settings')
  const panel = page.locator('.sync-panel')
  await expect(panel.getByRole('heading', { name: 'Sync across your devices' })).toBeVisible()
  return panel
}

async function calls(page: Page) {
  return page.evaluate(() => (window as any).__syncCalls as string[])
}

async function relayCalls(page: Page) {
  return (await calls(page)).filter((command) => command === 'sync_relay_once').length
}

async function pauseAfterStartup(page: Page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000))
  // Let the initial workspace's persistence debounce finish before assigning
  // delays to the sync passes under test. The clock must be installed before
  // openSync so these startup timers belong to the same controlled clock.
  await page.clock.runFor(2_000)
}

async function startBackgroundSync(page: Page, delay: number) {
  const previousCalls = await relayCalls(page)
  await page.evaluate(async (delay) => {
    const runtime = window as any
    runtime.__syncDelayMs = delay
    const schedulerPath = '/src/lib/syncScheduler.ts'
    const { requestSync } = await import(/* @vite-ignore */ schedulerPath)
    runtime.__backgroundSync = requestSync('poll')
  }, delay)
  await expect.poll(() => relayCalls(page)).toBeGreaterThan(previousCalls)
}

test('routine background sync stays quiet and keeps controls usable', async ({ page }) => {
  await page.clock.install()
  const panel = await openSync(page, 'connected')
  await pauseAfterStartup(page)
  await expect(panel.locator('.sync-overview strong')).toHaveText('Connected to sync server')
  const syncNow = panel.getByRole('button', { name: 'Sync now', exact: true })
  const connect = panel.getByRole('button', { name: 'Connect another device' })

  await startBackgroundSync(page, 500)
  await expect(syncNow).toBeEnabled()
  await connect.click()
  await expect(panel.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()
  await page.clock.runFor(499)
  await expect(syncNow).toBeEnabled()
  await expect(connect).toBeEnabled()
  await page.clock.runFor(501)
  await page.evaluate(() => (window as any).__backgroundSync)
  await expect(syncNow).toBeEnabled()
  await expect(connect).toBeEnabled()

  await startBackgroundSync(page, 1_500)
  await page.clock.runFor(999)
  await expect(syncNow).toBeEnabled()
  await expect(connect).toBeEnabled()
  await page.clock.runFor(2)
  await expect(syncNow).toBeEnabled()
  await expect(connect).toBeEnabled()
  await expect(panel.locator('.sync-overview strong')).toHaveText('Connected to sync server')
  // A manual request can join a slow poll instead of leaving its button blocked.
  const beforeManual = await relayCalls(page)
  await syncNow.click()
  await expect(syncNow).toBeDisabled()
  await page.clock.runFor(499)
  await page.evaluate(() => (window as any).__backgroundSync)
  await expect.poll(() => relayCalls(page)).toBeGreaterThan(beforeManual)
  await page.clock.runFor(1_500)
  await expect(syncNow).toBeEnabled()
  await expect(connect).toBeEnabled()
  await expect(panel.getByText('Sync complete.', { exact: true })).toBeVisible()
})

test('saving connection settings waits for an active background sync', async ({ page }) => {
  await page.clock.install()
  const panel = await openSync(page, 'connected')
  await pauseAfterStartup(page)
  await expect(panel.locator('.sync-overview strong')).toHaveText('Connected to sync server')
  await panel.getByText('Connection settings', { exact: true }).click()
  await panel.getByLabel('Sync server address').fill('https://sync.invalid/synthetic-new-room')
  await startBackgroundSync(page, 500)
  const beforeSave = await relayCalls(page)
  const save = panel.getByRole('button', { name: 'Save and connect' })
  await save.click()
  await expect(save).toBeDisabled()
  expect(await calls(page)).not.toContain('set_sync_relay_url')
  await page.clock.runFor(500)
  await expect.poll(() => calls(page)).toContain('set_sync_relay_url')
  await expect.poll(() => relayCalls(page)).toBeGreaterThan(beforeSave)
  await page.clock.runFor(500)
  await expect(save).toBeEnabled()
  await expect(panel.getByLabel('Sync server address')).toHaveValue('https://sync.invalid/synthetic-new-room')
})

test('quick syncs keep the connection label and only longer syncs show progress', async ({ page }) => {
  await page.clock.install()
  const panel = await openSync(page, 'connected')
  await pauseAfterStartup(page)
  const label = panel.locator('.sync-overview strong')
  const lastSync = panel.getByText(/^Last successful sync:/)
  const syncNow = panel.getByRole('button', { name: 'Sync now', exact: true })
  await expect(label).toHaveText('Connected to sync server')
  const originalTime = await lastSync.textContent()

  await page.evaluate(() => { (window as any).__syncDelayMs = 500 })
  await syncNow.click()
  await expect(syncNow).toBeDisabled()
  await page.clock.runFor(499)
  await expect(label).toHaveText('Connected to sync server')
  await page.clock.runFor(1)
  await expect(syncNow).toBeEnabled()
  await expect(label).toHaveText('Connected to sync server')
  // A completed pass must cancel its pending indicator.
  await page.clock.runFor(600)
  await expect(label).toHaveText('Connected to sync server')

  await page.evaluate(() => { (window as any).__syncDelayMs = 1_500 })
  await syncNow.click()
  await expect(syncNow).toBeDisabled()
  await page.clock.runFor(999)
  await expect(label).toHaveText('Connected to sync server')
  await page.clock.runFor(2)
  await expect(label).toHaveText('Syncing…')
  await page.clock.runFor(499)
  await expect(syncNow).toBeEnabled()
  await expect(label).toHaveText('Connected to sync server')
  await expect(lastSync).not.toHaveText(originalTime!)

  // The delay starts fresh after a slow pass, too.
  await page.evaluate(() => { (window as any).__syncDelayMs = 500 })
  await syncNow.click()
  await page.clock.runFor(499)
  await expect(label).toHaveText('Connected to sync server')
  await page.clock.runFor(501)
  await expect(syncNow).toBeEnabled()
  await expect(label).toHaveText('Connected to sync server')
})

test('new setup requires a server, then shows the connection and pairing instructions', async ({ page }, info) => {
  const panel = await openSync(page)
  await expect(panel.getByText(/Sync is self-hosted for now/)).toBeVisible()
  await panel.screenshot({ path: `artifacts/visual-smoke/${info.project.name}-sync-setup.png` })
  await panel.getByRole('button', { name: 'Set up sync from this device' }).click()
  await expect(panel.getByRole('button', { name: 'Set up sync', exact: true })).toBeDisabled()
  await panel.getByLabel('Sync server address').fill('https://sync.invalid/synthetic-room')
  await panel.getByRole('button', { name: 'Set up sync', exact: true }).click()
  await expect(panel.getByText('Connected to sync server', { exact: true })).toBeVisible()
  await expect(panel.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()
  expect(await calls(page)).toContain('sync_enable_primary')
  await expect(panel.getByText('Recent anonymous sync diagnostics', { exact: true })).not.toBeVisible()
  await panel.screenshot({ path: `artifacts/visual-smoke/${info.project.name}-sync-connected.png` })
})

test('joining requires an explicit replacement review and supports going back', async ({ page }) => {
  const panel = await openSync(page)
  await panel.getByRole('button', { name: 'Connect to an existing setup' }).click()
  await panel.getByLabel('Sync server address').fill('https://sync.invalid/synthetic-room')
  await panel.getByLabel('Pairing code', { exact: true }).fill('BALSYNC1:synthetic-join-fixture')
  await panel.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(panel.getByText(/The two planners won’t be combined/)).toBeVisible()
  expect(await calls(page)).not.toContain('sync_enable_joiner')
  await panel.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(panel.getByLabel('Pairing code', { exact: true })).toHaveValue('BALSYNC1:synthetic-join-fixture')
  await panel.getByRole('button', { name: 'Continue', exact: true }).click()
  await panel.getByRole('button', { name: 'Connect and replace this planner' }).click()
  await expect(panel.getByText('Connected. This device now syncs automatically.', { exact: true })).toBeVisible()
  expect(await calls(page)).toContain('sync_enable_joiner')
  await expect(panel.getByRole('img', { name: 'Pairing QR code' })).toHaveCount(0)
})

test('scanning a QR code opens review without changing the planner', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'Camera scanning is mobile only')
  const panel = await openSync(page)
  await panel.getByRole('button', { name: 'Connect to an existing setup' }).click()
  await panel.getByLabel('Sync server address').fill('https://sync.invalid/synthetic-room')
  await panel.getByRole('button', { name: 'Scan QR code' }).click()
  await expect(panel.getByRole('heading', { name: 'Use your existing synced planner?' })).toBeVisible()
  expect(await calls(page)).not.toContain('sync_enable_joiner')
  await expect(page.locator('html')).not.toHaveClass(/qr-scanning/)
})

test('a saved key without a server asks the user to finish setup', async ({ page }) => {
  const panel = await openSync(page, 'incomplete')
  await expect(panel.getByText('Setup incomplete', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Sync now', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: 'Connect another device' })).toBeDisabled()
  await panel.getByLabel('Sync server address').fill('https://sync.invalid/synthetic-room')
  await panel.getByRole('button', { name: 'Save and connect' }).click()
  await expect(panel.getByText('Connected to sync server', { exact: true })).toBeVisible()
})

test('a server failure never claims that setup succeeded', async ({ page }) => {
  const panel = await openSync(page, 'new-failed')
  await panel.getByRole('button', { name: 'Set up sync from this device' }).click()
  await panel.getByLabel('Sync server address').fill('https://sync.invalid/synthetic-room')
  await panel.getByRole('button', { name: 'Set up sync', exact: true }).click()
  await expect(panel.getByText('Sync needs attention', { exact: true })).toBeVisible()
  await expect(panel.getByText(/The first sync has not completed/)).toBeVisible()
  await expect(panel.getByText('Connected to sync server', { exact: true })).toHaveCount(0)
})

test('connected view hides pairing credentials and diagnostics until requested', async ({ page }) => {
  const panel = await openSync(page, 'connected')
  await expect(panel.getByText('Connected to sync server', { exact: true })).toBeVisible()
  await expect(panel.getByRole('img', { name: 'Pairing QR code' })).toHaveCount(0)
  await expect(panel.getByLabel('Sync server address')).not.toBeVisible()
  await expect(panel.getByText('Recent anonymous sync diagnostics', { exact: true })).not.toBeVisible()
  await panel.getByRole('button', { name: 'Connect another device' }).click()
  await expect(panel.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()
  await panel.getByText('Show pairing code', { exact: true }).click()
  await expect(panel.getByText('BALSYNC1:synthetic-settings-fixture', { exact: true })).toBeVisible()
})

test('unavailable settings never expose setup actions', async ({ page }) => {
  const panel = await openSync(page, 'unavailable')
  await expect(panel.getByText(/Sync settings are unavailable/)).toBeVisible()
  await expect(panel.getByRole('button')).toHaveCount(0)
})


test('existing devices can reconnect and replacing a key requires a new server', async ({ page }) => {
  const panel = await openSync(page, 'connected')
  await panel.getByText('Connection settings', { exact: true }).click()
  await panel.getByRole('button', { name: 'Connect to a different setup' }).click()
  await expect(panel.getByLabel('Pairing code', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Back', exact: true }).click()
  await panel.getByText('Troubleshooting', { exact: true }).click()
  await panel.getByText('Advanced: replace sync key', { exact: true }).click()
  await panel.getByRole('button', { name: 'Replace sync key…', exact: true }).click()
  const replace = panel.getByRole('button', { name: 'Replace key and start new setup' })
  await expect(replace).toBeDisabled()
  await panel.getByLabel('New sync server address').fill('https://sync.invalid/synthetic-room')
  await replace.click()
  await expect(panel.getByText('Use a new, empty sync server for the new key.', { exact: true })).toBeVisible()
  expect(await calls(page)).not.toContain('sync_enable_primary')
  await panel.getByLabel('New sync server address').fill('https://sync.invalid/synthetic-new-room')
  await replace.click()
  await expect(panel.getByText('Setup complete. You can now connect your other device.', { exact: true })).toBeVisible()
  await expect(panel.getByLabel('Sync server address', { exact: true })).toHaveValue('https://sync.invalid/synthetic-new-room')
})

const directPass = {
  syncedDevices: 1,
  pulledOperations: 1,
  pushedOperations: 0,
  stateChanged: true,
  lastDirectSyncMs: 1_780_000_000_000,
  error: null,
}

async function stateReads(page: Page) {
  return page.evaluate(() => (window as any).__stateReads as number)
}

test('a direct exchange with a nearby device refreshes the planner and shows when it happened', async ({ page }) => {
  await page.addInitScript((pass) => { (window as any).__localNetworkPass = pass }, directPass)
  const panel = await openSync(page, 'connected')
  await expect(panel.getByText(/Last direct sync:/)).toBeVisible()
  await expect.poll(() => stateReads(page)).toBeGreaterThan(0)
  await expect.poll(() => relayCalls(page)).toBeGreaterThan(0)
  await expect(panel.getByText('Connected to sync server')).toBeVisible()
})

test('direct sync still runs while the relay is unreachable because the device is offline', async ({ page }) => {
  await page.addInitScript((pass) => {
    const runtime = window as any
    runtime.__offline = true
    runtime.__localNetworkPass = pass
  }, directPass)
  const panel = await openSync(page, 'connected')
  await expect(panel.getByText('You’re offline')).toBeVisible()
  await expect(panel.getByText(/Last direct sync:/)).toBeVisible()
  expect(await relayCalls(page)).toBe(0)
})

test('a stalled or failing nearby device never holds up the relay or reports a sync error', async ({ page }) => {
  await page.addInitScript(() => {
    const runtime = window as any
    runtime.__localNetworkPass = () => new Promise(() => undefined)
  })
  let panel = await openSync(page, 'connected')
  await expect(panel.getByText('Connected to sync server')).toBeVisible()
  await panel.getByRole('button', { name: 'Sync now' }).click()
  await expect(panel.getByText('Sync complete.')).toBeVisible()

  await page.addInitScript(() => {
    (window as any).__localNetworkPass = () => { throw new Error('Synthetic nearby failure') }
  })
  await page.reload()
  await openView(page, 'Settings')
  panel = page.locator('.sync-panel')
  await expect(panel.getByText('Connected to sync server')).toBeVisible()
  await expect(panel.locator('#sync-error')).toHaveCount(0)
})

test('operations delivered by a nearby device refresh the planner', async ({ page }) => {
  const panel = await openSync(page, 'connected')
  await expect(panel.getByText('Connected to sync server')).toBeVisible()
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__listeners['balance-local-network-sync']))).toBe(true)
  const before = await stateReads(page)
  await page.evaluate(() => (window as any).__listeners['balance-local-network-sync']({ event: 'balance-local-network-sync', id: 1, payload: null }))
  await expect.poll(() => stateReads(page)).toBeGreaterThan(before)
})
