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
      __stateReadCount: number
      __persistOperationCount: number
      __persistedOperationIds: string[]
      __reloadReadStarted: boolean
      __syncSettingsBlocked: boolean
      __syncSawPendingEdit: boolean
      __releaseLaunchSync?: () => void
      __releaseReloadRead?: () => void
      __releaseSyncSettings?: () => void
      __storedState: string
      __taskDisappeared: boolean
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
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
      preferences: { themeId: 'iridescent' },
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
    runtime.__stateReadCount = 0
    runtime.__persistOperationCount = 0
    runtime.__persistedOperationIds = []
    runtime.__reloadReadStarted = false
    runtime.__syncSettingsBlocked = false
    runtime.__syncSawPendingEdit = false
    runtime.__storedState = storedState
    runtime.__taskDisappeared = false
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
    runtime.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case 'read_app_state': {
            runtime.__stateReadCount += 1
            if (
              new URLSearchParams(location.search).has('edit-during-launch-reload') &&
              runtime.__stateReadCount === 2
            ) {
              const snapshotBeforeEdit = storedState
              runtime.__reloadReadStarted = true
              await new Promise<void>((resolve) => {
                runtime.__releaseReloadRead = resolve
              })
              return snapshotBeforeEdit
            }
            return storedState
          }
          case 'persist_operation': {
            runtime.__persistOperationCount += 1
            const operation = JSON.parse(String(args?.operationJson)) as {
              id: string
              sequence: number
              type: string
              payload?: {
                planId?: string
                itemId?: string
                item?: {
                  id: string
                  text: string
                  html: string
                  done: boolean
                  startMinutes: number | null
                  endMinutes: number | null
                  children: unknown[]
                }
                patch?: { text?: string, html?: string }
              }
            }
            runtime.__persistedOperationIds.push(operation.id)
            const state = JSON.parse(storedState) as {
              localSequence: number
              plans: Array<{
                id: string
                items: Array<{
                  id: string
                  text: string
                  html: string
                  done: boolean
                  startMinutes: number | null
                  endMinutes: number | null
                  children: unknown[]
                }>
              }>
            }
            const plan = state.plans.find((candidate) => candidate.id === operation.payload?.planId)
            if (operation.type === 'add_plan_item' && plan && operation.payload?.item) {
              plan.items.push(operation.payload.item)
            }
            if (operation.type === 'patch_plan_item' && plan && operation.payload?.itemId) {
              const item = plan.items.find((candidate) => candidate.id === operation.payload?.itemId)
              if (item) Object.assign(item, operation.payload.patch)
            }
            state.localSequence = operation.sequence
            storedState = JSON.stringify(state)
            runtime.__storedState = storedState
            return null
          }
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
            if (new URLSearchParams(location.search).has('resume-with-pending-edit')) {
              runtime.__syncSettingsBlocked = true
              await new Promise<void>((resolve) => {
                runtime.__releaseSyncSettings = resolve
              })
            }
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
            if (new URLSearchParams(location.search).has('resume-with-pending-edit')) {
              runtime.__syncSawPendingEdit = storedState.includes('Offline phone task')
              const state = JSON.parse(storedState) as {
                plans: Array<{ items: Array<Record<string, unknown>> }>
              }
              if (!runtime.__syncSawPendingEdit) state.plans[0].items = []
              if (!state.plans[0].items.some((item) => item.id === 'remote-item')) {
                state.plans[0].items.push({
                  id: 'remote-item',
                  text: 'Remote Mac task',
                  html: 'Remote Mac task',
                  done: false,
                  startMinutes: null,
                  endMinutes: null,
                  timeHidden: false,
                  children: [],
                })
              }
              storedState = JSON.stringify(state)
              runtime.__storedState = storedState
              return {
                pulledOperations: 8,
                pushedOperations: runtime.__syncSawPendingEdit ? 1 : 0,
                stateChanged: true,
                checkpointCommitted: false,
                epoch: 'synthetic',
                latestSequence: 8,
              }
            }
            if (new URLSearchParams(location.search).has('edit-during-launch-reload')) {
              await new Promise<void>((resolve) => {
                runtime.__releaseLaunchSync = resolve
              })
              storedState = syncedState
              runtime.__storedState = storedState
              return {
                pulledOperations: 12,
                pushedOperations: 0,
                stateChanged: true,
                checkpointCommitted: false,
                epoch: 'synthetic',
                latestSequence: 12,
              }
            }
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
  const syncStatus = page.getByRole('status', { name: 'Sync status: Syncing' })
  await expect(syncStatus).toBeVisible()
  await expect(syncStatus.locator('.sync-status-dot')).toHaveCSS('background-image', /conic-gradient/)
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
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __stateReadCount: number }
    return runtime.__stateReadCount
  })).toBe(2)
})

