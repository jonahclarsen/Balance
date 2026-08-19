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

async function openSettings(page: Page) {
  const openNavigation = page.getByRole('button', { name: 'Open navigation' })
  if (await openNavigation.isVisible()) await openNavigation.click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
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

test('a slow launch sync leaves local state visible with a subtle status cue', async ({ page }, testInfo) => {
  await page.goto('/?hold-sync=1')

  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await expect(page.getByRole('status', { name: 'Sync status: Syncing' })).toBeVisible()
  await expect(page.getByText('Checking for changes…')).toHaveCount(0)
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-initial-sync-status.png`,
    fullPage: false,
  })
})

test('settings stay available while a launch sync is still running', async ({ page }) => {
  await page.goto('/?hold-sync=1&hold-second-settings=1')

  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __syncAttemptCount: number }
    return runtime.__syncAttemptCount
  })).toBe(1)
  await openSettings(page)

  await expect(page.getByText('Loading sync settings…')).toHaveCount(0)
  await expect(page.getByText('BALSYNC1:synthetic-test-code')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __syncSettingsCount: number }
    return runtime.__syncSettingsCount
  })).toBe(1)
})

test('settings no longer expose retired migration cleanup controls', async ({ page }) => {
  await page.goto('/?launch-then-hold=1')

  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await openSettings(page)

  await expect(page.getByText('Temporary migration cleanup audit')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Run removal audit' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Finalize cleanup now' })).toHaveCount(0)
})

test('an unsuccessful launch sync retries with a subtle status cue', async ({ page }, testInfo) => {
  await page.goto('/')

  await expect(page.getByRole('status', { name: 'Sync status: Retrying' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Retry now' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()

  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __syncAttemptCount: number }
    return runtime.__syncAttemptCount
  })).toBe(1)

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-sync-retrying-status.png`,
    fullPage: false,
  })
})

test('an offline device shows a quiet offline status', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    window.dispatchEvent(new Event('offline'))
  })

  await expect(page.getByRole('status', { name: 'Sync status: Offline' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('launch reloads visible state even when a background pass already consumed the changes', async ({ page }) => {
  await page.goto('/?background-updated=1')

  await expect(page.getByText('Synced version')).toBeVisible()
  await expect(page.getByText('Local version')).toHaveCount(0)
  await expect(page.getByRole('status', { name: /^Sync status:/ })).toHaveCount(0)
  await expect(page.getByText('Checking for changes…')).toHaveCount(0)
})

test('routine sync checks stay silent without resetting launch completion', async ({ page }) => {
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

  await expect(page.getByRole('status', { name: /^Sync status:/ })).toHaveCount(0)
  await expect(page.getByText('Checking for changes…')).toHaveCount(0)
  await expect(page.getByText('Reading sync settings…')).toHaveCount(0)
  await expect(page.getByText('Waiting for database access…')).toHaveCount(0)
})

test('a manual sync still uses the subtle syncing status', async ({ page }) => {
  await page.goto('/?launch-then-hold=1')

  await expect.poll(() => readSyncStatus(page)).toEqual({
    running: false,
    initialSyncComplete: true,
  })
  await page.evaluate(async () => {
    const schedulerPath = '/src/lib/syncScheduler.ts'
    const scheduler = await import(/* @vite-ignore */ schedulerPath)
    void scheduler.requestSync('manual')
  })

  await expect.poll(() => readSyncStatus(page)).toEqual({
    running: true,
    initialSyncComplete: true,
  })
  await expect(page.getByRole('status', { name: 'Sync status: Syncing' })).toBeVisible()
})
