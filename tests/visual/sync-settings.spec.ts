import { expect, test, type Page } from '@playwright/test'

async function openSync(page: Page, mode = 'new') {
  await page.addInitScript((mode) => {
    const runtime = window as any
    runtime.isTauri = true
    runtime.__syncCalls = []
    const settings = {
      enabled: ['connected', 'incomplete', 'failed'].includes(mode),
      pairingCode: ['connected', 'incomplete', 'failed'].includes(mode) ? 'BALSYNC1:synthetic-settings-fixture' : null,
      relayUrl: ['connected', 'failed'].includes(mode) ? 'https://sync.invalid/synthetic-room' : '',
    }
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
    runtime.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command: string, args: any) => {
        if (command.startsWith('sync_') || command === 'set_sync_relay_url') runtime.__syncCalls.push(command)
        switch (command) {
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
  const nav = page.getByRole('button', { name: 'Open navigation' })
  if (await nav.isVisible()) await nav.click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.locator('.sync-panel')
  await expect(panel.getByRole('heading', { name: 'Sync across your devices' })).toBeVisible()
  return panel
}

async function calls(page: Page) {
  return page.evaluate(() => (window as any).__syncCalls as string[])
}

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
  await expect(panel.getByText('Could not connect to sync server', { exact: true })).toBeVisible()
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