test('a task typed while the launch reload is reading never disappears', async ({ page }) => {
  await page.goto('/?edit-during-launch-reload=1')

  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __syncAttemptCount: number }
    return runtime.__syncAttemptCount
  })).toBe(1)
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __releaseLaunchSync?: () => void }
    runtime.__releaseLaunchSync?.()
  })
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __reloadReadStarted: boolean }
    return runtime.__reloadReadStarted
  })).toBe(true)

  await page.getByRole('button', { name: '+ Add item' }).click()
  const newTask = page.getByRole('textbox', { name: 'Plan item' }).last()
  await newTask.click()
  await page.keyboard.type('Typed during sync')
  await expect(page.getByText('Typed during sync')).toBeVisible()

  await page.evaluate(async () => {
    const storePath = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ storePath)
    let trackedTaskId = ''
    const findTrackedTask = (state: {
      plans: Array<{ items: Array<{ id: string, text: string }> }>
    }) => state.plans.flatMap((plan) => plan.items).find((item) => item.text === 'Typed during sync')
    const capture = plannerStore.subscribe((state) => {
      const task = findTrackedTask(state)
      if (!trackedTaskId && task) trackedTaskId = task.id
      if (trackedTaskId && !state.plans.some((plan) => plan.items.some((item) => item.id === trackedTaskId))) {
        const runtime = globalThis as typeof globalThis & { __taskDisappeared: boolean }
        runtime.__taskDisappeared = true
      }
    })
    void capture
  })
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __releaseReloadRead?: () => void }
    runtime.__releaseReloadRead?.()
  })

  await expect(page.getByText('Typed during sync')).toBeVisible()
  await expect(page.getByText('Synced version')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      __stateReadCount: number
      __persistOperationCount: number
      __persistedOperationIds: string[]
      __storedState: string
      __taskDisappeared: boolean
    }
    return {
      reads: runtime.__stateReadCount,
      persistedOperations: runtime.__persistOperationCount >= 2,
      duplicateOperations: new Set(runtime.__persistedOperationIds).size !== runtime.__persistedOperationIds.length,
      stored: runtime.__storedState.includes('Typed during sync'),
      disappeared: runtime.__taskDisappeared,
    }
  })).toEqual({ reads: 3, persistedOperations: true, duplicateOperations: false, stored: true, disappeared: false })
})

test('a pending offline phone edit is durable before resume sync reconciles Mac changes', async ({ page }) => {
  await page.goto('/?resume-with-pending-edit=1')

  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __syncSettingsBlocked: boolean }
    return runtime.__syncSettingsBlocked
  })).toBe(true)

  await page.evaluate(async () => {
    const storePath = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ storePath)
    plannerStore.patchPlanItem('local-plan', 'visible-item', {
      text: 'Offline phone task',
      html: 'Offline phone task',
    })
    const runtime = globalThis as typeof globalThis & { __releaseSyncSettings?: () => void }
    runtime.__releaseSyncSettings?.()
  })

  await expect(page.getByText('Offline phone task')).toBeVisible()
  await expect(page.getByText('Remote Mac task')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      __persistOperationCount: number
      __syncAttemptCount: number
      __syncSawPendingEdit: boolean
      __storedState: string
    }
    return {
      persistedBeforeSync: runtime.__syncSawPendingEdit,
      persisted: runtime.__persistOperationCount >= 1,
      synced: runtime.__syncAttemptCount >= 1,
      stored: runtime.__storedState.includes('Offline phone task'),
    }
  })).toEqual({ persistedBeforeSync: true, persisted: true, synced: true, stored: true })
})

test('concurrent backend reload callers share one stable database read', async ({ page }) => {
  await page.goto('/?launch-then-hold=1')
  await expect.poll(() => readSyncStatus(page)).toEqual({
    running: false,
    initialSyncComplete: true,
  })

  const readsBefore = await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __stateReadCount: number }
    return runtime.__stateReadCount
  })
  await page.evaluate(async () => {
    const storePath = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ storePath)
    await Promise.all([plannerStore.reloadFromBackend(), plannerStore.reloadFromBackend()])
  })
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __stateReadCount: number }
    return runtime.__stateReadCount
  })).toBe(readsBefore + 1)
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

test('edit-triggered syncs stay silent', async ({ page }) => {
  await page.goto('/?launch-then-hold=1')

  await expect.poll(() => readSyncStatus(page)).toEqual({
    running: false,
    initialSyncComplete: true,
  })
  await page.evaluate(async () => {
    const schedulerPath = '/src/lib/syncScheduler.ts'
    const scheduler = await import(/* @vite-ignore */ schedulerPath)
    void scheduler.requestSync('edit')
  })

  await expect.poll(() => readSyncStatus(page)).toEqual({
    running: true,
    initialSyncComplete: true,
  })
  await expect(page.getByRole('status', { name: /^Sync status:/ })).toHaveCount(0)
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
