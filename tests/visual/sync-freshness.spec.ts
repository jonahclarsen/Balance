import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    type TestRuntime = typeof globalThis & {
      isTauri: boolean
      __syncAttemptCount: number
      __TAURI_INTERNALS__: {
        invoke: (command: string) => Promise<unknown>
        transformCallback: () => number
      }
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => void
      }
    }
    const runtime = globalThis as TestRuntime
    const date = new Date().toISOString().slice(0, 10)
    const storedState = JSON.stringify({
      schemaVersion: 1,
      deviceId: 'stale-state-test',
      localSequence: 0,
      historyRevision: 0,
      activePlanDate: date,
      templates: [],
      plans: [{ id: 'local-plan', date, dailyReminder: '', items: [] }],
      goals: [],
      goalCompletions: [],
      listTemplates: [],
      lists: [],
      metrics: [],
      metricEntries: [],
      notes: [],
      operations: [],
    })

    runtime.isTauri = true
    runtime.__syncAttemptCount = 0
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
    runtime.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command: string) => {
        switch (command) {
          case 'read_app_state':
            return storedState
          case 'get_recovery_key_status':
            return { confirmed: true, recoveryKey: null, databasePath: '/tmp/synthetic.sqlite3' }
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
            if (new URLSearchParams(location.search).has('hold-settings')) {
              return new Promise(() => undefined)
            }
            return {
              enabled: true,
              pairingCode: 'BALSYNC1:synthetic-test-code',
              relayUrl: 'https://relay.invalid/test',
            }
          case 'sync_relay_once':
            runtime.__syncAttemptCount += 1
            if (new URLSearchParams(location.search).has('hold-sync')) {
              return new Promise(() => undefined)
            }
            throw 'codec: the pending sync is large and will finish next time Balance is open'
          case 'build_info':
            return { version: 'test', commit: 'test' }
          case 'complete_database_maintenance_startup':
            return null
          case 'get_database_maintenance_status':
            return {
              due: false,
              lastCompletedAt: 'unix-ms-2000000000000',
              checkpointCoordinator: false,
              databaseBytes: 1024,
              reclaimableBytes: 0,
              reclaimablePercent: 0,
              operationCount: 1,
              operationBytes: 128,
              checkpointRecommended: false,
            }
          case 'plugin:event|listen':
          case 'plugin:event|unlisten':
            return 1
          default:
            return null
        }
      },
    }
  })
})

test('the app identifies when it is still loading sync settings', async ({ page }) => {
  await page.goto('/?hold-settings=1')

  const loading = page.getByRole('status')
  await expect(loading.getByText('Loading sync settings…')).toBeVisible()
  await expect(loading.getByText('Preparing automatic sync using this device’s saved settings.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
})

test('the app identifies local state while its launch sync is still running', async ({ page }) => {
  await page.goto('/?hold-sync=1')

  const checking = page.getByRole('status')
  await expect(checking.getByText('Checking for changes…')).toBeVisible()
  await expect(checking.getByText('The data shown is this device’s saved copy until sync completes.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
})

test('an unsuccessful launch sync marks the visible local state as potentially stale', async ({ page }, testInfo) => {
  await page.goto('/')

  const warning = page.getByRole('alert')
  await expect(warning.getByText('Balance may be out of date')).toBeVisible()
  await expect(warning.getByText(/Sync hasn.t completed/)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()

  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __syncAttemptCount: number }
    return runtime.__syncAttemptCount
  })).toBe(1)

  await warning.getByRole('button', { name: 'Retry now' }).click()
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __syncAttemptCount: number }
    return runtime.__syncAttemptCount
  })).toBe(2)

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-sync-may-be-out-of-date.png`,
    fullPage: false,
  })
})
