import { expect, test, type Page } from '@playwright/test'

type SyncStatusSnapshot = {
  running: boolean
  initialSyncComplete: boolean
}

async function readSyncStatus(page: Page): Promise<SyncStatusSnapshot> {
  return page.evaluate(async () => {
    const schedulerPath = '/src/lib/syncScheduler.ts'
    const scheduler = await import(/* @vite-ignore */ schedulerPath)
    let snapshot: SyncStatusSnapshot | undefined
    const unsubscribe = scheduler.automaticSyncStatus.subscribe((status: SyncStatusSnapshot) => {
      snapshot = {
        running: status.running,
        initialSyncComplete: status.initialSyncComplete,
      }
    })
    unsubscribe()
    if (!snapshot) throw new Error('Automatic sync status was unavailable')
    return snapshot
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    type TestRuntime = typeof globalThis & {
      isTauri: boolean
      __syncAttemptCount: number
      __syncSettingsCount: number
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
    const stateWithItem = (text: string) => JSON.stringify({
      schemaVersion: 1,
      deviceId: 'stale-state-test',
      localSequence: 0,
      historyRevision: 0,
      activePlanDate: date,
      templates: [],
      plans: [{
        id: 'local-plan',
        date,
        dailyReminder: '',
        items: [{
          id: 'visible-item',
          text,
          html: text,
          done: false,
          startMinutes: 540,
          endMinutes: 570,
          timeHidden: false,
          children: [],
        }],
      }],
      goals: [],
      goalCompletions: [],
      listTemplates: [],
      lists: [],
      metrics: [],
      metricEntries: [],
      notes: [],
      operations: [],
    })
    let storedState = stateWithItem('Local version')
    const syncedState = stateWithItem('Synced version')

    runtime.isTauri = true
    runtime.__syncAttemptCount = 0
    runtime.__syncSettingsCount = 0
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
            runtime.__syncSettingsCount += 1
            if (new URLSearchParams(location.search).has('hold-settings')) {
              return new Promise(() => undefined)
            }
            if (
              new URLSearchParams(location.search).has('hold-second-settings') &&
              runtime.__syncSettingsCount > 1
            ) {
              return new Promise(() => undefined)
            }
            return {
              enabled: true,
              pairingCode: 'BALSYNC1:synthetic-test-code',
              relayUrl: 'https://relay.invalid/test',
            }
          case 'sync_relay_once':
            runtime.__syncAttemptCount += 1
            if (new URLSearchParams(location.search).has('launch-then-hold')) {
              if (runtime.__syncAttemptCount > 1) return new Promise(() => undefined)
              return {
                pulledOperations: 0,
                pushedOperations: 0,
                stateChanged: false,
                checkpointCommitted: false,
                epoch: 'synthetic',
                latestSequence: 1,
              }
            }
            if (new URLSearchParams(location.search).has('background-updated')) {
              storedState = syncedState
              return {
                pulledOperations: 0,
                pushedOperations: 0,
                stateChanged: false,
                checkpointCommitted: false,
                epoch: 'synthetic',
                latestSequence: 1,
              }
            }
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
          case 'sync_p2p_serve':
            return null
          case 'sync_p2p_peers':
            return []
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

test('a slow settings read does not cover the app with sync progress', async ({ page }) => {
  await page.goto('/?hold-settings=1')

  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await expect(page.getByText('Reading sync settings…')).toHaveCount(0)
  await expect(page.getByText('Waiting for database access…')).toHaveCount(0)

  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __syncSettingsCount: number }
    return runtime.__syncSettingsCount
  })).toBe(1)
})

test('a slow launch sync leaves local state visible without a progress banner', async ({ page }) => {
  await page.goto('/?hold-sync=1')

  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await expect(page.getByText('Checking for changes…')).toHaveCount(0)
})

test('settings stay available while a launch sync is still running', async ({ page }) => {
  await page.goto('/?hold-sync=1&hold-second-settings=1')

  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __syncAttemptCount: number }
    return runtime.__syncAttemptCount
  })).toBe(1)
  await page.getByRole('button', { name: /Settings/ }).click()

  await expect(page.getByText('Loading sync settings…')).toHaveCount(0)
  await expect(page.getByText('BALSYNC1:synthetic-test-code')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __syncSettingsCount: number }
    return runtime.__syncSettingsCount
  })).toBe(1)
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

test('launch reloads visible state even when a background pass already consumed the changes', async ({ page }) => {
  await page.goto('/?background-updated=1')

  await expect(page.getByText('Synced version')).toBeVisible()
  await expect(page.getByText('Local version')).toHaveCount(0)
  await expect(page.getByText('Checking for changes…')).toHaveCount(0)
})

test('routine sync checks stay quiet without resetting launch completion', async ({ page }) => {
  await page.goto('/?launch-then-hold=1')

  await expect.poll(() => readSyncStatus(page)).toEqual({
    running: false,
    initialSyncComplete: true,
  })

  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __syncAttemptCount: number }
    return runtime.__syncAttemptCount
  })).toBe(2)
  await expect.poll(() => readSyncStatus(page)).toEqual({
    running: true,
    initialSyncComplete: true,
  })

  await expect(page.getByText('Checking for changes…')).toHaveCount(0)
  await expect(page.getByText('Reading sync settings…')).toHaveCount(0)
  await expect(page.getByText('Waiting for database access…')).toHaveCount(0)
})
