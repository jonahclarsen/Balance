import { expect, test } from '@playwright/test'

const playwrightOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '5123'}`

test('today indicator stays visible after the page header scrolls away', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const primaryPane = page.getByRole('region', { name: 'Daily plan' })
  const todayDate = await primaryPane.locator('.date-input').inputValue()
  await primaryPane.getByRole('button', { name: 'Compare with another day' }).click()
  const comparePane = page.getByRole('region', { name: 'Compared day' })
  await expect(comparePane).toBeVisible()
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1000, height: 450 })

  await expect(page.locator('.current-day-scroll-indicator')).toHaveCount(0)
  if (testInfo.project.name === 'mobile') await page.evaluate(() => window.scrollTo(0, 500))
  else await primaryPane.evaluate((pane) => pane.scrollTo(0, 200))

  const pinnedToday = page.locator('.current-day-scroll-indicator .current-day-indicator')
  await expect(pinnedToday).toBeVisible()
  const markerBox = await pinnedToday.boundingBox()
  expect(markerBox).not.toBeNull()
  expect(markerBox?.y ?? Number.MAX_SAFE_INTEGER).toBeLessThan(testInfo.project.name === 'mobile' ? 20 : 40)
  if (testInfo.project.name === 'desktop') {
    const primaryBox = await primaryPane.boundingBox()
    expect(markerBox?.x ?? 0).toBeGreaterThan(primaryBox?.x ?? Number.MAX_SAFE_INTEGER)
    expect((markerBox?.x ?? Number.MAX_SAFE_INTEGER) + (markerBox?.width ?? 0)).toBeLessThanOrEqual(
      (primaryBox?.x ?? 0) + (primaryBox?.width ?? 0),
    )
  }

  await primaryPane.locator('.date-input').fill(addDays(todayDate, 1))
  await expect(page.locator('.current-day-scroll-indicator')).toHaveCount(0)

  await comparePane.locator('.date-input').fill(todayDate)
  if (testInfo.project.name === 'mobile') await page.evaluate(() => window.scrollTo(0, 500))
  else await comparePane.evaluate((pane) => pane.scrollTo(0, 200))
  await expect(pinnedToday).toBeVisible()
  if (testInfo.project.name === 'desktop') {
    const compareBox = await comparePane.boundingBox()
    const comparedMarkerBox = await pinnedToday.boundingBox()
    expect(comparedMarkerBox?.x ?? 0).toBeGreaterThan(compareBox?.x ?? Number.MAX_SAFE_INTEGER)
    expect((comparedMarkerBox?.x ?? Number.MAX_SAFE_INTEGER) + (comparedMarkerBox?.width ?? 0)).toBeLessThanOrEqual(
      (compareBox?.x ?? 0) + (compareBox?.width ?? 0),
    )
  }
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-today-indicator-scrolled-split.png`,
    fullPage: false,
  })
})

test('desktop sidebar hides, returns, and remembers its state', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  const sidebar = page.getByRole('complementary')
  const hideSidebar = page.getByRole('button', { name: 'Hide sidebar' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })

  if (testInfo.project.name === 'mobile') {
    await expect(sidebar).toBeVisible()
    await expect(hideSidebar).toBeHidden()
    await page.evaluate(() => localStorage.setItem('balance:sidebarHidden', 'true'))
    await page.reload()
    await expect(sidebar).toBeVisible()
    await expect(showSidebar).toBeHidden()
    return
  }

  await expect(sidebar).toBeVisible()
  const openToggleBox = await hideSidebar.boundingBox()
  const templateSelectBox = await sidebar.getByRole('combobox').boundingBox()
  const generateButtonBox = await sidebar.getByRole('button', { name: 'Generate today' }).boundingBox()
  const toggleIconBox = await hideSidebar.locator('svg').boundingBox()
  expect(openToggleBox).not.toBeNull()
  expect(templateSelectBox).not.toBeNull()
  expect(generateButtonBox).not.toBeNull()
  expect(toggleIconBox).not.toBeNull()
  expect(Math.abs((templateSelectBox?.x ?? 0) - (generateButtonBox?.x ?? 0))).toBeLessThan(1)
  expect(Math.abs((templateSelectBox?.width ?? 0) - (generateButtonBox?.width ?? 0))).toBeLessThan(1)
  expect((openToggleBox?.y ?? 0) + (openToggleBox?.height ?? 0) / 2).toBeGreaterThan(
    (templateSelectBox?.y ?? 0) + (templateSelectBox?.height ?? 0),
  )
  expect((openToggleBox?.y ?? 0) + (openToggleBox?.height ?? 0) / 2).toBeLessThan(generateButtonBox?.y ?? 0)
  expect(
    Math.abs(
      (openToggleBox?.x ?? 0) + (openToggleBox?.width ?? 0) / 2
        - ((toggleIconBox?.x ?? 0) + (toggleIconBox?.width ?? 0) / 2),
    ),
  ).toBeLessThan(1)
  expect(
    Math.abs(
      (openToggleBox?.y ?? 0) + (openToggleBox?.height ?? 0) / 2
        - ((toggleIconBox?.y ?? 0) + (toggleIconBox?.height ?? 0) / 2),
    ),
  ).toBeLessThan(1)
  await hideSidebar.click()
  await expect(sidebar).toBeHidden()
  await expect(showSidebar).toBeVisible()
  const closedToggleBox = await showSidebar.boundingBox()
  expect(closedToggleBox).not.toBeNull()
  expect(Math.abs((openToggleBox?.y ?? 0) - (closedToggleBox?.y ?? 0))).toBeLessThan(1)
  expect(closedToggleBox?.height).toBe(openToggleBox?.height)

  await page.reload()
  await expect(sidebar).toBeHidden()
  await expect(showSidebar).toBeVisible()

  await showSidebar.click()
  await expect(sidebar).toBeVisible()
  await expect(hideSidebar).toBeVisible()
})

test('IMAX mode maximizes Today and restores its surrounding panels', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  const primaryPane = page.getByRole('region', { name: 'Daily plan' })
  const imaxButton = primaryPane.getByRole('button', { name: 'Enter IMAX mode' })
  const dateInput = primaryPane.locator('.date-input')
  const goalRhythm = page.getByRole('region', { name: 'Goal history' })

  await expect(imaxButton).toBeVisible()
  await expect(primaryPane.getByRole('button', { name: 'Previous day' })).toHaveCount(0)
  await expect(primaryPane.getByRole('button', { name: 'Next day' })).toHaveCount(0)
  const imaxBox = await imaxButton.boundingBox()
  const dateBox = await dateInput.boundingBox()
  expect(imaxBox).not.toBeNull()
  expect(dateBox).not.toBeNull()
  expect(imaxBox?.x ?? Number.MAX_SAFE_INTEGER).toBeLessThan(dateBox?.x ?? 0)
  expect(dateBox?.width ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(130)
  await expect(goalRhythm).toBeVisible()

  await imaxButton.click()
  await expect(primaryPane.getByRole('button', { name: 'Exit IMAX mode' })).toHaveAttribute('aria-pressed', 'true')
  await expect(goalRhythm).toHaveCount(0)
  if (testInfo.project.name === 'desktop') {
    await expect(page.getByRole('complementary')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeHidden()
  }

  await primaryPane.getByRole('button', { name: 'Exit IMAX mode' }).click()
  await expect(imaxButton).toHaveAttribute('aria-pressed', 'false')
  await expect(goalRhythm).toBeVisible()
  if (testInfo.project.name === 'desktop') await expect(page.getByRole('complementary')).toBeVisible()
})

test('sidebar shows the task time shortcut legend above the template selector', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  const sidebar = page.getByRole('complementary')
  const legend = sidebar.getByRole('region', { name: 'Task time shortcuts' })

  if (testInfo.project.name === 'mobile') {
    await expect(legend).toBeHidden()
    return
  }

  await expect(legend).toBeVisible()
  await expect(legend.getByRole('row', { name: /Toggle/ })).toContainText('T')
  await expect(legend.getByRole('row', { name: /Start/ })).toContainText('[ / ]')
  await expect(legend.getByRole('row', { name: /End/ })).toContainText('[ / ]')
  await expect(legend.getByRole('row', { name: /Both/ })).toContainText('[ / ]')

  const isMacPlatform = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent))
  await expect(legend.getByRole('row', { name: /Toggle/ })).toContainText(isMacPlatform ? '⌥⇧T' : 'Alt+Shift+T')
  await expect(legend.getByRole('row', { name: /End/ })).toContainText(isMacPlatform ? '⌘[ / ]' : 'Ctrl+[ / ]')

  const legendBox = await legend.boundingBox()
  const templateBox = await sidebar.getByText('Template for new days', { exact: true }).boundingBox()
  const sidebarBox = await sidebar.boundingBox()
  const generateButtonBox = await sidebar.getByRole('button', { name: 'Generate today' }).boundingBox()
  expect(legendBox).not.toBeNull()
  expect(templateBox).not.toBeNull()
  expect(sidebarBox).not.toBeNull()
  expect(generateButtonBox).not.toBeNull()
  expect((legendBox?.y ?? Number.MAX_SAFE_INTEGER) + (legendBox?.height ?? 0)).toBeLessThan(templateBox?.y ?? 0)
  expect((generateButtonBox?.y ?? 0) + (generateButtonBox?.height ?? 0)).toBeLessThanOrEqual(
    (sidebarBox?.y ?? 0) + (sidebarBox?.height ?? 0),
  )
})

test('core planner screens render and screenshot cleanly', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await expect(page.getByRole('heading', { name: 'Balance' })).toBeVisible()
  const generateButton = page.getByRole('complementary').getByRole('button', { name: 'Generate today' })
  await expect(generateButton).toBeVisible()
  await expect(page.locator('.current-day-indicator')).toHaveText('Today')

  await generateButton.click()
  await expect(page.locator('[data-plan-text-input]').first()).toBeVisible()
  const renderedDate = await page.locator('.date-input').inputValue()
  await page.keyboard.press('Alt+W')
  await expect(page.locator('.date-input')).toHaveValue(addDays(renderedDate, 1))
  await page.keyboard.press('Alt+Q')
  await expect(page.locator('.date-input')).toHaveValue(renderedDate)
  await expect(page.getByRole('button', { name: 'Drag to move item' }).first()).toBeVisible()
  await expect
    .poll(async () =>
      page.getByRole('button', { name: 'Drag to move item' }).first().evaluate((handle) => {
        const dots = handle.querySelector('.handle-dots')
        if (!(dots instanceof HTMLElement)) return false
        const style = getComputedStyle(dots)
        const box = dots.getBoundingClientRect()
        return box.width >= 12 && box.height >= 16 && style.backgroundImage.includes('radial-gradient')
      }),
    )
    .toBe(true)
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-today.png`,
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Day Templates' }).click()
  await expect(page.getByRole('heading', { name: 'Daily template' })).toBeVisible()
  await expect(page.getByLabel('Template name')).toHaveValue('Default day')
  await expect(page.getByRole('navigation', { name: 'Select day template' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Default day', exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('button', { name: 'Drag to move template item' }).first()).toBeVisible()
  await expect
    .poll(async () =>
      page.getByRole('button', { name: 'Drag to move template item' }).first().evaluate((handle) => {
        const dots = handle.querySelector('.handle-dots')
        if (!(dots instanceof HTMLElement)) return false
        const style = getComputedStyle(dots)
        const box = dots.getBoundingClientRect()
        return box.width >= 12 && box.height >= 16 && style.backgroundImage.includes('radial-gradient')
      }),
    )
    .toBe(true)
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-templates.png`,
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Manual export' })).toBeVisible()
  if (testInfo.project.name === 'mobile') {
    await expect(page.getByRole('button', { name: 'Export JSON' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Canonical JSON' })).toHaveCount(0)
  } else {
    await expect(page.getByRole('button', { name: 'Export JSON' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Database encryption key' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Rotate database key' })).toBeDisabled()
  }
  await expect(page.getByRole('button', { name: 'Export HTML' })).toBeVisible()
  await expect(page.getByText('Browser downloads')).toBeVisible()
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-settings.png`,
    fullPage: true,
  })
})

test('settings opens recovery and diagnostics above goal rhythm', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  const goalRhythm = page.getByRole('region', { name: 'Goal history' })
  await expect(goalRhythm).toBeVisible()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const openRecovery = page.getByRole('button', { name: 'Open recovery & diagnostics' })
  await expect(openRecovery).toBeVisible()
  await openRecovery.click()

  const dialog = page.getByRole('dialog', { name: 'Restore removed items' })
  await expect(dialog).toBeVisible()

  const stacking = await page.evaluate(() => {
    const backdrop = document.querySelector<HTMLElement>('.modal-backdrop')
    const rhythm = document.querySelector<HTMLElement>('.goal-history-panel')
    if (!backdrop || !rhythm) return null

    const rhythmRect = rhythm.getBoundingClientRect()
    const visibleLeft = Math.max(0, rhythmRect.left)
    const visibleRight = Math.min(window.innerWidth, rhythmRect.right)
    const visibleTop = Math.max(0, rhythmRect.top)
    const visibleBottom = Math.min(window.innerHeight, rhythmRect.bottom)
    const hasVisibleOverlap = visibleRight > visibleLeft && visibleBottom > visibleTop
    const backdropZIndex = Number.parseInt(getComputedStyle(backdrop).zIndex, 10)
    const rhythmZIndex = Number.parseInt(getComputedStyle(rhythm).zIndex, 10)
    if (!hasVisibleOverlap) {
      return { backdropZIndex, rhythmZIndex, hasVisibleOverlap, backdropOwnsTopElement: false }
    }

    const topElement = document.elementFromPoint(
      visibleLeft + Math.min(12, (visibleRight - visibleLeft) / 2),
      visibleTop + Math.min(12, (visibleBottom - visibleTop) / 2),
    )
    return {
      backdropZIndex,
      rhythmZIndex,
      hasVisibleOverlap,
      backdropOwnsTopElement: Boolean(topElement && backdrop.contains(topElement)),
    }
  })

  expect(stacking).not.toBeNull()
  expect(stacking?.backdropZIndex).toBeGreaterThan(stacking?.rhythmZIndex ?? Number.MAX_SAFE_INTEGER)
  if (stacking?.hasVisibleOverlap) expect(stacking.backdropOwnsTopElement).toBe(true)

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-recovery-diagnostics-modal.png`,
    fullPage: true,
  })

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
})

test('threshold-based launch housekeeping never blocks the app with a maintenance dialog', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    type TestRuntime = typeof globalThis & {
      isTauri: boolean
      __finishDatabaseMaintenance: () => void
      __finishDatabaseStartup: () => void
      __databaseStartupCalls: string[]
      __TAURI_INTERNALS__: {
        invoke: (command: string) => Promise<unknown>
        transformCallback: () => number
      }
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => void
      }
    }
    const runtime = globalThis as TestRuntime
    let maintenanceComplete = false
    let finishMaintenance: (() => void) | null = null
    let finishStartup: (() => void) | null = null

    Object.defineProperty(navigator, 'userAgent', { value: 'Balance Android CI', configurable: true })
    runtime.isTauri = true
    runtime.__databaseStartupCalls = []
    runtime.__finishDatabaseStartup = () => finishStartup?.()
    runtime.__finishDatabaseMaintenance = () => finishMaintenance?.()
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
    runtime.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command: string) => {
        if (command === 'read_app_state' || command === 'plugin:event|listen') {
          runtime.__databaseStartupCalls.push(command)
        }
        switch (command) {
          case 'read_app_state':
            return new Promise((resolve) => {
              finishStartup = () => resolve(null)
            })
          case 'plugin:event|listen':
            // Android may not finish registering this optional listener before
            // startup. Database hydration must proceed independently.
            return new Promise(() => undefined)
          case 'initialize_app_state':
          case 'plugin:event|unlisten':
          case 'complete_database_maintenance_startup':
            return null
          case 'get_recovery_key_status':
            return {
              confirmed: true,
              recoveryKey: null,
              databasePath: '/tmp/balance.sqlite3',
            }
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
            return { enabled: false, pairingCode: null, relayUrl: '' }
          case 'build_info':
            return { version: 'test', commit: 'test' }
          case 'get_database_maintenance_status':
            return {
              due: !maintenanceComplete,
              lastCompletedAt: maintenanceComplete ? 'unix-ms-2000000000000' : null,
              checkpointCoordinator: true,
              databaseBytes: 80 * 1024 * 1024,
              reclaimableBytes: maintenanceComplete ? 0 : 24 * 1024 * 1024,
              reclaimablePercent: maintenanceComplete ? 0 : 30,
              operationCount: 1,
              operationBytes: 128,
              checkpointRecommended: false,
            }
          case 'run_database_maintenance_if_needed':
            return new Promise((resolve) => {
              finishMaintenance = () => {
                maintenanceComplete = true
                resolve({
                  beforeBytes: 8 * 1024 * 1024,
                  afterBytes: 2 * 1024 * 1024,
                  reclaimedBytes: 6 * 1024 * 1024,
                  operationsRemoved: 0,
                  historyEntriesRemoved: 0,
                  backupPath: '/tmp/balance-daily.sqlite3',
                  checkpointCreated: false,
                })
              }
            })
          default:
            return null
        }
      },
    }
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __databaseStartupCalls: string[] }
    return runtime.__databaseStartupCalls
  })).toEqual(['read_app_state'])
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __finishDatabaseStartup: () => void }
    runtime.__finishDatabaseStartup()
  })
  await expect(page.getByRole('dialog', { name: /database/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __databaseStartupCalls: string[] }
    return runtime.__databaseStartupCalls[0]
  })).toBe('read_app_state')

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-background-database-housekeeping.png`,
    fullPage: false,
  })

  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __finishDatabaseMaintenance: () => void }
    runtime.__finishDatabaseMaintenance()
  })
  await expect(page.getByRole('dialog', { name: /database/i })).toHaveCount(0)
})

test('recovery-key failure surfaces even if state hydration remains blocked', async ({ page }) => {
  await page.addInitScript(() => {
    type TestRuntime = typeof globalThis & {
      isTauri: boolean
      __TAURI_INTERNALS__: {
        invoke: (command: string) => Promise<unknown>
        transformCallback: () => number
      }
    }
    const runtime = globalThis as TestRuntime
    Object.defineProperty(navigator, 'userAgent', { value: 'Balance Android CI', configurable: true })
    runtime.isTauri = true
    runtime.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command: string) => {
        if (command === 'read_app_state') return new Promise(() => undefined)
        if (command === 'get_recovery_key_status') {
          throw 'The encrypted Balance database exists, but its recovery key is unavailable.'
        }
        return null
      },
    }
  })

  await page.goto('/')
  await expect(page.getByRole('alertdialog', { name: /couldn.t open your encrypted database/i })).toBeVisible()
  await expect(page.getByText(/recovery key is unavailable/i)).toBeVisible()
})

test('empty days show every template and require an explicit selection', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Day Templates' }).click()
  await page.getByRole('button', { name: 'New day', exact: true }).click()
  await expect(page.getByLabel('Template name')).toHaveValue('New day')
  await page.getByLabel('Template name').fill('Weekend')
  await page.getByRole('textbox', { name: 'Template item' }).fill('Rest')

  const weekendTab = page.getByRole('button', { name: 'Weekend', exact: true })
  const selectedTemplateId = await weekendTab.getAttribute('data-day-template-tab-id')
  expect(selectedTemplateId).toBeTruthy()
  await expect(page.locator('[data-day-template-tab-id]')).toHaveCount(2)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('balance:selectedDayTemplateId')))
    .toBe(selectedTemplateId)

  const defaultDayTab = page.getByRole('button', { name: 'Default day', exact: true })
  await page.keyboard.press('Alt+Q')
  await expect(defaultDayTab).toHaveAttribute('aria-current', 'true')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('balance:selectedDayTemplateId'))).not.toBe(selectedTemplateId)
  await page.keyboard.press('Alt+W')
  await expect(weekendTab).toHaveAttribute('aria-current', 'true')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('balance:selectedDayTemplateId')))
    .toBe(selectedTemplateId)

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  const firstDay = await page.locator('.date-input').inputValue()
  const emptyState = page.locator('.empty-state')
  await expect(emptyState.getByRole('group', { name: 'Day template' })).toBeVisible()
  await expect(emptyState.getByRole('radio')).toHaveCount(2)
  await expect(emptyState.getByRole('radio', { checked: true })).toHaveCount(0)
  await expect(emptyState.getByRole('button', { name: 'Generate today' })).toBeDisabled()
  await emptyState.getByRole('radio', { name: 'Weekend' }).check()
  await expect(emptyState.getByRole('button', { name: 'Generate today' })).toBeEnabled()
  await emptyState.getByRole('button', { name: 'Generate today' }).click()
  await expect(page.locator('[data-plan-text-input]').filter({ hasText: 'Rest' })).toBeVisible()

  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(page.locator('.date-input')).toHaveValue(addDays(firstDay, 1))
  await expect(page.locator('.empty-state').getByRole('radio', { checked: true })).toHaveCount(0)
  await expect(page.locator('.empty-state').getByRole('button', { name: 'Generate selected day' })).toBeDisabled()

  await page.reload()
  await expect(page.locator('.empty-state').getByRole('radio')).toHaveCount(2)
  await expect(page.locator('.empty-state').getByRole('radio', { checked: true })).toHaveCount(0)
  await page.locator('.empty-state').getByRole('radio', { name: 'Weekend' }).check()
  await page.locator('.empty-state').getByRole('button', { name: 'Generate selected day' }).click()
  await expect(page.locator('[data-plan-text-input]').filter({ hasText: 'Rest' })).toBeVisible()
})

test('every sidebar menu item has a left-hand Alt shortcut', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  const shortcuts = [
    { key: 't', label: 'Today' },
    { key: 'd', label: 'Day Templates' },
    { key: 'e', label: 'Lists' },
    { key: 'n', label: 'Notes' },
    { key: 'v', label: 'Metrics' },
    { key: 'g', label: 'Goals' },
    { key: 's', label: 'Settings' },
  ]

  await expect(page.locator('.primary-nav > button > span')).toHaveText([
    '⌕ Search',
    ...shortcuts.map(({ label }) => label),
  ])

  for (const { key, label } of shortcuts) {
    const menuItem = page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: label, exact: true })
    await expect(menuItem).toHaveAttribute('aria-keyshortcuts', `Alt+${key.toUpperCase()}`)
    await expect(menuItem.locator('.nav-shortcut')).toHaveText(new RegExp(`^(?:⌥|Alt\\+)${key.toUpperCase()}$`))
    await page.keyboard.press(`Alt+${key}`)
    await expect(menuItem).toHaveClass(/active/)
  }

  await expect(page.getByRole('button', { name: 'List History', exact: true })).toHaveCount(0)
  await page.keyboard.press('Alt+r')
  const listHistory = page.getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'List History', exact: true })
  await expect(listHistory).toBeVisible()
  await expect(listHistory).toHaveAttribute('aria-keyshortcuts', 'Alt+R')
  await expect(listHistory.locator('.nav-shortcut')).toHaveText(/^(?:⌥|Alt\+)R$/)
  await expect(listHistory).toHaveClass(/active/)

  const search = page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Search', exact: true })
  await expect(search).toHaveAttribute('aria-keyshortcuts', 'Alt+C')
  await expect(search.locator('.nav-shortcut')).toHaveText(/^(?:⌥|Alt\+)C$/)
  await page.keyboard.press('Alt+c')
  await expect(page.getByRole('dialog', { name: 'Search Balance' })).toBeVisible()
})

test('List History is an obvious contextual child of Lists', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  const primaryNav = page.getByRole('navigation', { name: 'Primary' })
  const lists = primaryNav.getByRole('button', { name: 'Lists', exact: true })
  const listHistory = primaryNav.getByRole('button', { name: 'List History', exact: true })

  await expect(listHistory).toHaveCount(0)
  await lists.click()
  await expect(page.getByRole('heading', { name: 'Lists', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View List History' }).click()

  await expect(page.getByRole('heading', { name: 'List History', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back to Lists' })).toBeVisible()
  await expect(listHistory).toBeVisible()
  await expect(listHistory).toHaveClass(/nav-child/)
  await expect(listHistory).toHaveClass(/active/)

  await primaryNav.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(listHistory).toBeVisible()
  await expect(listHistory).not.toHaveClass(/active/)

  await listHistory.click()
  await expect(page.getByRole('heading', { name: 'List History', exact: true })).toBeVisible()
  await lists.click()
  await expect(page.getByRole('heading', { name: 'Lists', exact: true })).toBeVisible()
  await expect(listHistory).toHaveCount(0)

  await page.getByRole('button', { name: 'View List History' }).click()
  await page.getByRole('button', { name: 'Back to Lists' }).click()
  await expect(page.getByRole('heading', { name: 'Lists', exact: true })).toBeVisible()
  await expect(listHistory).toHaveCount(0)
})

test('Cmd or Ctrl+F searches the current document instead of opening overall search', async ({ page }) => {
  await page.goto('/')

  await page.keyboard.press('Meta+f')
  const find = page.getByRole('search', { name: 'Find in current document' })
  await expect(find).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Search Balance' })).toHaveCount(0)

  await find.getByLabel('Find text').fill('Daily plan')
  await expect(find.locator('.find-status')).toHaveText('Match')
  await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString().toLowerCase())).toBe('daily plan')

  await page.keyboard.press('Escape')
  await expect(find).toHaveCount(0)
})

test('Cmd or Ctrl+F focuses goal search on the Goals page', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Goals', exact: true }).click()

  const goalSearch = page.locator('.goal-search-input')
  await expect(goalSearch).toHaveAttribute('placeholder', /Search goals… \((?:⌘F|Ctrl\+F)\)/)
  await page.getByLabel('New goal name').focus()
  await page.keyboard.press('Meta+f')

  await expect(goalSearch).toBeFocused()
  await expect(page.getByRole('search', { name: 'Find in current document' })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Search Balance' })).toHaveCount(0)
})

test('daily reminder edits the selected day and future days inherit it', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const currentDate = await page.locator('.date-input').inputValue()
  const nextDate = addDays(currentDate, 1)

  await page.getByRole('button', { name: /This shouldn't be aspirational/ }).click()
  await page.getByLabel('Edit daily reminder').fill('Keep it concrete')

  await expect
    .poll(async () =>
      page.evaluate((date) => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.plans?.find((plan: { date: string }) => plan.date === date)?.dailyReminder
      }, currentDate),
    )
    .toBe('Keep it concrete')

  await page.locator('.date-input').fill(nextDate)
  await page.getByRole('complementary').getByRole('button', { name: 'Generate selected day' }).click()

  await expect(page.getByRole('button', { name: /Keep it concrete/ })).toBeVisible()
  await expect
    .poll(async () =>
      page.evaluate(
        ({ currentDate, nextDate }) => {
          const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
          return {
            current: state.plans?.find((plan: { date: string }) => plan.date === currentDate)?.dailyReminder,
            next: state.plans?.find((plan: { date: string }) => plan.date === nextDate)?.dailyReminder,
          }
        },
        { currentDate, nextDate },
      ),
    )
    .toEqual({ current: 'Keep it concrete', next: 'Keep it concrete' })
})

test('checking the final item celebrates the completed day', async ({ page }) => {
  await seedPlanItems(page, ['First win', 'Final win'])

  const first = page.getByRole('listitem', { name: 'Plan item: First win' }).getByRole('checkbox')
  const final = page.getByRole('listitem', { name: 'Plan item: Final win' }).getByRole('checkbox')

  await first.check()
  await expect(page.getByRole('status', { name: 'Day finished' })).toHaveCount(0)
  await page.mouse.move(0, 0)
  await expect
    .poll(() =>
      first.evaluate((checkbox) => {
        const style = getComputedStyle(checkbox)
        return (
          style.appearance === 'none' &&
          style.backgroundColor === 'rgb(47, 111, 104)' &&
          style.backgroundImage !== 'none'
        )
      }),
    )
    .toBe(true)

  await final.check()
  await expect(page.getByRole('status', { name: 'Day finished' })).toBeVisible()
  await expect(page.locator('.celebration-canvas')).toHaveAttribute('width', /\d+/)
  await expect(page.locator('.list-celebration')).toHaveCount(0)

  await final.uncheck()
  await expect(page.getByRole('status', { name: 'Day finished' })).toHaveCount(0)

  await final.check()
  await expect(page.getByRole('status', { name: 'Day finished' })).toBeVisible()
})

test('checking the final list item celebrates the completed list', async ({ page }) => {
  await seedListItems(page, ['First errand', 'Final errand'])
  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: 'View List History' }).click()

  const first = page.getByRole('listitem', { name: 'Plan item: First errand' }).getByRole('checkbox')
  const final = page.getByRole('listitem', { name: 'Plan item: Final errand' }).getByRole('checkbox')

  await first.check()
  await expect(page.getByRole('status', { name: 'List finished' })).toHaveCount(0)

  await final.check()
  await expect(page.getByRole('status', { name: 'List finished' })).toBeVisible()
  await expect(page.getByRole('status', { name: 'Day finished' })).toHaveCount(0)
  await expect(page.locator('.list-celebration')).toBeVisible()
  await expect(page.locator('.completed-list-card')).toBeVisible()

  await final.uncheck()
  await expect(page.getByRole('status', { name: 'List finished' })).toHaveCount(0)
  await expect(page.locator('.list-celebration')).toHaveCount(0)

  await final.check()
  await expect(page.getByRole('status', { name: 'List finished' })).toBeVisible()
})

test('completing a linked list celebrates after its overlay closes', async ({ page }) => {
  await seedListItems(page, ['Pack charger', 'Pack snacks'])
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    state.plans = [
      {
        id: 'plan_with_list',
        date: state.activePlanDate,
        title: '',
        dailyReminder: '',
        items: [
          {
            id: 'list_opener',
            text: '[[Victory list]]',
            html: '[[Victory list]]',
            done: false,
            startMinutes: null,
            endMinutes: null,
            children: [],
          },
          {
            id: 'unfinished_day_item',
            text: 'Keep the day open',
            html: 'Keep the day open',
            done: false,
            startMinutes: null,
            endMinutes: null,
            children: [],
          },
        ],
      },
    ]
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()

  await page.getByRole('link', { name: 'Victory list' }).click()
  const overlay = page.getByRole('dialog', { name: 'Victory list' })
  await expect(overlay).toBeVisible()

  await overlay.getByRole('listitem', { name: 'Plan item: Pack charger' }).getByRole('checkbox').check()
  await overlay.getByRole('listitem', { name: 'Plan item: Pack snacks' }).getByRole('checkbox').click()

  await expect(overlay).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'List finished' })).toBeVisible()
  await expect(page.locator('.list-celebration')).toBeVisible()
  await expect(page.getByRole('listitem', { name: 'Plan item: [[Victory list]]' }).getByRole('checkbox')).toBeChecked()
})

test('checkbox color can be changed in settings and persists', async ({ page }) => {
  await seedPlanItems(page, ['Custom checkbox'])

  const planCheckbox = page.getByRole('listitem', { name: 'Plan item: Custom checkbox' }).getByRole('checkbox')
  await planCheckbox.check()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()

  const colorPicker = page.getByLabel('Checked checkbox color')
  await colorPicker.focus()
  await colorPicker.press('Shift+ArrowRight')
  await colorPicker.press('Shift+ArrowDown')
  const selectedColor = await page.evaluate(() => localStorage.getItem('balance:checkboxColor'))
  expect(selectedColor).toMatch(/^#[0-9a-f]{6}$/)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('balance:checkboxColor')))
    .toBe(selectedColor)
  const previewColor = await page.getByRole('checkbox', { name: 'Example checked checkbox' }).evaluate(
    (checkbox) => getComputedStyle(checkbox).backgroundColor,
  )

  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(planCheckbox).toHaveCSS('background-color', previewColor)

  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByLabel('Checked checkbox hex code')).toHaveValue(selectedColor!)
})

test('color themes update the whole palette, persist, and adapt to dark mode', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()

  const themeGroup = page.getByRole('group', { name: 'Color theme' })
  const themeButtons = themeGroup.getByRole('button')
  await expect(themeButtons).toHaveCount(8)
  await expect(themeButtons.first()).toContainText('Violet')
  const violetTheme = themeGroup.getByRole('button', { name: 'Violet Purple and soft lilac' })
  await expect(violetTheme).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'violet')
  const pinkTheme = themeGroup.getByRole('button', { name: 'Pink Bright pink and petal white' })
  await expect(pinkTheme).toHaveAttribute('aria-pressed', 'false')
  await pinkTheme.click()

  await expect(pinkTheme).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('balance:colorTheme')))
    .toBe('pink')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'pink')
  await expect(page.getByRole('complementary')).toHaveCSS('background-color', 'rgb(245, 224, 234)')
  await expect(page.getByRole('checkbox', { name: 'Example checked checkbox' })).toHaveCSS(
    'background-color',
    'rgb(211, 79, 137)',
  )

  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(pinkTheme).toHaveAttribute('aria-pressed', 'true')

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.getByRole('complementary')).toHaveCSS('background-color', 'rgb(33, 23, 28)')
  await expect(page.getByRole('checkbox', { name: 'Example checked checkbox' })).toHaveCSS(
    'background-color',
    'rgb(240, 141, 184)',
  )
})

test('interface font previews apply live to tasks and persist', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()

  const interfaceFonts = page.getByRole('group', { name: 'Interface font' })
  const interfaceFontButtons = interfaceFonts.getByRole('button')
  await expect(interfaceFontButtons).toHaveCount(7)
  await expect(interfaceFontButtons.first()).toContainText('Rounded')
  await expect(interfaceFonts.getByRole('button', { name: 'Humanist: Open and readable' })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Tasks and notes font' })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Technical text font' })).toHaveCount(0)

  const roundedInterface = interfaceFonts.getByRole('button', { name: 'Rounded: Soft and approachable' })
  await expect(roundedInterface).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCSS(
    'font-family',
    /ui-rounded|SF Pro Rounded|Arial Rounded MT Bold/,
  )

  const bookishInterface = interfaceFonts.getByRole('button', { name: 'Bookish: Elegant and literary' })
  await expect(bookishInterface.locator('.font-option-preview')).toHaveCSS(
    'font-family',
    /Palatino|Palatino Linotype|Book Antiqua/,
  )
  await bookishInterface.click()
  await expect(page.locator('html')).toHaveAttribute('data-interface-font', 'bookish')
  await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCSS(
    'font-family',
    /Palatino|Palatino Linotype|Book Antiqua/,
  )
  await expect(page.locator('.done-tint-preview .item-text')).toHaveCSS(
    'font-family',
    /Palatino|Palatino Linotype|Book Antiqua/,
  )
  await expect(page.getByLabel('Checked checkbox hex code')).toHaveCSS(
    'font-family',
    /Cascadia Mono|Roboto Mono|SFMono-Regular|Menlo/,
  )

  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(bookishInterface).toHaveAttribute('aria-pressed', 'true')
})

test('database opening messages can be customized and restored', async ({ page }) => {
  const defaultMessages = [
    'Good things come to those who briefly wait.',
    'Pretend this is an intentional mindfulness exercise.',
    'Fun fact: this message has no fun fact.',
  ]
  const customMessages = ['Reticulating splines.', 'Counting backwards from purple.']

  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()

  const messagesEditor = page.getByLabel('Database opening messages')
  await expect(messagesEditor).toHaveValue(defaultMessages.join('\n'))

  await messagesEditor.fill(customMessages.join('\n'))
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('balance:databaseLoadingMessages')))
    .toBe(JSON.stringify(customMessages))

  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(messagesEditor).toHaveValue(customMessages.join('\n'))

  await messagesEditor.fill('')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('balance:databaseLoadingMessages')))
    .toBe('[]')

  await page.getByRole('button', { name: 'Restore defaults' }).click()
  await expect(messagesEditor).toHaveValue(defaultMessages.join('\n'))
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('balance:databaseLoadingMessages')))
    .toBeNull()
})

test('plan items can be nested and un-nested with the drag handle', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const wakeRow = page.getByRole('listitem', { name: /Plan item: Wake up/ })
  const workRow = page.getByRole('listitem', { name: /Plan item: Work block/ })

  await pointerDrag(
    page,
    wakeRow.getByRole('button', { name: 'Drag to move item' }),
    workRow,
    'inside',
  )

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        return Boolean(work?.children?.some((item: { text: string }) => item.text === 'Wake up'))
      }),
    )
    .toBe(true)

  const nestedWakeRow = page.getByRole('listitem', { name: /Plan item: Wake up/ })
  await pointerDrag(
    page,
    nestedWakeRow.getByRole('button', { name: 'Drag to move item' }),
    workRow,
    'before',
  )

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        const wakeIsTopLevel = plan?.items?.some((item: { text: string }) => item.text === 'Wake up')
        const wakeIsChild = work?.children?.some((item: { text: string }) => item.text === 'Wake up')
        return Boolean(wakeIsTopLevel && !wakeIsChild)
      }),
    )
    .toBe(true)
})

test('template items can be nested and un-nested with the drag handle', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  const wakeRow = page.getByRole('listitem', { name: /Template item: Wake up/ })
  const workRow = page.getByRole('listitem', { name: /Template item: Work block/ })

  await pointerDrag(
    page,
    wakeRow.getByRole('button', { name: 'Drag to move template item' }),
    workRow,
    'inside',
  )

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const template = state.templates?.[0]
        const work = template?.items?.find((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text === 'Work block')
        return Boolean(work?.children?.some((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text === 'Wake up'))
      }),
    )
    .toBe(true)

  const nestedWakeRow = page.getByRole('listitem', { name: /Template item: Wake up/ })
  await pointerDrag(
    page,
    nestedWakeRow.getByRole('button', { name: 'Drag to move template item' }),
    workRow,
    'before',
  )

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const template = state.templates?.[0]
        const work = template?.items?.find((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text === 'Work block')
        const wakeIsTopLevel = template?.items?.some((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text === 'Wake up')
        const wakeIsChild = work?.children?.some((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text === 'Wake up')
        return Boolean(wakeIsTopLevel && !wakeIsChild)
      }),
    )
    .toBe(true)
})

test('tab indents a plan item only one level after a nested sibling', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const plan = state.plans?.[0]
    if (!plan) return

    plan.items.push({
      id: 'plan_item_later',
      text: 'Later',
      html: 'Later',
      done: false,
      startMinutes: null,
      endMinutes: null,
      children: [],
    })
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  const topLevelBeforeIndent = await topLevelTexts(page)
  expect(topLevelBeforeIndent).toContain('Later')

  await focusInputByValue(page, 'Later')
  await setCaretOffsetInFocusedEditor(page, 2)
  await page.keyboard.press('Tab')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        const nestedWrite = work?.children?.find((item: { text: string }) => item.text === 'Write down next action')

        return {
          topLevel: plan?.items?.map((item: { text: string }) => item.text) ?? [],
          workChildren: work?.children?.map((item: { text: string }) => item.text) ?? [],
          writeChildren: nestedWrite?.children?.map((item: { text: string }) => item.text) ?? [],
        }
      }),
    )
    .toEqual({
      topLevel: topLevelBeforeIndent.filter((text) => text !== 'Later'),
      workChildren: ['Pick the first useful task', 'Write down next action', 'Later'],
      writeChildren: [],
    })
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(2)
})

test('tab indents a template item only one level after a nested sibling', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const template = state.templates?.[0]
    if (!template) return

    template.items.push({
      id: 'template_item_later',
      startMinutes: null,
      endMinutes: null,
      options: [
        {
          id: 'option_later',
          text: 'Later',
          html: 'Later',
          probability: 100,
        },
      ],
      children: [],
    })
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()
  const topLevelBeforeIndent = await topLevelTemplateOptionTexts(page)
  expect(topLevelBeforeIndent).toContain('Later')

  await focusTemplateOptionByValue(page, 'Later')
  await setCaretOffsetInFocusedEditor(page, 2)
  await page.keyboard.press('Tab')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const template = state.templates?.[0]
        const itemText = (item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text ?? ''
        const work = template?.items?.find((item: { options?: Array<{ text: string }> }) => itemText(item) === 'Work block')
        const nestedWrite = work?.children?.find(
          (item: { options?: Array<{ text: string }> }) => itemText(item) === 'Write down next action',
        )

        return {
          topLevel: template?.items?.map(itemText) ?? [],
          workChildren: work?.children?.map(itemText) ?? [],
          writeChildren: nestedWrite?.children?.map(itemText) ?? [],
        }
      }),
    )
    .toEqual({
      topLevel: topLevelBeforeIndent.filter((text) => text !== 'Later'),
      workChildren: ['Pick the first useful task', 'Write down next action', 'Later'],
      writeChildren: [],
    })
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(2)
})

test('shift-tab outdents a plan item without jumping below following siblings', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const topLevelBeforeOutdent = await topLevelTexts(page)
  const workIndex = topLevelBeforeOutdent.indexOf('Work block')
  expect(workIndex).toBeGreaterThanOrEqual(0)

  await focusInputByValue(page, 'Pick the first useful task')
  await setCaretOffsetInFocusedEditor(page, 4)
  await page.keyboard.press('Shift+Tab')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        const promoted = plan?.items?.find((item: { text: string }) => item.text === 'Pick the first useful task')

        return {
          topLevel: plan?.items?.map((item: { text: string }) => item.text) ?? [],
          workChildren: work?.children?.map((item: { text: string }) => item.text) ?? [],
          promotedChildren: promoted?.children?.map((item: { text: string }) => item.text) ?? [],
        }
      }),
    )
    .toEqual({
      topLevel: [
        ...topLevelBeforeOutdent.slice(0, workIndex + 1),
        'Pick the first useful task',
        ...topLevelBeforeOutdent.slice(workIndex + 1),
      ],
      workChildren: [],
      promotedChildren: ['Write down next action'],
    })
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(4)
})

test('shift-tab outdents a template item without jumping below following siblings', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  const topLevelBeforeOutdent = await topLevelTemplateOptionTexts(page)
  const workIndex = topLevelBeforeOutdent.indexOf('Work block')
  expect(workIndex).toBeGreaterThanOrEqual(0)

  await focusTemplateOptionByValue(page, 'Pick the first useful task')
  await setCaretOffsetInFocusedEditor(page, 4)
  await page.keyboard.press('Shift+Tab')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const template = state.templates?.[0]
        const itemText = (item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text ?? ''
        const work = template?.items?.find((item: { options?: Array<{ text: string }> }) => itemText(item) === 'Work block')
        const promoted = template?.items?.find(
          (item: { options?: Array<{ text: string }> }) => itemText(item) === 'Pick the first useful task',
        )

        return {
          topLevel: template?.items?.map(itemText) ?? [],
          workChildren: work?.children?.map(itemText) ?? [],
          promotedChildren: promoted?.children?.map(itemText) ?? [],
        }
      }),
    )
    .toEqual({
      topLevel: [
        ...topLevelBeforeOutdent.slice(0, workIndex + 1),
        'Pick the first useful task',
        ...topLevelBeforeOutdent.slice(workIndex + 1),
      ],
      workChildren: [],
      promotedChildren: ['Write down next action'],
    })
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(4)
})

test('adding plan time starts with a shallower timed item and after a same-level item', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await page.getByRole('listitem', { name: /Plan item: Wake up/ }).getByRole('button', { name: 'Add time range' }).click()
  await page
    .getByRole('listitem', { name: /Plan item: Pick the first useful task/ })
    .getByRole('button', { name: 'Add time range' })
    .click()
  await page
    .getByRole('listitem', { name: /Plan item: Write down next action/ })
    .getByRole('button', { name: 'Add time range' })
    .click()

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        const pick = work?.children?.find((item: { text: string }) => item.text === 'Pick the first useful task')
        const write = work?.children?.find((item: { text: string }) => item.text === 'Write down next action')

        return {
          pick: [pick?.startMinutes, pick?.endMinutes],
          write: [write?.startMinutes, write?.endMinutes],
        }
      }),
    )
    .toEqual({
      pick: [540, 600],
      write: [600, 660],
    })
})

test('keyboard shortcuts add, adjust, and remove time while editing a plan item', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Pick the first useful task')

  await page.keyboard.press('t')
  await expect.poll(async () => activeInputValue(page)).toBe('tPick the first useful task')
  await page.keyboard.press('Backspace')
  await expect.poll(async () => activeInputValue(page)).toBe('Pick the first useful task')

  await page.keyboard.press('Alt+Shift+t')
  await expect.poll(async () => planItemTimeRange(page, 'Pick the first useful task')).toEqual([540, 600])
  await expect.poll(async () => activeInputValue(page)).toBe('Pick the first useful task')

  await page.keyboard.press('Alt+[')
  await expect.poll(async () => planItemTimeRange(page, 'Pick the first useful task')).toEqual([525, 600])

  await page.keyboard.press('ControlOrMeta+]')
  await expect.poll(async () => planItemTimeRange(page, 'Pick the first useful task')).toEqual([525, 615])

  await page.keyboard.press('Alt+Shift+]')
  await expect.poll(async () => planItemTimeRange(page, 'Pick the first useful task')).toEqual([540, 630])

  await page.keyboard.press('ControlOrMeta+[')
  await expect.poll(async () => planItemTimeRange(page, 'Pick the first useful task')).toEqual([540, 615])

  await page.keyboard.press('Alt+Shift+[')
  await expect.poll(async () => planItemTimeRange(page, 'Pick the first useful task')).toEqual([525, 600])

  await page.keyboard.press('Alt+]')
  await expect.poll(async () => planItemTimeRange(page, 'Pick the first useful task')).toEqual([540, 600])

  await page.keyboard.press('Alt+Shift+t')
  await expect.poll(async () => planItemStoredTime(page, 'Pick the first useful task')).toEqual({
    startMinutes: 540,
    endMinutes: 600,
    timeHidden: true,
    hasTimeHiddenField: true,
  })
  await expect
    .poll(async () => planItemStoredTime(page, 'Wake up'))
    .toEqual({ startMinutes: null, endMinutes: null, timeHidden: null, hasTimeHiddenField: false })

  await page.reload()
  await focusInputByValue(page, 'Pick the first useful task')
  await page.keyboard.press('Alt+Shift+t')
  await expect.poll(async () => planItemTimeRange(page, 'Pick the first useful task')).toEqual([540, 600])

  await page.keyboard.press('Alt+/')
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(shortcuts.getByText('Add / remove time from selected items', { exact: true })).toBeVisible()
  await expect(shortcuts.getByText('Move selected start earlier / later', { exact: true })).toBeVisible()
  await expect(shortcuts.getByText('Move selected end earlier / later', { exact: true })).toBeVisible()
  await expect(shortcuts.getByText('Add / remove task time', { exact: true })).toBeVisible()
  await expect(shortcuts.getByText('Move task start earlier / later', { exact: true })).toBeVisible()
  await expect(shortcuts.getByText('Move task end earlier / later', { exact: true })).toBeVisible()
  await expect(shortcuts.getByText('Shift task time earlier / later', { exact: true })).toBeVisible()
})

test('keyboard time shortcuts also work while editing day-template items', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  await focusTemplateOptionByValue(page, 'Pick the first useful task')
  await page.keyboard.press('Alt+Shift+t')
  await page.keyboard.press('Alt+Shift+]')

  await expect.poll(async () => templateItemTimeRange(page, 'Pick the first useful task')).toEqual([555, 615])

  await page.keyboard.press('Alt+Shift+t')
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()
  await focusTemplateOptionByValue(page, 'Pick the first useful task')
  await page.keyboard.press('Alt+Shift+t')
  await expect.poll(async () => templateItemTimeRange(page, 'Pick the first useful task')).toEqual([555, 615])
})

test('adding time to deeper descendants reuses the previous timed task start', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    const date = new Date().toISOString().slice(0, 10)
    const item = (id: string, text: string, children: unknown[] = []) => ({
      id,
      text,
      html: text,
      done: false,
      startMinutes: null,
      endMinutes: null,
      children,
    })
    const state = {
      schemaVersion: 1,
      deviceId: 'test-device',
      localSequence: 0,
      historyRevision: 0,
      activePlanDate: date,
      templates: [],
      plans: [
        {
          id: 'plan_nested_time',
          date,
          dailyReminder: '',
          items: [
            item('parent', 'Parent', [
              item('child', 'Child', [item('grandchild', 'Grandchild')]),
              item('next_child', 'Next child'),
            ]),
          ],
        },
      ],
      goals: [],
      goalCompletions: [],
      operations: [],
    }

    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()

  for (const text of ['Parent', 'Child', 'Grandchild', 'Next child']) {
    await page
      .getByRole('listitem', { name: `Plan item: ${text}`, exact: true })
      .getByRole('button', { name: 'Add time range' })
      .click()
  }

  await expect
    .poll(async () => ({
      parent: await planItemTimeRange(page, 'Parent'),
      child: await planItemTimeRange(page, 'Child'),
      grandchild: await planItemTimeRange(page, 'Grandchild'),
      nextChild: await planItemTimeRange(page, 'Next child'),
    }))
    .toEqual({
      parent: [540, 600],
      child: [540, 600],
      grandchild: [540, 600],
      nextChild: [600, 660],
    })
})

test('alt-dragging a plan start time changes only the start time', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const pickRow = page.getByRole('listitem', { name: /Plan item: Pick the first useful task/ })
  await pickRow.getByRole('button', { name: 'Add time range' }).click()

  await altVerticalDrag(page, pickRow.getByRole('button', { name: '9am' }), -20)

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        const pick = work?.children?.find((item: { text: string }) => item.text === 'Pick the first useful task')

        return [pick?.startMinutes, pick?.endMinutes]
      }),
    )
    .toEqual([570, 600])
})

test('quick repeated plan time drags undo as one entry', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const pickRow = page.getByRole('listitem', { name: /Plan item: Pick the first useful task/ })
  await pickRow.getByRole('button', { name: 'Add time range' }).click()

  await verticalDrag(page, pickRow.getByRole('button', { name: '9am' }), -10)
  await verticalDrag(page, pickRow.getByRole('button', { name: '9:15am' }), -10)

  await expect.poll(async () => planItemTimeRange(page, 'Pick the first useful task')).toEqual([570, 630])

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => planItemTimeRange(page, 'Pick the first useful task')).toEqual([540, 600])

  await page.keyboard.press('Meta+Shift+Z')
  await expect.poll(async () => planItemTimeRange(page, 'Pick the first useful task')).toEqual([570, 630])
})

test('dragging a selected plan end time shifts selected timed tasks together', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const pickRow = page.getByRole('listitem', { name: /Plan item: Pick the first useful task/ })
  const writeRow = page.getByRole('listitem', { name: /Plan item: Write down next action/ })

  await pickRow.getByRole('button', { name: 'Add time range' }).click()
  await writeRow.getByRole('button', { name: 'Add time range' }).click()

  await pickRow.getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.down('Shift')
  try {
    await writeRow.getByRole('button', { name: 'Select item' }).click()
  } finally {
    await page.keyboard.up('Shift')
  }

  await verticalDrag(page, pickRow.getByRole('button', { name: '10am' }), -20)

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        const pick = work?.children?.find((item: { text: string }) => item.text === 'Pick the first useful task')
        const write = work?.children?.find((item: { text: string }) => item.text === 'Write down next action')

        return {
          pick: [pick?.startMinutes, pick?.endMinutes],
          write: [write?.startMinutes, write?.endMinutes],
        }
      }),
    )
    .toEqual({
      pick: [570, 630],
      write: [630, 690],
    })
})

test('adding template time starts with the nearest shallower timed item', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  await page.getByRole('listitem', { name: /Template item: Wake up/ }).getByRole('button', { name: 'Add time range' }).click()
  await page
    .getByRole('listitem', { name: /Template item: Pick the first useful task/ })
    .getByRole('button', { name: 'Add time range' })
    .click()

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const template = state.templates?.[0]
        const itemText = (item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text ?? ''
        const work = template?.items?.find((item: { options?: Array<{ text: string }> }) => itemText(item) === 'Work block')
        const pick = work?.children?.find((item: { options?: Array<{ text: string }> }) => itemText(item) === 'Pick the first useful task')

        return {
          pick: [pick?.startMinutes, pick?.endMinutes],
        }
      }),
    )
    .toEqual({
      pick: [540, 600],
    })
})

test('template time warnings cover sibling overlaps and ancestor boundaries', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    const now = new Date().toISOString()
    const option = (id: string, text: string) => ({ id, text, html: text, probability: 100 })
    const item = (
      id: string,
      text: string,
      startMinutes: number,
      endMinutes: number,
      children: unknown[] = [],
    ) => ({
      id,
      startMinutes,
      endMinutes,
      options: [option(`option_${id}`, text)],
      children,
    })

    const state = {
      schemaVersion: 1,
      deviceId: 'test-device',
      localSequence: 0,
      historyRevision: 0,
      activePlanDate: new Date().toISOString().slice(0, 10),
      templates: [
        {
          id: 'template_overlap',
          name: 'Overlap rules',
          createdAt: now,
          updatedAt: now,
          items: [
            item('parent', 'Parent', 540, 720, [
              item('early_child', 'Child starting early', 480, 510),
              item('child', 'Child', 600, 660, [item('deep', 'Deep child ending late', 630, 750)]),
              item('late_child', 'Child ending late', 660, 750),
            ]),
            item('overlap', 'Overlapping sibling', 690, 750),
            item('later', 'Later sibling', 780, 840),
            item('uneven', 'Uneven time width', 1320, 1350),
            item('uneven_next', 'Overlapping uneven sibling', 1335, 1395),
          ],
        },
      ],
      plans: [],
      goals: [],
      goalCompletions: [],
      operations: [],
    }

    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  const childTime = page.getByRole('listitem', { name: 'Template item: Child', exact: true }).getByLabel('Time range')
  const earlyChildTime = page
    .getByRole('listitem', { name: 'Template item: Child starting early', exact: true })
    .getByLabel('Time range')
  const parentTime = page.getByRole('listitem', { name: 'Template item: Parent', exact: true }).getByLabel('Time range')
  const deepTime = page
    .getByRole('listitem', { name: 'Template item: Deep child ending late', exact: true })
    .getByLabel('Time range')
  const lateChildTime = page
    .getByRole('listitem', { name: 'Template item: Child ending late', exact: true })
    .getByLabel('Time range')
  const overlapTime = page
    .getByRole('listitem', { name: 'Template item: Overlapping sibling', exact: true })
    .getByLabel('Time range')
  const laterTime = page
    .getByRole('listitem', { name: 'Template item: Later sibling', exact: true })
    .getByLabel('Time range')
  const unevenTime = page
    .getByRole('listitem', { name: 'Template item: Uneven time width', exact: true })
    .getByLabel('Time range')

  await expect(parentTime.getByRole('button', { name: '9am' })).not.toHaveClass(/warning/)
  await expect(parentTime.getByRole('button', { name: '12pm' })).toHaveClass(/warning/)
  await expect(parentTime).toHaveClass(/warning-end/)
  await expect(parentTime).not.toHaveClass(/warning-start/)
  await expect(parentTime.locator('.time-start-side')).toHaveCSS('padding-left', '5px')
  await expect(parentTime.locator('.time-end-side')).toHaveCSS('gap', '1px')
  await expect(parentTime.locator('.dash')).toHaveCSS('padding', '0px 1px')
  await expect(parentTime.getByRole('button', { name: '9am' })).toHaveCSS('padding', '5px 2px')
  await expect(parentTime.getByRole('button', { name: '9am' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(parentTime.getByRole('button', { name: '12pm' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(parentTime.locator('.time-start-side')).toHaveCSS('background-color', 'rgb(238, 247, 243)')
  await expect(parentTime.locator('.time-end-side')).toHaveCSS('background-color', 'rgb(251, 240, 225)')
  await expect(parentTime).toHaveAttribute('title', 'This time ends after the next timed item starts')
  await expect(childTime.locator('.time-part.warning')).toHaveCount(0)
  await expect(earlyChildTime.getByRole('button', { name: '8am' })).toHaveClass(/warning/)
  await expect(earlyChildTime.getByRole('button', { name: '8:30am' })).not.toHaveClass(/warning/)
  await expect(earlyChildTime).toHaveClass(/warning-start/)
  await expect(earlyChildTime).not.toHaveClass(/warning-end/)
  await expect(earlyChildTime.locator('.time-start-side')).toHaveCSS('background-color', 'rgb(251, 240, 225)')
  await expect(earlyChildTime.locator('.time-end-side')).toHaveCSS('background-color', 'rgb(238, 247, 243)')
  await expect(earlyChildTime).toHaveAttribute('title', 'This time starts before a parent or ancestor starts')
  await expect(deepTime.getByRole('button', { name: '10:30am' })).not.toHaveClass(/warning/)
  await expect(deepTime.getByRole('button', { name: '12:30pm' })).toHaveClass(/warning/)
  await expect(deepTime).toHaveAttribute('title', 'This time ends after a parent or ancestor ends')
  await expect(lateChildTime.getByRole('button', { name: '11am' })).not.toHaveClass(/warning/)
  await expect(lateChildTime.getByRole('button', { name: '12:30pm' })).toHaveClass(/warning/)
  await expect(lateChildTime).toHaveAttribute('title', 'This time ends after a parent or ancestor ends')
  await expect(overlapTime.getByRole('button', { name: '11:30am' })).toHaveClass(/warning/)
  await expect(overlapTime.getByRole('button', { name: '12:30pm' })).not.toHaveClass(/warning/)
  await expect(overlapTime).toHaveClass(/warning-start/)
  await expect(overlapTime).not.toHaveClass(/warning-end/)
  await expect(overlapTime.locator('.time-start-side')).toHaveCSS('background-color', 'rgb(251, 240, 225)')
  await expect(overlapTime.locator('.time-end-side')).toHaveCSS('background-color', 'rgb(238, 247, 243)')
  await expect(overlapTime).toHaveAttribute('title', 'This time starts before the previous timed item ends')
  await expect(laterTime.locator('.time-part.warning')).toHaveCount(0)

  const unevenStart = unevenTime.getByRole('button', { name: '10pm' })
  const unevenEnd = unevenTime.getByRole('button', { name: '10:30pm' })
  const unevenRemove = unevenTime.locator('.icon-button.quiet')
  const unevenSeparator = unevenTime.locator('.dash')
  const unevenRangeBox = await unevenTime.boundingBox()
  const unevenStartBox = await unevenStart.boundingBox()
  const unevenEndBox = await unevenEnd.boundingBox()
  const unevenRemoveBox = await unevenRemove.boundingBox()
  const unevenSeparatorBox = await unevenSeparator.boundingBox()
  expect(unevenRangeBox).not.toBeNull()
  expect(unevenStartBox).not.toBeNull()
  expect(unevenEndBox).not.toBeNull()
  expect(unevenRemoveBox).not.toBeNull()
  expect(unevenSeparatorBox).not.toBeNull()
  expect(unevenEndBox!.width).toBeGreaterThan(unevenStartBox!.width)
  expect(Math.abs(unevenStartBox!.x + unevenStartBox!.width - unevenSeparatorBox!.x)).toBeLessThan(0.5)
  expect(Math.abs(unevenSeparatorBox!.x + unevenSeparatorBox!.width - unevenEndBox!.x)).toBeLessThan(0.5)
  const originalLayoutWidth =
    2 + 5 + unevenStartBox!.width + unevenSeparatorBox!.width + unevenEndBox!.width + 1 + unevenRemoveBox!.width
  expect(Math.abs(unevenRangeBox!.width - originalLayoutWidth)).toBeLessThan(0.5)
  await expect(unevenTime).toHaveClass(/warning-end/)
  await expect(unevenTime).not.toHaveClass(/warning-start/)
  await expect(unevenTime.locator('.time-start-side')).toHaveCSS('background-color', 'rgb(238, 247, 243)')
  await expect(unevenTime.locator('.time-end-side')).toHaveCSS('background-color', 'rgb(251, 240, 225)')
  await expect(unevenSeparator).toHaveCSS(
    'background-image',
    'linear-gradient(to right, rgb(238, 247, 243) 0px, rgb(238, 247, 243) 50%, rgb(251, 240, 225) 50%, rgb(251, 240, 225) 100%)',
  )
})

test('plan item text fields support arrow focus and option-arrow sibling moves', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await page.keyboard.press('ArrowDown')

  const focusedAfterDown = await activeInputValue(page)
  expect(focusedAfterDown).not.toBe('Wake up')

  await page.keyboard.press('ArrowUp')
  expect(await activeInputValue(page)).toBe('Wake up')

  await page.keyboard.press('Alt+ArrowDown')
  expect(await activeInputValue(page)).toBe('Wake up')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.plans?.[0]?.items?.[1]?.text
      }),
    )
    .toBe('Wake up')

  await focusInputByValue(page, 'Work block')
  await page.keyboard.press('Alt+ArrowUp')
  expect(await activeInputValue(page)).toBe('Work block')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const workIndex = plan?.items?.findIndex((item: { text: string }) => item.text === 'Work block')
        const work = plan?.items?.[workIndex]
        return {
          workIndex,
          childCount: work?.children?.length,
        }
      }),
    )
    .toEqual({ workIndex: 1, childCount: 2 })
})

test('option-arrow keeps a moved item and two surrounding rows visible', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop workspace scrolling is covered separately from window scrolling')

  const texts = Array.from({ length: 20 }, (_, index) => `Move row ${index + 1}`)
  await seedPlanItems(page, texts)
  await focusInputByValue(page, texts[0])

  for (let index = 0; index < 10; index += 1) await page.keyboard.press('Alt+ArrowDown')

  await expect.poll(async () => activeInputValue(page)).toBe(texts[0])
  await expect
    .poll(() =>
      page.evaluate((movedText) => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-plan-item-id]'))
        const movedIndex = rows.findIndex((row) => row.textContent?.includes(movedText))
        const workspace = document.querySelector<HTMLElement>('.workspace')
        if (movedIndex < 2 || movedIndex + 2 >= rows.length || !workspace) return null

        const viewport = workspace.getBoundingClientRect()
        return {
          scrolled: workspace.scrollTop > 0,
          twoAboveVisible: rows[movedIndex - 2].getBoundingClientRect().top >= viewport.top - 1,
          twoBelowVisible: rows[movedIndex + 2].getBoundingClientRect().bottom <= viewport.bottom + 1,
        }
      }, texts[0]),
    )
    .toEqual({ scrolled: true, twoAboveVisible: true, twoBelowVisible: true })
})

test('today scroll position survives a reload', async ({ page }) => {
  const texts = Array.from({ length: 50 }, (_, index) => `Reload row ${index + 1}`)
  await seedPlanItems(page, texts)

  const scrollTop = () =>
    page.evaluate(() => {
      const workspace = document.querySelector<HTMLElement>('.workspace')
      return window.innerWidth <= 760 ? window.scrollY : (workspace?.scrollTop ?? 0)
    })
  const targetScrollTop = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>('.workspace')
    const target = 620
    if (window.innerWidth <= 760) {
      const top = Math.min(target, document.documentElement.scrollHeight - window.innerHeight)
      window.scrollTo(0, top)
      return top
    }
    if (!workspace) return 0
    const top = Math.min(target, workspace.scrollHeight - workspace.clientHeight)
    workspace.scrollTop = top
    return top
  })
  expect(targetScrollTop).toBeGreaterThan(0)
  await expect.poll(scrollTop).toBe(targetScrollTop)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance:workspaceViewState') || 'null')
        const todayEntry = Object.entries(state?.scrollPositionsByPage ?? {}).find(([key]) => key.startsWith('today:'))
        return todayEntry?.[1] ?? null
      }),
    )
    .toBe(targetScrollTop)

  await page.reload()

  await expect(page.locator('[data-plan-text-input]').first()).toBeVisible()
  await expect.poll(scrollTop).toBe(targetScrollTop)
})

test('plan item text fields support left and right boundary focus', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const topLevel = await topLevelTexts(page)
  await focusInputByValue(page, topLevel[0])
  await setCaretOffsetInFocusedEditor(page, topLevel[0].length)
  await page.keyboard.press('ArrowRight')

  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: topLevel[1], caretOffset: 0 })

  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: topLevel[0], caretOffset: topLevel[0].length })

  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 'Work block'.length)
  await page.keyboard.press('ArrowRight')

  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: 'Pick the first useful task', caretOffset: 0 })

  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: 'Work block', caretOffset: 'Work block'.length })
})

test('vertical arrow keeps navigating after arrowing into an adjacent item', async ({ page }) => {
  // Regression: arrowing into an item places the caret at an element boundary
  // (selectNodeContents + collapse), whose getBoundingClientRect reports an
  // empty rect. That broke the boundary-line check, so the very next vertical
  // arrow in the opposite direction did nothing until Left/Right nudged the
  // caret back into a text node.
  await seedPlanItems(page, ['Alpha', 'Bravo', 'Charlie'])

  // Arrow UP into the previous item, then DOWN must return to where we started.
  await focusInputByValue(page, 'Bravo')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('ArrowUp')
  expect(await activeInputValue(page)).toBe('Alpha')
  await page.keyboard.press('ArrowDown')
  expect(await activeInputValue(page)).toBe('Bravo')

  // And the mirror image: arrow DOWN into the next item, then UP returns.
  await focusInputByValue(page, 'Bravo')
  await setCaretOffsetInFocusedEditor(page, 'Bravo'.length)
  await page.keyboard.press('ArrowDown')
  expect(await activeInputValue(page)).toBe('Charlie')
  await page.keyboard.press('ArrowUp')
  expect(await activeInputValue(page)).toBe('Bravo')
})

test('ArrowUp stays within a multi-line plan item when the caret is on a blank line', async ({ page }) => {
  await seedPlanItems(page, ['Previous', 'TopBottom', 'Next'])

  await focusInputByValue(page, 'TopBottom')
  await page.evaluate(() => {
    const editor = document.activeElement
    if (!(editor instanceof HTMLDivElement)) throw new Error('Expected a focused plan item editor')

    editor.innerHTML = 'Top<br><br>Bottom'
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))

    const range = document.createRange()
    range.setStart(editor, 2)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })

  await page.keyboard.press('ArrowUp')

  expect(await activeInputValue(page)).toBe('TopBottom')

  await page.keyboard.press('ArrowUp')
  expect(await activeInputValue(page)).toBe('Previous')
})

test('shift vertical arrows select multiline plan text until the caret reaches an edge line', async ({ page }) => {
  await seedPlanItems(page, ['Previous', 'TopMiddleBottom', 'Next'])

  await focusInputByValue(page, 'TopMiddleBottom')
  await page.evaluate(() => {
    const editor = document.activeElement
    if (!(editor instanceof HTMLDivElement)) throw new Error('Expected a focused plan item editor')
    editor.innerHTML = 'Top<br>Middle<br>Bottom'
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  })

  // Shift+Up/Down on the middle line retain native contenteditable selection.
  for (const key of ['Shift+ArrowUp', 'Shift+ArrowDown']) {
    await setCaretOffsetInFocusedEditor(page, 6)
    await page.keyboard.press(key)
    await expect.poll(async () => selectedText(page)).toMatch(/\S/)
    await expect(page.getByRole('button', { name: 'Selected item' })).toHaveCount(0)
  }

  // Once the caret is on the last/first visual line, the same shortcuts retain
  // their whole-task selection behavior.
  await setCaretOffsetInFocusedEditor(page, 11)
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.getByRole('button', { name: 'Selected item' })).toHaveCount(2)

  await page.keyboard.press('Escape')
  await focusInputByValue(page, 'TopMiddleBottom')
  await setCaretOffsetInFocusedEditor(page, 2)
  await page.keyboard.press('Shift+ArrowUp')
  await expect(page.getByRole('button', { name: 'Selected item' })).toHaveCount(2)
})

test('holding command-shift keeps extending whole-item selection in either direction', async ({ page }) => {
  const texts = ['First', 'Second', 'Third', 'Fourth']
  await seedPlanItems(page, texts)

  await focusInputByValue(page, texts[0])
  await page.keyboard.down('Meta')
  await page.keyboard.down('Shift')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Meta')
  await expect(page.getByRole('button', { name: 'Selected item' })).toHaveCount(4)

  await page.keyboard.press('Escape')
  await focusInputByValue(page, texts[3])
  await page.keyboard.down('Meta')
  await page.keyboard.down('Shift')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Meta')
  await expect(page.getByRole('button', { name: 'Selected item' })).toHaveCount(4)
})

test('shift down extends a selection from the penultimate soft-wrapped line to the item end', async ({ page }) => {
  const text = Array.from({ length: 34 }, (_, index) => `word${index + 1}`).join(' ')
  await seedPlanItems(page, ['Previous', text, 'Next'])
  await focusInputByValue(page, text)

  const layout = await page.evaluate(() => {
    const editor = document.activeElement
    const textNode = editor?.firstChild
    if (!(editor instanceof HTMLDivElement) || !(textNode instanceof Text)) {
      throw new Error('Expected a focused plain-text plan item editor')
    }

    editor.style.width = '220px'
    editor.style.flex = '0 0 220px'

    const lines = new Map<number, { offsets: number[]; left: number; right: number }>()
    for (let offset = 0; offset < textNode.length; offset += 1) {
      const probe = document.createRange()
      probe.setStart(textNode, offset)
      probe.setEnd(textNode, offset + 1)
      const rect = probe.getBoundingClientRect()
      const top = Math.round(rect.top)
      const line = lines.get(top) ?? { offsets: [], left: rect.left, right: rect.right }
      line.offsets.push(offset)
      line.left = Math.min(line.left, rect.left)
      line.right = Math.max(line.right, rect.right)
      lines.set(top, line)
    }

    const visualLines = Array.from(lines.values())
    if (visualLines.length < 5) throw new Error(`Expected at least five visual lines, got ${visualLines.length}`)
    const penultimate = visualLines[visualLines.length - 2]
    const last = visualLines[visualLines.length - 1]
    const caretOffset = penultimate.offsets[Math.floor(penultimate.offsets.length / 2)]

    const caret = document.createRange()
    caret.setStart(textNode, caretOffset)
    caret.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(caret)

    return {
      caretOffset,
      lineCount: visualLines.length,
      penultimateWidth: penultimate.right - penultimate.left,
      lastWidth: last.right - last.left,
    }
  })

  expect(layout.lineCount).toBeGreaterThanOrEqual(5)
  expect(layout.penultimateWidth).toBeGreaterThan(layout.lastWidth)

  await page.keyboard.press('Meta+Shift+ArrowRight')
  const lineSelection = await selectedText(page)
  expect(lineSelection.length).toBeGreaterThan(0)
  expect(lineSelection.length).toBeLessThan(text.length - layout.caretOffset)

  await page.keyboard.press('Shift+ArrowDown')

  await expect(page.getByRole('button', { name: 'Selected item' })).toHaveCount(0)
  await expect.poll(async () => selectedText(page)).toBe(text.slice(layout.caretOffset))
})

test('template item text fields support arrow focus and option-arrow sibling moves', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  await focusTemplateOptionByValue(page, 'Wake up')
  await setCaretOffsetInFocusedEditor(page, 'Wake up'.length)
  await page.keyboard.press('ArrowDown')

  const focusedAfterDown = await activeTemplateOptionValue(page)
  expect(focusedAfterDown).not.toBe('Wake up')

  await page.keyboard.press('ArrowUp')
  expect(await activeTemplateOptionValue(page)).toBe('Wake up')

  const initialOrder = await topLevelTemplateOptionTexts(page)
  const movedOrder = [initialOrder[1], initialOrder[0], ...initialOrder.slice(2)]

  await page.keyboard.press('Alt+ArrowDown')
  expect(await activeTemplateOptionValue(page)).toBe('Wake up')
  await expect.poll(async () => topLevelTemplateOptionTexts(page)).toEqual(movedOrder)

  await page.keyboard.press('Alt+ArrowUp')
  expect(await activeTemplateOptionValue(page)).toBe('Wake up')
  await expect.poll(async () => topLevelTemplateOptionTexts(page)).toEqual(initialOrder)
})

test('cmd d toggles the focused plan item completion state', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  const wakeCheckbox = page.getByRole('listitem', { name: /Plan item: Wake up/ }).getByRole('checkbox')

  await page.keyboard.press('Meta+D')

  await expect(wakeCheckbox).toBeChecked()
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.plans?.[0]?.items?.find((item: { text: string }) => item.text === 'Wake up')?.done
      }),
    )
    .toBe(true)

  await page.keyboard.press('Meta+D')

  await expect(wakeCheckbox).not.toBeChecked()
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.plans?.[0]?.items?.find((item: { text: string }) => item.text === 'Wake up')?.done
      }),
    )
    .toBe(false)
})

test('enter splits plan items and shift-enter inserts a line break', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await setFocusedEditorHTML(page, 'AlphaBeta')
  await setCaretOffsetInFocusedEditor(page, 5)
  await page.keyboard.press('Enter')

  await expect.poll(async () => topLevelTexts(page).then((texts) => texts.slice(0, 2))).toEqual(['Alpha', 'Beta'])
  await expect.poll(async () => activeInputValue(page)).toBe('Beta')
  await expect.poll(async () => topLevelTexts(page).then((texts) => texts.length)).toBe(4)

  await page.keyboard.press('Shift+Enter')
  await expect.poll(async () => storedHTMLForFocusedItem(page)).toContain('<br>')
  await expect.poll(async () => topLevelTexts(page).then((texts) => texts.length)).toBe(4)
})

test('enter at the start of a parent plan item inserts a blank sibling above it', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Enter')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const items =
          state.plans?.[0]?.items?.map((item: { text: string; children?: Array<{ text: string }> }) => ({
            text: item.text,
            children: item.children?.map((child) => child.text) ?? [],
          })) ?? []
        const workIndex = items.findIndex((item: { text: string }) => item.text === 'Work block')

        return {
          activeText: document.activeElement instanceof HTMLElement ? document.activeElement.textContent : null,
          blankBefore: workIndex > 0 ? items[workIndex - 1] : null,
          workChildren: workIndex >= 0 ? items[workIndex].children : null,
        }
      }),
    )
    .toEqual({
      activeText: '',
      blankBefore: { text: '', children: [] },
      workChildren: ['Pick the first useful task', 'Write down next action'],
    })
})

test('enter in the middle of a parent plan item moves children to the second split item', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 4)
  await page.keyboard.press('Enter')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const items =
          state.plans?.[0]?.items?.map((item: { text: string; children?: Array<{ text: string }> }) => ({
            text: item.text,
            children: item.children?.map((child) => child.text) ?? [],
          })) ?? []
        const firstIndex = items.findIndex((item: { text: string }) => item.text === 'Work')

        return {
          activeText: document.activeElement instanceof HTMLElement ? document.activeElement.textContent : null,
          first: firstIndex >= 0 ? items[firstIndex] : null,
          second: firstIndex >= 0 ? items[firstIndex + 1] : null,
        }
      }),
    )
    .toEqual({
      activeText: ' block',
      first: { text: 'Work', children: [] },
      second: { text: ' block', children: ['Pick the first useful task', 'Write down next action'] },
    })
})

test('enter at the end of a parent plan item moves children to the new blank sibling', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 'Work block'.length)
  await page.keyboard.press('Enter')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const items =
          state.plans?.[0]?.items?.map((item: { text: string; children?: Array<{ text: string }> }) => ({
            text: item.text,
            children: item.children?.map((child) => child.text) ?? [],
          })) ?? []
        const workIndex = items.findIndex((item: { text: string }) => item.text === 'Work block')

        return {
          activeText: document.activeElement instanceof HTMLElement ? document.activeElement.textContent : null,
          first: workIndex >= 0 ? items[workIndex] : null,
          second: workIndex >= 0 ? items[workIndex + 1] : null,
        }
      }),
    )
    .toEqual({
      activeText: '',
      first: { text: 'Work block', children: [] },
      second: { text: '', children: ['Pick the first useful task', 'Write down next action'] },
    })
})

test('backspace at the start of a plan item removes an empty item above it', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Enter')
  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Backspace')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const items =
          state.plans?.[0]?.items?.map((item: { text: string; children?: Array<{ text: string }> }) => ({
            text: item.text,
            children: item.children?.map((child) => child.text) ?? [],
          })) ?? []
        const workIndex = items.findIndex((item: { text: string }) => item.text === 'Work block')

        return {
          activeText: document.activeElement instanceof HTMLElement ? document.activeElement.textContent : null,
          caretOffset: caretOffsetFromDOM(),
          blankBefore: workIndex > 0 ? items[workIndex - 1] : null,
          workChildren: workIndex >= 0 ? items[workIndex].children : null,
        }

        function caretOffsetFromDOM() {
          const active = document.activeElement
          const selection = document.getSelection()
          if (!(active instanceof HTMLElement) || !selection || selection.rangeCount === 0) return null
          const range = selection.getRangeAt(0).cloneRange()
          range.selectNodeContents(active)
          range.setEnd(selection.anchorNode ?? active, selection.anchorOffset)
          return range.toString().length
        }
      }),
    )
    .toEqual({
      activeText: 'Work block',
      caretOffset: 0,
      blankBefore: expect.not.objectContaining({ text: '' }),
      workChildren: ['Pick the first useful task', 'Write down next action'],
    })
})

test('backspace at the start of a plan item merges it into the item above', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const before = await topLevelTexts(page)
  await focusInputByValue(page, before[1])
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Backspace')

  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
      texts: await topLevelTexts(page),
    }))
    .toEqual({
      activeText: `${before[0]}${before[1]}`,
      caretOffset: before[0].length,
      texts: [`${before[0]}${before[1]}`, ...before.slice(2)],
    })
})

test('cmd backspace at the end of a plan item deletes the whole task', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const before = await topLevelTexts(page)
  await focusInputByValue(page, before[1])
  await setCaretOffsetInFocusedEditor(page, before[1].length)
  await page.keyboard.press('Meta+Backspace')

  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      texts: await topLevelTexts(page),
    }))
    .toEqual({
      activeText: before[0],
      texts: [before[0], ...before.slice(2)],
    })
})

test('cmd backspace preserves child indentation by reparenting children to the item above', async ({ page }) => {
  await seedPlanTree(page, [
    {
      id: 'root',
      text: 'Root',
      children: [
        {
          id: 'previous',
          text: 'Previous sibling',
          children: [{ id: 'existing', text: 'Existing child', children: [] }],
        },
        {
          id: 'deleted',
          text: 'Delete me',
          children: [
            {
              id: 'preserved',
              text: 'Preserved child',
              children: [{ id: 'grandchild', text: 'Preserved grandchild', children: [] }],
            },
          ],
        },
      ],
    },
  ])

  await focusInputByValue(page, 'Delete me')
  await setCaretOffsetInFocusedEditor(page, 'Delete me'.length)
  await page.keyboard.press('Meta+Backspace')

  await expect
    .poll(() => planTreeAndDepths(page))
    .toEqual({
      tree: [
        {
          id: 'root',
          children: [
            {
              id: 'previous',
              children: [
                { id: 'existing', children: [] },
                {
                  id: 'preserved',
                  children: [{ id: 'grandchild', children: [] }],
                },
              ],
            },
          ],
        },
      ],
      depths: { root: 0, previous: 1, existing: 2, preserved: 2, grandchild: 3 },
    })
})

test('cmd backspace outdents children once when there is no preceding sibling', async ({ page }) => {
  await seedPlanTree(page, [
    {
      id: 'root',
      text: 'Root',
      children: [
        {
          id: 'deleted',
          text: 'Delete me',
          children: [
            { id: 'first-preserved', text: 'First preserved child', children: [] },
            { id: 'second-preserved', text: 'Second preserved child', children: [] },
          ],
        },
        { id: 'later', text: 'Later sibling', children: [] },
      ],
    },
  ])

  await focusInputByValue(page, 'Delete me')
  await setCaretOffsetInFocusedEditor(page, 'Delete me'.length)
  await page.keyboard.press('Meta+Backspace')

  await expect
    .poll(() => planTreeAndDepths(page))
    .toEqual({
      tree: [
        {
          id: 'root',
          children: [
            { id: 'first-preserved', children: [] },
            { id: 'second-preserved', children: [] },
            { id: 'later', children: [] },
          ],
        },
      ],
      depths: { root: 0, 'first-preserved': 1, 'second-preserved': 1, later: 1 },
    })
})

test('option backspace clears freshly typed new plan items without leaving newline-only content', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const attempts: Array<{ source: 'add-button' | 'enter-split'; text: string; preflight?: () => Promise<void> }> = []
  for (let index = 0; index < 30; index += 1) {
    attempts.push({ source: 'add-button', text: `draft${index}` })
    attempts.push({
      source: 'enter-split',
      text: `split${index}`,
      preflight: async () => {
        await focusInputByValue(page, 'Work block')
        await setCaretOffsetInFocusedEditor(page, 'Work block'.length)
        await page.keyboard.press('Enter')
      },
    })
  }

  for (const attempt of attempts) {
    if (attempt.preflight) {
      await attempt.preflight()
    } else {
      await page.getByRole('button', { name: '+ Add item' }).click()
      await page.locator('[data-plan-text-input]').last().focus()
    }

    await expect.poll(async () => activeInputValue(page)).toBe('')
    await page.keyboard.type(attempt.text)
    await expect.poll(async () => activeInputValue(page)).toBe(attempt.text)
    await page.keyboard.press('Alt+Backspace')

    await expect
      .poll(async () => activeItemRichTextState(page))
      .toEqual({
        domText: '',
        innerHTML: '',
        storedText: '',
        storedHTML: '',
        isNewlineOnly: false,
      })

    await page.keyboard.type(`next-${attempt.text}`)
    await expect.poll(async () => activeInputValue(page)).toBe(`next-${attempt.text}`)
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
    await expect.poll(async () => activeInputValue(page)).toBe('')
  }
})

test('backspacing bold multi-line content to empty leaves no phantom newline', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await page.getByRole('button', { name: '+ Add item' }).click()
  await page.locator('[data-plan-text-input]').last().focus()
  await expect.poll(async () => activeInputValue(page)).toBe('')

  // Bold text with a soft line break: deleting the last formatted line makes
  // the browser keep the caret placeholder inside the wrapper (`<b><br></b>`),
  // which used to survive sanitization and persist as a newline-only item.
  await page.keyboard.press('Meta+B')
  await page.keyboard.type('ab')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('cd')
  await expect.poll(async () => activeInputValue(page)).toBe('abcd')

  for (let press = 0; press < 5; press += 1) {
    await page.keyboard.press('Backspace')
  }

  await expect
    .poll(async () => activeItemRichTextState(page))
    .toEqual({
      domText: '',
      innerHTML: '',
      storedText: '',
      storedHTML: '',
      isNewlineOnly: false,
    })

  // One more backspace merges into the previous item; the phantom wrapper used
  // to be concatenated onto it (`…<strong><br></strong>`).
  await page.keyboard.press('Backspace')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        type Item = { text: string; html: string; children?: Item[] }
        const flatten = (items: Item[]): Item[] =>
          items.flatMap((item) => [item, ...flatten((item.children ?? []) as Item[])])
        return flatten(state.plans?.[0]?.items ?? []).filter(
          (item) => /<(strong|em|u)>(<br>)*<\/\1>/.test(item.html) || (item.html.length > 0 && item.html.replace(/<br>/g, '').trim() === ''),
        )
      }),
    )
    .toEqual([])
})

test('cmd shift a selects the focused plan item instead of its text', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await page.keyboard.press('Meta+Shift+A')

  const row = page.getByRole('listitem', { name: /Plan item: Wake up/ })
  await expect(row.getByRole('button', { name: 'Selected item' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => selectedText(page)).toBe('')
  await expect.poll(async () => page.evaluate(() => document.activeElement?.matches('[data-plan-text-input]'))).toBe(false)
})

test('a page restores its selected task after visiting another page', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('complementary').getByRole('button', { name: 'Close navigation' }).click()
  }

  await focusInputByValue(page, 'Wake up')
  await page.keyboard.press('Meta+Shift+A')
  const row = page.getByRole('listitem', { name: /Plan item: Wake up/ })
  await expect(row).toHaveClass(/selected/)

  await openSidebarPage(page, 'Day Templates', testInfo.project.name === 'mobile')
  await expect(page.getByRole('heading', { name: 'Daily template' })).toBeVisible()
  await openSidebarPage(page, 'Today', testInfo.project.name === 'mobile')

  await expect(row).toHaveClass(/selected/)
  await expect.poll(async () => page.evaluate(() => document.activeElement?.matches('[data-plan-text-input]'))).toBe(false)
})

test('a page restores its task caret after visiting another page', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('complementary').getByRole('button', { name: 'Close navigation' }).click()
  }

  await focusInputByValue(page, 'Wake up')
  await setCaretOffsetInFocusedEditor(page, 4)
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(4)

  await openSidebarPage(page, 'Day Templates', testInfo.project.name === 'mobile')
  await expect(page.getByRole('heading', { name: 'Daily template' })).toBeVisible()
  await openSidebarPage(page, 'Today', testInfo.project.name === 'mobile')

  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: 'Wake up', caretOffset: 4 })
})

test('arrow keys enter a selected plan item at the matching text boundary', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const text = 'Wake up'
  for (const [key, caretOffset] of [
    ['ArrowUp', 0],
    ['ArrowLeft', 0],
    ['ArrowDown', text.length],
    ['ArrowRight', text.length],
  ] as const) {
    await focusInputByValue(page, text)
    await page.keyboard.press('Meta+Shift+A')
    await page.keyboard.press(key)

    await expect
      .poll(async () => ({
        activeText: await activeInputValue(page),
        caretOffset: await caretOffsetInFocusedEditor(page),
      }))
      .toEqual({ activeText: text, caretOffset })
  }
})

test('cutting a whole plan item focuses the item below it at the start', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const before = await topLevelTexts(page)
  await focusInputByValue(page, before[0])
  await page.keyboard.press('Meta+Shift+A')
  await page.keyboard.press('Meta+X')

  await expect.poll(async () => topLevelTexts(page)).toEqual(before.slice(1))
  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: before[1], caretOffset: 0 })
})

test('pasting plan items into an empty focused item replaces it', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const before = await topLevelTexts(page)
  await focusInputByValue(page, before[0])
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Meta+C')

  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Enter')
  await expect.poll(async () => topLevelTexts(page)).toEqual([...before.slice(0, 2), '', ...before.slice(2)])

  await page.keyboard.press('Meta+V')

  await expect.poll(async () => topLevelTexts(page)).toEqual([...before.slice(0, 2), ...before.slice(0, 2), ...before.slice(2)])
})

test('pasting a plan item at caret offset zero inserts it above the focused item', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const before = await topLevelTexts(page)
  await focusInputByValue(page, before[0])
  await page.keyboard.press('Meta+Shift+A')
  await page.keyboard.press('Meta+C')

  await focusInputByValue(page, before[1])
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Meta+V')

  await expect.poll(async () => topLevelTexts(page)).toEqual([
    before[0],
    before[0],
    ...before.slice(1),
  ])
})

test('clicking a paste target immediately after whole-item copy honors the clicked task', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const before = await topLevelTexts(page)
  const copiedRow = page.getByRole('listitem', { name: 'Plan item: Work block' })
  await copiedRow.getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('Meta+C')

  // Whole-item pointer selection briefly suppresses focus caused by that same
  // gesture. A distinct pointer-down on an editor must end that protection or
  // this click is ignored and paste incorrectly targets the copied subtree.
  await page.locator('[data-plan-text-input-id]').filter({ hasText: before[0] }).click()
  await expect.poll(async () => activeInputValue(page)).toBe(before[0])
  await page.keyboard.press('Meta+V')

  await expect
    .poll(async () => topLevelTexts(page))
    .toEqual([before[0], before[2], before[1], before[2]])
})

test('Paste and Match Style inserts copied item text into the focused item instead of creating a row', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Clipboard permissions are only configured for Chromium in this regression test')

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: playwrightOrigin })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const before = await topLevelTexts(page)
  const copiedText = before[0]
  await page.getByRole('listitem', { name: `Plan item: ${copiedText}` }).getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('Meta+C')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copiedText)

  await page.locator('[data-plan-text-input-id]').filter({ hasText: before[1] }).click()
  await expect.poll(async () => activeInputValue(page)).toBe(before[1])
  await setCaretOffsetInFocusedEditor(page, before[1].length)
  await page.keyboard.press('Meta+Alt+Shift+V')

  await expect.poll(async () => topLevelTexts(page)).toEqual([
    before[0],
    `${before[1]}${copiedText}`,
    ...before.slice(2),
  ])
})

test('replacing the system clipboard prevents stale structured task paste', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Clipboard permissions are only configured for Chromium in this regression test')

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: playwrightOrigin })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const before = await topLevelTexts(page)
  await focusInputByValue(page, before[0])
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Meta+C')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(before.slice(0, 2).join('\n'))

  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Enter')
  await page.evaluate(() => navigator.clipboard.writeText('Current clipboard value'))
  await page.keyboard.press('Meta+V')

  await expect
    .poll(async () => topLevelTexts(page))
    .toEqual([...before.slice(0, 2), 'Current clipboard value', ...before.slice(2)])
})

test('pasting a moved group again keeps it as structured task items', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  // Make the default plan three adjacent leaf tasks so the scenario stays below
  // the cross-day review threshold and exercises the cut clipboard directly.
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const plan = state.plans?.find((candidate: { date: string }) => candidate.date === state.activePlanDate)
    if (plan) plan.items = plan.items.map((item: object) => ({ ...item, children: [] }))
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()

  const movedItems = await activePlanTopLevelTexts(page)
  await focusInputByValue(page, movedItems[0])
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Meta+X')
  await expect.poll(async () => activePlanTopLevelTexts(page)).toEqual([])

  await page.getByRole('button', { name: 'Previous day' }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate selected day' }).click()
  const priorDayItems = await activePlanTopLevelTexts(page)
  await focusInputByValue(page, priorDayItems.at(-1) as string)
  await page.keyboard.press('Meta+V')
  await expect.poll(async () => activePlanTopLevelTexts(page)).toEqual([...priorDayItems, ...movedItems])

  // Move the same three tasks back to today.
  await page.keyboard.press('Meta+X')
  await expect.poll(async () => activePlanTopLevelTexts(page)).toEqual(priorDayItems)
  await page.getByRole('button', { name: 'Next day' }).click()
  await page.keyboard.press('Meta+V')
  await expect.poll(async () => activePlanTopLevelTexts(page)).toEqual(movedItems)

  // A second paste must still use the internal structured clipboard. Previously it
  // fell through to native rich-text paste and merged the three lines into one task.
  await focusInputByValue(page, movedItems.at(-1) as string)
  await page.keyboard.press('Meta+V')
  await expect.poll(async () => activePlanTopLevelTexts(page)).toEqual([...movedItems, ...movedItems])
})

test('pasting four items on the day they were copied bypasses review', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const before = await topLevelTexts(page)
  // Move + Work block (including Work block's two children) is four reviewable items.
  await focusInputByValue(page, before[1])
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Meta+C')

  await focusInputByValue(page, before.at(-1) as string)
  await page.keyboard.press('Meta+V')

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => topLevelTexts(page)).toEqual([...before, ...before.slice(1)])
})

test('pasting three items onto a different day bypasses review', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const sourceItems = await topLevelTexts(page)
  // Work block and its two children is exactly three reviewable items.
  await focusInputByValue(page, sourceItems[2])
  await page.keyboard.press('Meta+Shift+A')
  await page.keyboard.press('Meta+C')

  await page.getByRole('button', { name: 'Next day' }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate selected day' }).click()
  const targetItems = await topLevelTexts(page)
  await focusInputByValue(page, targetItems.at(-1) as string)
  await page.keyboard.press('Meta+V')

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => topLevelTexts(page)).toEqual([...targetItems, sourceItems[2]])
})

test('pasting four or more items onto a different day opens a review queue', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const before = await topLevelTexts(page)

  // Move + Work block (including Work block's two children) is four reviewable items.
  await focusInputByValue(page, before[1])
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Meta+C')

  await page.getByRole('button', { name: 'Next day' }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate selected day' }).click()
  const targetItems = await topLevelTexts(page)

  // Pasting 4+ items on another day opens the review modal instead of inserting directly.
  await focusInputByValue(page, targetItems.at(-1) as string)
  await page.keyboard.press('Meta+V')

  await expect(page.getByRole('dialog', { name: /Item 1 of 4/ })).toBeVisible()
  await expect(topLevelTexts(page)).resolves.toEqual(targetItems)
  await expect(page.locator('.paste-review-item')).toHaveCount(4)
  await expect(page.locator('.paste-review-item.current')).toContainText(before[1])

  // A short window caps the dialog and scrolls the queue instead of pushing the
  // review controls off-screen.
  await page.setViewportSize({ width: 640, height: 420 })
  const reviewLayout = await page.getByRole('dialog').evaluate((dialog) => {
    const list = dialog.querySelector('.paste-review-list') as HTMLElement
    const actions = dialog.querySelector('.paste-review-actions') as HTMLElement
    return {
      dialogBottom: dialog.getBoundingClientRect().bottom,
      listScrolls: list.scrollHeight > list.clientHeight,
      actionsBottom: actions.getBoundingClientRect().bottom,
    }
  })
  expect(reviewLayout.dialogBottom).toBeLessThanOrEqual(420)
  expect(reviewLayout.actionsBottom).toBeLessThanOrEqual(420)
  expect(reviewLayout.listScrolls).toBe(true)

  // The "Keep" button only appears (and Enter only fires) once the read-cooldown elapses.
  const armed = () => page.getByRole('button', { name: 'Keep (→ / Enter)' })

  // Enter is inert during the cooldown: the queue stays on item 1.
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: /Item 1 of 4/ })).toBeVisible()

  // Keep item 1 once the cooldown arms Enter.
  await armed().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: /Item 2 of 4/ })).toBeVisible()
  await expect
    .poll(async () =>
      page.locator('.paste-review-list').evaluate((list) => {
        const current = list.querySelector('.paste-review-item.current') as HTMLElement
        const listBounds = list.getBoundingClientRect()
        const currentBounds = current.getBoundingClientRect()
        return currentBounds.top >= listBounds.top && currentBounds.bottom <= listBounds.bottom
      }),
    )
    .toBe(true)

  // Edit item 2's text, then keep it (still gated on the cooldown).
  await page.keyboard.press('e')
  const editField = page.getByPlaceholder('Item text')
  await editField.fill('Edited paste')
  await page.keyboard.press('Enter')
  await armed().waitFor()
  await page.keyboard.press('Enter')

  // Skip is allowed during the cooldown.
  await expect(page.getByRole('dialog', { name: /Item 3 of 4/ })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.paste-review-item.rejecting')).toBeVisible()

  await expect(page.getByRole('dialog', { name: /Item 4 of 4/ })).toBeVisible()
  await page.keyboard.press('ArrowLeft')

  // Modal closes and only the kept items (item 1 + edited item 2) are appended.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => topLevelTexts(page)).toEqual([...targetItems, before[1], 'Edited paste'])
})

test('plan item rich text preserves paste formatting and supports shortcuts', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Clipboard permissions are only configured for Chromium in this smoke test')

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: playwrightOrigin })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await page.evaluate(async () => {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob(['<strong>Bold</strong> <em>Italic</em> <a href="https://example.com">Link</a>'], {
          type: 'text/html',
        }),
        'text/plain': new Blob(['Bold Italic Link'], { type: 'text/plain' }),
      }),
    ])
  })
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+V')

  await expect
    .poll(async () => richHTMLForFocusedItem(page))
    .toContain('<strong>Bold</strong> <em>Italic</em> <a href="https://example.com/" target="_blank" rel="noreferrer">Link</a>')

  await setFocusedEditorHTML(page, 'Shortcut')
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+B')
  await expect.poll(async () => richHTMLForFocusedItem(page)).toContain('<b>')
  await expect.poll(async () => storedHTMLForFocusedItem(page)).toContain('<strong>')
  await expect.poll(async () => selectedText(page)).toBe('Shortcut')

  await setFocusedEditorHTML(page, 'Shortcut')
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+I')
  await expect.poll(async () => richHTMLForFocusedItem(page)).toContain('<i>')
  await expect.poll(async () => storedHTMLForFocusedItem(page)).toContain('<em>')
  await expect.poll(async () => selectedText(page)).toBe('Shortcut')

  await page.evaluate(async () => {
    await navigator.clipboard.writeText('https://balance.local')
  })
  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('[data-plan-text-input]')
    if (!editor?.firstChild) return

    const range = document.createRange()
    range.selectNodeContents(editor.firstChild)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await page.keyboard.press('Meta+V')

  await expect
    .poll(async () => richHTMLForFocusedItem(page))
    .toContain('<a href="https://balance.local">')
  await expect
    .poll(async () => storedHTMLForFocusedItem(page))
    .toContain('<a href="https://balance.local" target="_blank" rel="noreferrer">')

  await setFocusedEditorHTML(page, '')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('https://pasted.local/docs')
  })
  await page.keyboard.press('Meta+V')

  await expect
    .poll(async () => richHTMLForFocusedItem(page))
    .toContain('<a href="https://pasted.local/docs" target="_blank" rel="noreferrer">https://pasted.local/docs</a>')
  await expect
    .poll(async () => storedHTMLForFocusedItem(page))
    .toContain('<a href="https://pasted.local/docs" target="_blank" rel="noreferrer">https://pasted.local/docs</a>')

  await page.evaluate(() => {
    window.open = (url, target, features) => {
      ;(window as unknown as { openedLink: { url: string; target?: string; features?: string } }).openedLink = {
        url: String(url),
        target: target ?? undefined,
        features: features ?? undefined,
      }
      return null
    }
  })
  await page.locator('[data-plan-text-input] a[href="https://pasted.local/docs"]').click()
  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as { openedLink?: { url: string; target?: string; features?: string } }).openedLink),
    )
    .toEqual({
      url: 'https://pasted.local/docs',
      target: '_blank',
      features: 'noopener,noreferrer',
    })

  await setFocusedEditorHTML(page, '')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('Read https://pasted.local/guide, then continue.')
  })
  await page.keyboard.press('Meta+V')

  await expect
    .poll(async () => richHTMLForFocusedItem(page))
    .toContain('Read <a href="https://pasted.local/guide" target="_blank" rel="noreferrer">https://pasted.local/guide</a>, then continue.')
  await expect
    .poll(async () => storedHTMLForFocusedItem(page))
    .toContain('Read <a href="https://pasted.local/guide" target="_blank" rel="noreferrer">https://pasted.local/guide</a>, then continue.')
})

test('template options use rich text formatting and generate formatted plan items', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Clipboard permissions are only configured for Chromium in this smoke test')

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: playwrightOrigin })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  await focusTemplateOptionByValue(page, 'Wake up')
  await page.evaluate(async () => {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob(['<strong>Template</strong> <em>Link</em> <a href="https://example.com">Site</a>'], {
          type: 'text/html',
        }),
        'text/plain': new Blob(['Template Link Site'], { type: 'text/plain' }),
      }),
    ])
  })
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+V')

  await expect
    .poll(async () => richHTMLForFocusedTemplateOption(page))
    .toContain('<strong>Template</strong> <em>Link</em> <a href="https://example.com/" target="_blank" rel="noreferrer">Site</a>')
  await expect
    .poll(async () => storedHTMLForFocusedTemplateOption(page))
    .toContain('<strong>Template</strong> <em>Link</em>')

  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await expect(page.locator('[data-plan-text-input]').first()).toBeVisible()
  await expect.poll(async () => firstPlanItemHTML(page)).toContain('<strong>Template</strong> <em>Link</em>')
})

test('day template probabilities snap to five-percent increments', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  const probability = page.getByLabel('Probability percent').first()
  await probability.fill('73')
  await probability.blur()

  await expect(probability).toHaveValue('75')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.templates?.[0]?.items?.[0]?.options?.[0]?.probability
      }),
    )
    .toBe(75)
})

test('dragging a selected day-template probability applies it to every selected row', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  const original = await topLevelTemplateOptionTexts(page)
  await focusTemplateOptionByValue(page, original[0])
  await page.keyboard.press('Meta+Shift+A')
  await page.keyboard.press('Shift+ArrowDown')

  const selectedRows = page.locator('[data-template-item-id].selected')
  await expect(selectedRows).toHaveCount(2)
  const probabilities = selectedRows.locator('.option-stack > .option-row:first-child input[type="range"]')
  await expect(probabilities).toHaveCount(2)

  await dragRangeToRatio(page, probabilities.first(), 0.25)
  await expect.poll(async () => inputValues(probabilities)).toEqual(['25', '25'])
  await expect(selectedRows).toHaveCount(2)
})

test('generating from a future date uses the selected date and latest template edits', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.locator('input[type="date"]').fill('2030-01-15')
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Generate selected day' })).toBeVisible()

  await page.getByRole('button', { name: 'Day Templates' }).click()
  await focusTemplateOptionByValue(page, 'Wake up')
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('Future plan item')
  await expect.poll(async () => storedTextForFocusedTemplateOption(page)).toBe('Future plan item')

  await page.getByRole('complementary').getByRole('button', { name: 'Generate selected day' }).click()

  await expect(page.locator('input[type="date"]')).toHaveValue('2030-01-15')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.find((candidate: { date: string }) => candidate.date === '2030-01-15')
        return plan?.items?.[0]?.text ?? null
      }),
    )
    .toBe('Future plan item')
})

test('blank template options show skip placeholder and skip generated plan item', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  const wakeRow = page.getByRole('listitem', { name: /Template item: Wake up/ })
  await wakeRow.getByRole('button', { name: '±' }).click()
  await expect
    .poll(async () =>
      wakeRow.locator('[data-template-option-text-input]').nth(1).evaluate((input) => input.getAttribute('data-placeholder')),
    )
    .toBe('(Skip)')

  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const firstItem = state.templates?.[0]?.items?.[0]
    const firstOption = firstItem?.options?.[0]
    if (!firstItem || !firstOption) return

    firstItem.options = [
      {
        ...firstOption,
        text: '',
        html: '',
        probability: 100,
      },
    ]
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await expect.poll(async () => topLevelTexts(page)).not.toContain('Wake up')
  await expect.poll(async () => topLevelTexts(page)).not.toContain('')
})

test('typing in rich plan item text keeps the caret at the insertion point', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('abc')

  await expect.poll(async () => activeInputValue(page)).toBe('abc')
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(3)
})

test('rich plan item text restores the caret after focus returns', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await setCaretOffsetInFocusedEditor(page, 4)
  await page.keyboard.type('x')
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(5)

  await page.evaluate(() => {
    const input = document.activeElement
    if (!(input instanceof HTMLElement) || !input.matches('[data-plan-text-input]')) return

    const collapsed = document.createRange()
    collapsed.selectNodeContents(input)
    collapsed.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(collapsed)
    document.dispatchEvent(new Event('selectionchange'))

    window.dispatchEvent(new FocusEvent('blur'))
    input.blur()
    input.focus()

    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(true)

    selection?.removeAllRanges()
    selection?.addRange(range)
    window.dispatchEvent(new FocusEvent('focus'))
  })

  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(5)
})

test('rich plan item text restores the caret after visibility returns', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await setCaretOffsetInFocusedEditor(page, 4)
  await page.keyboard.type('x')
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(5)

  await page.evaluate(() => {
    const input = document.activeElement
    if (!(input instanceof HTMLElement) || !input.matches('[data-plan-text-input]')) return

    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(true)

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })

  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(5)
})

test('rich plan item text restores the caret after tabbing away mid-edit', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await setCaretOffsetInFocusedEditor(page, 4)
  await page.keyboard.type('x')
  await expect.poll(async () => activeInputValue(page)).toBe('Wakex up')
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(5)

  // Reproduce the native app-switch ordering: the input event has already saved the correct
  // caret, but the webview collapses the live DOM selection before it delivers editor blur.
  // Blur handling must not replace the input-time caret with that transient offset 0.
  await page.evaluate(async () => {
    const input = document.activeElement
    if (!(input instanceof HTMLElement) || !input.matches('[data-plan-text-input]')) return

    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    input.blur()

    // The window blur may follow in a later task in the native webview.
    await new Promise((resolve) => window.setTimeout(resolve, 25))
    window.dispatchEvent(new FocusEvent('blur'))
  })

  // Return focus in a later task. Some webviews still report document.hasFocus() during the
  // editor blur, then deliver the window blur before the app actually enters the background.
  await page.evaluate(() => {
    const input = document.querySelector<HTMLElement>('[data-plan-text-input]')
    if (!input) return
    input.focus()

    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    window.dispatchEvent(new FocusEvent('focus'))
  })

  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(5)
})

test('global undo and redo batch text edits', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('abc')
  await expect.poll(async () => activeInputValue(page)).toBe('abc')

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => activeInputValue(page)).toBe('Wake up')

  await page.keyboard.press('Meta+Shift+Z')
  await expect.poll(async () => activeInputValue(page)).toBe('abc')

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => activeInputValue(page)).toBe('Wake up')

  await page.keyboard.press('Meta+Shift+C')
  await expect.poll(async () => activeInputValue(page)).toBe('abc')
})

test('global undo reverts pasted rich text edits', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Clipboard permissions are only configured for Chromium in this smoke test')

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: playwrightOrigin })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('Typed')
  await expect.poll(async () => activeInputValue(page)).toBe('Typed')

  await page.evaluate(async () => {
    await navigator.clipboard.writeText('Pasted item')
  })
  await page.keyboard.press('Meta+V')
  await expect.poll(async () => activeInputValue(page)).toBe('TypedPasted item')

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => activeInputValue(page)).toBe('Typed')

  await page.keyboard.press('Meta+Shift+Z')
  await expect.poll(async () => activeInputValue(page)).toBe('TypedPasted item')
})

test('global undo and redo apply to item movement', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const initialOrder = await topLevelTexts(page)
  const movedOrder = [initialOrder[1], initialOrder[0], ...initialOrder.slice(2)]

  await focusInputByValue(page, 'Wake up')
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(async () => topLevelTexts(page)).toEqual(movedOrder)

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => topLevelTexts(page)).toEqual(initialOrder)

  await page.keyboard.press('Meta+Shift+Z')
  await expect.poll(async () => topLevelTexts(page)).toEqual(movedOrder)

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => topLevelTexts(page)).toEqual(initialOrder)

  await page.keyboard.press('Meta+Shift+C')
  await expect.poll(async () => topLevelTexts(page)).toEqual(movedOrder)
})

test('day template rows support multi-select copy, cut, paste, and keyboard deletion', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Drag-to-select is intentionally disabled on mobile')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  await expect(page.getByRole('button', { name: 'Add child item' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete item' })).toHaveCount(0)
  const original = await topLevelTemplateOptionTexts(page)
  expect(original.length).toBeGreaterThanOrEqual(2)

  await focusTemplateOptionByValue(page, original[0])
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('[data-template-item-id].selected')).toHaveCount(2)

  await page.keyboard.press('Escape')
  await dragSelectAcrossEditors(
    page,
    page.locator('[data-template-option-text-input]').filter({ hasText: original[0] }),
    page.locator('[data-template-option-text-input]').filter({ hasText: original[1] }),
  )
  await expect(page.locator('[data-template-item-id].selected')).toHaveCount(2)

  await page.keyboard.press('Meta+C')
  await page.keyboard.press('Meta+V')
  await expect.poll(async () => topLevelTemplateOptionTexts(page)).toEqual([
    ...original.slice(0, 2),
    ...original.slice(0, 2),
    ...original.slice(2),
  ])

  await page.keyboard.press('Meta+X')
  await expect.poll(async () => topLevelTemplateOptionTexts(page)).toEqual(original)

  const deleteTarget = original.at(-1) as string
  await focusTemplateOptionByValue(page, deleteTarget)
  await setCaretOffsetInFocusedEditor(page, deleteTarget.length)
  await page.keyboard.press('Meta+Backspace')
  await expect.poll(async () => topLevelTemplateOptionTexts(page)).toEqual(original.slice(0, -1))
})

test('pasting a day-template item replaces the sole empty placeholder', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  const sourceText = 'Wake up'
  const sourceInput = page.locator('[data-template-option-text-input]').filter({ hasText: sourceText })
  await sourceInput.locator('xpath=ancestor::*[@data-template-item-id][1]').getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('Meta+C')
  await page.locator('[aria-label="Select day template"] .dashed-edge').click()
  await page.keyboard.press('Meta+V')

  await expect(page.locator('[data-template-item-id]')).toHaveCount(1)
  await expect(page.locator('[data-template-option-text-input]')).toHaveText(sourceText)
})

test('pasting a list-template item replaces the sole empty placeholder', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()
  await page.getByRole('button', { name: 'New list' }).click()

  const sourceText = 'First item'
  const sourceInput = page.locator('[data-list-template-text-input]').filter({ hasText: sourceText })
  await sourceInput.locator('xpath=ancestor::*[@data-list-template-item-id][1]').getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('Meta+C')
  await page.locator('[aria-label="Select list"] .dashed-edge').click()
  await page.locator('[data-list-template-text-input]').fill('')
  await page.locator('[data-list-template-tab-id][aria-current="true"]').click()
  await page.keyboard.press('Meta+V')

  await expect(page.locator('[data-list-template-item-id]')).toHaveCount(1)
  await expect(page.locator('[data-list-template-text-input]')).toHaveText(sourceText)
})

test('day template items support horizontal boundary navigation and backspace merging', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Day Templates' }).click()

  const original = await topLevelTemplateOptionTexts(page)
  expect(original.length).toBeGreaterThanOrEqual(2)

  await focusTemplateOptionByValue(page, original[0])
  await setCaretOffsetInFocusedEditor(page, original[0].length)
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(async () => ({
      activeText: await activeTemplateOptionValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: original[1], caretOffset: 0 })

  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(async () => ({
      activeText: await activeTemplateOptionValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: original[0], caretOffset: original[0].length })

  await focusTemplateOptionByValue(page, original[1])
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Backspace')
  await expect.poll(async () => topLevelTemplateOptionTexts(page)).toEqual([
    `${original[0]}${original[1]}`,
    ...original.slice(2),
  ])
  await expect
    .poll(async () => ({
      activeText: await activeTemplateOptionValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: `${original[0]}${original[1]}`, caretOffset: original[0].length })

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => topLevelTemplateOptionTexts(page)).toEqual(original)
})

test('list template items support horizontal boundary navigation and backspace merging', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()
  await page.getByRole('button', { name: 'New list' }).click()
  await page.getByRole('button', { name: 'Add list item' }).click()

  const inputs = page.locator('[data-list-template-text-input]')
  await inputs.nth(1).fill('Second item')
  await inputs.first().focus()
  await setCaretOffsetInFocusedEditor(page, 'First item'.length)
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(async () => ({
      activeText: await activeListTemplateItemValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: 'Second item', caretOffset: 0 })

  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(async () => ({
      activeText: await activeListTemplateItemValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: 'First item', caretOffset: 'First item'.length })

  await inputs.nth(1).focus()
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Backspace')
  await expect.poll(async () => listTemplateTopLevelTexts(page)).toEqual(['First itemSecond item'])
  await expect
    .poll(async () => ({
      activeText: await activeListTemplateItemValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: 'First itemSecond item', caretOffset: 'First item'.length })

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => listTemplateTopLevelTexts(page)).toEqual(['First item', 'Second item'])
})

test('shift vertical arrows select multiline list-template text until the caret reaches an edge line', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()
  await page.getByRole('button', { name: 'New list' }).click()
  await page.getByRole('button', { name: 'Add list item' }).click()

  const inputs = page.locator('[data-list-template-text-input]')
  await inputs.nth(1).fill('Second item')
  await inputs.first().focus()
  await inputs.first().evaluate((editor) => {
    editor.innerHTML = 'Top<br>Middle<br>Bottom'
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  })

  await setCaretOffsetInFocusedEditor(page, 6)
  await page.keyboard.press('Shift+ArrowDown')
  await expect.poll(async () => selectedText(page)).toMatch(/\S/)
  await expect(page.getByRole('button', { name: 'Selected item' })).toHaveCount(0)

  await setCaretOffsetInFocusedEditor(page, 11)
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.getByRole('button', { name: 'Selected item' })).toHaveCount(2)
})

test('list template indent and outdent preserve the caret position', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()
  await page.getByRole('button', { name: 'New list' }).click()
  await page.getByRole('button', { name: 'Add list item' }).click()

  const second = page.locator('[data-list-template-text-input]').nth(1)
  await second.fill('Second item')
  await second.focus()
  await setCaretOffsetInFocusedEditor(page, 3)
  await page.keyboard.press('Tab')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const items = state.listTemplates?.[0]?.items ?? []
        return {
          topLevel: items.map((item: { text: string }) => item.text),
          firstChildren: items[0]?.children?.map((item: { text: string }) => item.text) ?? [],
        }
      }),
    )
    .toEqual({ topLevel: ['First item'], firstChildren: ['Second item'] })
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(3)

  await page.keyboard.press('Shift+Tab')
  await expect.poll(async () => listTemplateTopLevelTexts(page)).toEqual(['First item', 'Second item'])
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(3)
})

test('list template items support rich text formatting shortcuts while over the word cap', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()
  await page.getByRole('button', { name: 'New list' }).click()
  await page.getByRole('button', { name: 'Unlock to edit max word count' }).click()
  await page.getByRole('spinbutton', { name: 'max' }).fill('1')

  const editor = page.locator('[data-list-template-text-input]').first()
  await editor.focus()

  for (const [shortcut, editorTag, storedTag] of [
    ['Meta+B', 'b', 'strong'],
    ['Meta+I', 'i', 'em'],
    ['Meta+U', 'u', 'u'],
  ] as const) {
    await page.keyboard.press('Meta+A')
    await page.keyboard.press(shortcut)

    await expect.poll(async () => editor.evaluate((element) => element.innerHTML)).toContain(`<${editorTag}>`)
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
          return state.listTemplates?.[0]?.items?.[0]?.html ?? ''
        }),
      )
      .toContain(`<${storedTag}>`)
    await expect.poll(async () => selectedText(page)).toBe('First item')
  }
})

test('list template item appearance probability grandfathers saved values below 30 percent', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    const now = new Date().toISOString()
    const item = (id: string, text: string, probability: number) => ({
      id,
      text,
      html: text,
      probability,
      children: [],
    })
    localStorage.setItem(
      'balance.appState.v1',
      JSON.stringify({
        schemaVersion: 1,
        deviceId: 'test-device',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: now.slice(0, 10),
        templates: [],
        plans: [],
        listTemplates: [{
          id: 'list_template_probabilities',
          name: 'Probabilities',
          maxExpectedWords: 0,
          items: [item('low', 'Low item', 10), item('normal', 'Normal item', 100)],
          createdAt: now,
          updatedAt: now,
        }],
        lists: [],
        metrics: [],
        metricEntries: [],
        goals: [],
        goalCompletions: [],
        operations: [],
      }),
    )
  })
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()

  const probabilities = page.getByLabel('Appearance probability')
  await expect(probabilities).toHaveCount(2)
  const lowProbability = probabilities.nth(0)
  const normalProbability = probabilities.nth(1)
  await expect(lowProbability).toHaveAttribute('min', '10')
  await expect(lowProbability).toHaveValue('10')
  await expect(normalProbability).toHaveAttribute('min', '30')

  await normalProbability.press('Home')
  await expect(normalProbability).toHaveValue('30')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.listTemplates?.[0]?.items?.map((item: { probability: number }) => item.probability)
      }),
    )
    .toEqual([10, 30])
})

test('list template appearance slider uses the full visible track for pointer dragging', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()
  await page.getByRole('button', { name: 'New list' }).click()

  const probability = page.getByLabel('Appearance probability')
  const sliderBox = await probability.boundingBox()
  if (!sliderBox) throw new Error('Missing appearance slider geometry')

  const y = sliderBox.y + sliderBox.height / 2
  await page.mouse.move(sliderBox.x + sliderBox.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(sliderBox.x + 10, y)
  await page.mouse.up()
  await expect(probability).toHaveValue('40')

  await page.mouse.move(sliderBox.x + 10, y)
  await page.mouse.down()
  await page.mouse.move(sliderBox.x + sliderBox.width - 10, y)
  await page.mouse.up()
  await expect(probability).toHaveValue('90')
})

test('dragging a selected list-template probability applies it to every selected row', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()
  await page.getByRole('button', { name: 'New list' }).click()
  await page.getByRole('button', { name: 'Add list item' }).click()

  const inputs = page.locator('[data-list-template-text-input]')
  await inputs.nth(1).fill('Second item')
  await inputs.first().focus()
  await page.keyboard.press('Meta+Shift+A')
  await page.keyboard.press('Shift+ArrowDown')

  const selectedRows = page.locator('[data-list-template-item-id].selected')
  await expect(selectedRows).toHaveCount(2)
  const probabilities = selectedRows.getByLabel('Appearance probability')
  await expect(probabilities).toHaveCount(2)
  const originalProbabilities = await inputValues(probabilities)

  // The list-template range is 30–100 in 10-point steps; 3/7 lands on 60.
  await dragRangeToRatio(page, probabilities.first(), 3 / 7)
  await expect.poll(async () => inputValues(probabilities)).toEqual(['60', '60'])
  await expect(selectedRows).toHaveCount(2)

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => inputValues(probabilities)).toEqual(originalProbabilities)
})

test('nested list items include ancestor probabilities in expected words and cap checks', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const now = new Date().toISOString()
    type SeedItem = {
      id: string
      text: string
      html: string
      probability: number
      children: SeedItem[]
    }
    const item = (
      id: string,
      text: string,
      probability: number,
      children: SeedItem[] = [],
    ): SeedItem => ({ id, text, html: text, probability, children })

    localStorage.setItem(
      'balance.appState.v1',
      JSON.stringify({
        schemaVersion: 1,
        deviceId: 'test-device',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: now.slice(0, 10),
        templates: [],
        plans: [],
        listTemplates: [
          {
            id: 'list_template_nested_words',
            name: 'Nested words',
            maxExpectedWords: 5,
            items: [
              item('parent', 'parent words', 50, [
                item('child', 'one two three four', 50, [
                  item('grandchild', 'one two three four five six seven eight', 50),
                ]),
              ]),
              item('root_sibling', 'root', 100),
            ],
            createdAt: now,
            updatedAt: now,
          },
        ],
        lists: [],
        metrics: [],
        metricEntries: [],
        goals: [],
        goalCompletions: [],
        operations: [],
      }),
    )
  })
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()

  await expect(page.locator('.word-cap-count')).toContainText('4 / 5 expected words')

  const grandchild = page.locator('[data-list-template-text-input-id="grandchild"]')
  await grandchild.fill('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen')

  await expect(grandchild).toHaveText(
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen',
  )
  await expect(page.locator('.word-cap-count')).toContainText('5 / 5 expected words')
})

test('list template rows share multi-select clipboard behavior and hide mouse-only actions', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Drag-to-select is intentionally disabled on mobile')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()
  await page.getByRole('button', { name: 'New list' }).click()
  await page.getByRole('button', { name: 'Add list item' }).click()

  const listInputs = page.locator('[data-list-template-text-input]')
  await expect(listInputs).toHaveCount(2)
  await listInputs.nth(1).fill('Second item')
  await expect(page.getByRole('button', { name: 'Add child item' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete item' })).toHaveCount(0)
  await expect
    .poll(async () => {
      const slider = page.getByLabel('Appearance probability').first()
      const thumb = slider.locator('xpath=..').locator('.thumb')
      const sliderBox = await slider.boundingBox()
      const thumbBox = await thumb.boundingBox()
      return sliderBox && thumbBox ? { hitboxHeight: sliderBox.height, thumbHeight: thumbBox.height } : null
    })
    .toEqual({ hitboxHeight: 28, thumbHeight: 14 })

  const first = page.locator('[data-list-template-text-input-id]').filter({ hasText: 'First item' })
  await first.focus()
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('[data-list-template-item-id].selected')).toHaveCount(2)

  await page.keyboard.press('Escape')
  await dragSelectAcrossEditors(page, first, listInputs.nth(1))
  await expect(page.locator('[data-list-template-item-id].selected')).toHaveCount(2)

  await page.keyboard.press('Meta+C')
  await page.keyboard.press('Meta+V')
  await expect.poll(async () => listTemplateTopLevelTexts(page)).toEqual([
    'First item',
    'Second item',
    'First item',
    'Second item',
  ])

  await page.keyboard.press('Backspace')
  await expect.poll(async () => listTemplateTopLevelTexts(page)).toEqual(['First item', 'Second item'])

  const firstRow = page.getByRole('listitem', { name: 'List item: First item' })
  const secondRow = page.getByRole('listitem', { name: 'List item: Second item' })
  await pointerDrag(page, firstRow.getByRole('button', { name: 'Drag to move item' }), secondRow, 'inside')
  await expect.poll(async () => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const items = state.listTemplates?.[0]?.items ?? []
    return {
      roots: items.map((item: { text: string }) => item.text),
      children: items[0]?.children?.map((item: { text: string }) => item.text) ?? [],
    }
  })).toEqual({ roots: ['Second item'], children: ['First item'] })
})

test('list template tabs stay pinned and selection and scroll positions survive a reload', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const now = new Date().toISOString()
    const makeItems = (prefix: string) =>
      Array.from({ length: 40 }, (_, index) => ({
        id: `${prefix}_item_${index}`,
        text: `${prefix} item ${index + 1}`,
        html: `${prefix} item ${index + 1}`,
        children: [],
      }))

    localStorage.setItem(
      'balance.appState.v1',
      JSON.stringify({
        schemaVersion: 1,
        deviceId: 'test-device',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: now.slice(0, 10),
        templates: [],
        plans: [],
        listTemplates: [
          {
            id: 'list_template_alpha',
            name: 'Alpha',
            maxExpectedWords: 100,
            items: makeItems('Alpha'),
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'list_template_beta',
            name: 'Beta',
            maxExpectedWords: 100,
            items: makeItems('Beta'),
            createdAt: now,
            updatedAt: now,
          },
        ],
        lists: [],
        metrics: [],
        metricEntries: [],
        goals: [],
        goalCompletions: [],
        operations: [],
      }),
    )
  })
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()

  const currentScrollTop = () =>
    page.evaluate(() => {
      const workspace = document.querySelector<HTMLElement>('.workspace')
      return window.innerWidth <= 760 ? window.scrollY : (workspace?.scrollTop ?? 0)
    })
  const setScrollTop = (top: number) =>
    page.evaluate((nextTop) => {
      const workspace = document.querySelector<HTMLElement>('.workspace')
      if (window.innerWidth <= 760) window.scrollTo(0, nextTop)
      else if (workspace) workspace.scrollTop = nextTop
    }, top)

  await setScrollTop(620)
  await expect.poll(currentScrollTop).toBe(620)

  const templateRail = page.getByRole('navigation', { name: 'Select list' })
  const wordCapBar = page.locator('.word-cap-bar')
  await expect(templateRail).toBeVisible()
  await expect(wordCapBar).toBeVisible()
  await expect
    .poll(async () => {
      const railBox = await templateRail.boundingBox()
      const wordCapBox = await wordCapBar.boundingBox()
      const railPaddingRight = await templateRail.evaluate((rail) => parseFloat(getComputedStyle(rail).paddingRight))
      return railBox && wordCapBox
        ? {
            railFlushWithTop: Math.abs(railBox.y) <= 1,
            wordCapInRail: wordCapBox.y >= railBox.y && wordCapBox.y + wordCapBox.height <= railBox.y + railBox.height,
            wordCapPinnedRight:
              Math.abs(wordCapBox.x + wordCapBox.width - (railBox.x + railBox.width - railPaddingRight)) <= 1,
          }
        : null
    })
    .toEqual({ railFlushWithTop: true, wordCapInRail: true, wordCapPinnedRight: true })
  await expect(page.locator('.word-cap-edit')).toHaveCSS('opacity', '1')

  const lockButton = page.getByRole('button', { name: 'Unlock to edit max word count' })
  await expect
    .poll(async () => {
      const buttonBox = await lockButton.boundingBox()
      const iconBox = await lockButton.locator('.word-cap-lock-icon').boundingBox()
      return buttonBox && iconBox
        ? {
            x: Math.abs(buttonBox.x + buttonBox.width / 2 - (iconBox.x + iconBox.width / 2)),
            y: Math.abs(buttonBox.y + buttonBox.height / 2 - (iconBox.y + iconBox.height / 2)),
          }
        : null
    })
    .toEqual({ x: 0, y: 0 })

  const alphaTab = page.getByRole('button', { name: 'Alpha', exact: true })
  const betaTab = page.getByRole('button', { name: 'Beta', exact: true })
  await page.keyboard.press('Alt+W')
  await expect(betaTab).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Alt+Q')
  await expect(alphaTab).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Control+ArrowRight')
  await expect(alphaTab).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Meta+ArrowRight')
  await expect(alphaTab).toHaveAttribute('aria-current', 'true')

  await betaTab.click()
  await expect.poll(currentScrollTop).toBe(0)
  await setScrollTop(340)
  await expect.poll(currentScrollTop).toBe(340)

  await alphaTab.click()
  await expect.poll(currentScrollTop).toBe(620)
  await betaTab.click()
  await expect.poll(currentScrollTop).toBe(340)

  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('balance:listTemplatesViewState') || 'null')),
    )
    .toEqual({
      selectedTemplateId: 'list_template_beta',
      scrollTopsByTemplate: {
        list_template_alpha: 620,
        list_template_beta: 340,
      },
    })

  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()
  await expect(page.getByRole('button', { name: 'Beta', exact: true })).toHaveAttribute('aria-current', 'true')
  await expect.poll(currentScrollTop).toBe(340)
})

test('list template tabs can be dragged to persist a new order without changing the selection', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const now = new Date().toISOString()
    localStorage.setItem(
      'balance.appState.v1',
      JSON.stringify({
        schemaVersion: 1,
        deviceId: 'test-device',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: now.slice(0, 10),
        templates: [],
        plans: [],
        listTemplates: ['Alpha', 'Beta', 'Gamma'].map((name) => ({
          id: `list_template_${name.toLowerCase()}`,
          name,
          maxExpectedWords: 0,
          items: [],
          createdAt: now,
          updatedAt: now,
        })),
        lists: [],
        metrics: [],
        metricEntries: [],
        goals: [],
        goalCompletions: [],
        operations: [],
      }),
    )
  })
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()

  const alphaTab = page.getByRole('button', { name: 'Alpha', exact: true })
  const betaTab = page.getByRole('button', { name: 'Beta', exact: true })
  await horizontalPointerDrag(page, alphaTab, betaTab, 'after')

  await expect(alphaTab).toHaveAttribute('aria-current', 'true')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.listTemplates?.map((template: { name: string }) => template.name) ?? []
      }),
    )
    .toEqual(['Beta', 'Alpha', 'Gamma'])
  await expect(page.locator('[data-list-template-tab-id]')).toHaveText(['Beta', 'Alpha', 'Gamma'])
})

test('deleting a list template requires confirmation', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Lists' }).click()
  await page.getByRole('button', { name: 'New list' }).click()
  await page.getByLabel('List name').fill('Errands')

  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm')
    expect(dialog.message()).toContain('Delete “Errands”?')
    await dialog.dismiss()
  })
  await page.getByRole('button', { name: 'Delete list' }).click()
  await expect(page.getByLabel('List name')).toHaveValue('Errands')

  page.once('dialog', async (dialog) => {
    await dialog.accept()
  })
  await page.getByRole('button', { name: 'Delete list' }).click()
  await expect(page.getByRole('heading', { name: 'No lists yet' })).toBeVisible()
})

async function seedPlanItems(page: import('@playwright/test').Page, texts: string[]) {
  await page.goto('/')
  await page.evaluate((itemTexts) => {
    const date = new Date().toISOString().slice(0, 10)
    const state = {
      schemaVersion: 1,
      deviceId: 'test-device',
      localSequence: 0,
      historyRevision: 0,
      activePlanDate: date,
      templates: [],
      plans: [
        {
          id: 'plan_test',
          date,
          dailyReminder: '',
          items: itemTexts.map((text, index) => ({
            id: `item_${index}`,
            text,
            html: text,
            done: false,
            startMinutes: null,
            endMinutes: null,
            children: [],
          })),
        },
      ],
      goals: [],
      goalCompletions: [],
      operations: [],
    }
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, texts)
  await page.reload()
  await expect(page.locator('[data-plan-text-input]').first()).toBeVisible()
}

type SeedPlanTreeItem = {
  id: string
  text: string
  children: SeedPlanTreeItem[]
}

async function seedPlanTree(page: import('@playwright/test').Page, items: SeedPlanTreeItem[]) {
  await page.goto('/')
  await page.evaluate((seedItems) => {
    const date = new Date().toISOString().slice(0, 10)
    const normalize = (item: SeedPlanTreeItem): SeedPlanTreeItem & {
      html: string
      done: boolean
      startMinutes: null
      endMinutes: null
    } => ({
      ...item,
      html: item.text,
      done: false,
      startMinutes: null,
      endMinutes: null,
      children: item.children.map(normalize),
    })
    localStorage.setItem(
      'balance.appState.v1',
      JSON.stringify({
        schemaVersion: 1,
        deviceId: 'test-device',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: date,
        templates: [],
        plans: [{ id: 'plan_test', date, dailyReminder: '', items: seedItems.map(normalize) }],
        goals: [],
        goalCompletions: [],
        operations: [],
      }),
    )
  }, items)
  await page.reload()
  await expect(page.locator('[data-plan-text-input]').first()).toBeVisible()
}

async function planTreeAndDepths(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    type StoredItem = { id: string; children: StoredItem[] }
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const strip = (item: StoredItem): StoredItem => ({ id: item.id, children: item.children.map(strip) })
    const depths = Object.fromEntries(
      Array.from(document.querySelectorAll<HTMLElement>('[data-plan-item-id]')).map((row) => [
        row.dataset.planItemId,
        Number(row.dataset.planItemDepth),
      ]),
    )
    return { tree: (state.plans?.[0]?.items ?? []).map(strip), depths }
  })
}

async function seedListItems(page: import('@playwright/test').Page, texts: string[]) {
  await page.goto('/')
  await page.evaluate((itemTexts) => {
    const date = new Date().toISOString().slice(0, 10)
    const items = itemTexts.map((text, index) => ({
      id: `list_item_${index}`,
      text,
      html: text,
      done: false,
      startMinutes: null,
      endMinutes: null,
      children: [],
    }))
    const state = {
      schemaVersion: 1,
      deviceId: 'test-device',
      localSequence: 0,
      historyRevision: 0,
      activePlanDate: date,
      templates: [],
      plans: [],
      listTemplates: [
        {
          id: 'list_template_test',
          name: 'Victory list',
          maxExpectedWords: 100,
          items: items.map((item) => ({ ...item, probability: 100 })),
        },
      ],
      lists: [
        {
          id: 'list_test',
          listTemplateId: 'list_template_test',
          date,
          items,
        },
      ],
      metrics: [],
      metricEntries: [],
      goals: [],
      goalCompletions: [],
      operations: [],
    }
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, texts)
  await page.reload()
}

async function focusInputByValue(page: import('@playwright/test').Page, value: string) {
  await page.evaluate((expectedValue) => {
    const input = Array.from(document.querySelectorAll<HTMLElement>('[data-plan-text-input]')).find(
      (candidate) => candidate.textContent === expectedValue,
    )
    input?.focus()
  }, value)
}

async function openSidebarPage(page: import('@playwright/test').Page, name: string, mobile: boolean) {
  if (mobile) await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('complementary').getByRole('button', { name, exact: true }).click()
}

async function activeInputValue(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    return active instanceof HTMLElement && active.matches('[data-plan-text-input]') ? active.textContent : null
  })
}

async function planItemTimeRange(page: import('@playwright/test').Page, text: string) {
  return page.evaluate((expectedText) => {
    const visit = (items: Array<{ text: string; startMinutes: number | null; endMinutes: number | null; children: unknown[] }>): [number | null, number | null] | null => {
      for (const item of items) {
        if (item.text === expectedText) return [item.startMinutes, item.endMinutes]
        const match = visit(item.children as Array<{ text: string; startMinutes: number | null; endMinutes: number | null; children: unknown[] }>)
        if (match) return match
      }

      return null
    }

    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return visit(state.plans?.[0]?.items ?? [])
  }, text)
}

async function planItemStoredTime(page: import('@playwright/test').Page, text: string) {
  return page.evaluate((expectedText) => {
    type Item = {
      text: string
      startMinutes: number | null
      endMinutes: number | null
      timeHidden?: boolean | null
      children: Item[]
    }
    const visit = (items: Item[]): Item | null => {
      for (const item of items) {
        if (item.text === expectedText) return item
        const match = visit(item.children)
        if (match) return match
      }
      return null
    }

    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const item = visit(state.plans?.[0]?.items ?? [])
    return item
      ? {
          startMinutes: item.startMinutes,
          endMinutes: item.endMinutes,
          timeHidden: item.timeHidden ?? null,
          hasTimeHiddenField: Object.prototype.hasOwnProperty.call(item, 'timeHidden'),
        }
      : null
  }, text)
}

async function templateItemTimeRange(page: import('@playwright/test').Page, text: string) {
  return page.evaluate((expectedText) => {
    type Item = {
      options?: Array<{ text: string }>
      startMinutes: number | null
      endMinutes: number | null
      children: Item[]
    }
    const visit = (items: Item[]): [number | null, number | null] | null => {
      for (const item of items) {
        if (item.options?.[0]?.text === expectedText) return [item.startMinutes, item.endMinutes]
        const match = visit(item.children)
        if (match) return match
      }
      return null
    }

    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return visit(state.templates?.[0]?.items ?? [])
  }, text)
}

async function setFocusedEditorHTML(page: import('@playwright/test').Page, html: string) {
  await page.evaluate((nextHTML) => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-plan-text-input]')) return
    active.innerHTML = nextHTML
    active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  }, html)
}

async function setCaretOffsetInFocusedEditor(page: import('@playwright/test').Page, offset: number) {
  await page.evaluate((targetOffset) => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-rich-text-input]')) return

    const walker = document.createTreeWalker(active, NodeFilter.SHOW_TEXT)
    let remaining = targetOffset
    let targetNode: Node = active
    let nodeOffset = 0
    let node = walker.nextNode()

    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        targetNode = node
        nodeOffset = remaining
        break
      }
      remaining -= length
      node = walker.nextNode()
    }

    if (!node) {
      targetNode = active
      nodeOffset = active.childNodes.length
    }

    const range = document.createRange()
    range.setStart(targetNode, nodeOffset)
    range.collapse(true)

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, offset)
}

async function richHTMLForFocusedItem(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    return active instanceof HTMLElement && active.matches('[data-plan-text-input]') ? active.innerHTML : null
  })
}

async function activeItemRichTextState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-plan-text-input]')) return null

    const itemId = active.dataset.planTextInputId
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const findItem = (
      items: Array<{ id: string; text: string; html: string; children?: unknown[] }>,
    ): { text: string; html: string } | null => {
      for (const item of items) {
        if (item.id === itemId) return item
        const child = findItem((item.children ?? []) as Array<{ id: string; text: string; html: string; children?: unknown[] }>)
        if (child) return child
      }
      return null
    }
    const item = findItem(state.plans?.[0]?.items ?? [])
    const values = [active.textContent ?? '', active.innerHTML, item?.text ?? '', item?.html ?? '']

    return {
      domText: active.textContent ?? '',
      innerHTML: active.innerHTML,
      storedText: item?.text ?? '',
      storedHTML: item?.html ?? '',
      isNewlineOnly: values.some((value) => value.length > 0 && value.trim() === ''),
    }
  })
}

async function storedHTMLForFocusedItem(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-plan-text-input]')) return null

    const itemId = active.dataset.planTextInputId
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const findItem = (items: Array<{ id: string; html: string; children?: unknown[] }>): string | null => {
      for (const item of items) {
        if (item.id === itemId) return item.html
        const childHTML = findItem((item.children ?? []) as Array<{ id: string; html: string; children?: unknown[] }>)
        if (childHTML !== null) return childHTML
      }
      return null
    }

    return findItem(state.plans?.[0]?.items ?? [])
  })
}

async function focusTemplateOptionByValue(page: import('@playwright/test').Page, value: string) {
  await page.evaluate((expectedValue) => {
    const input = Array.from(document.querySelectorAll<HTMLElement>('[data-template-option-text-input]')).find(
      (candidate) => candidate.textContent === expectedValue,
    )
    input?.focus()
  }, value)
}

async function activeTemplateOptionValue(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    return active instanceof HTMLElement && active.matches('[data-template-option-text-input]') ? active.textContent : null
  })
}

async function activeListTemplateItemValue(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    return active instanceof HTMLElement && active.matches('[data-list-template-text-input]') ? active.textContent : null
  })
}

async function richHTMLForFocusedTemplateOption(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    return active instanceof HTMLElement && active.matches('[data-template-option-text-input]') ? active.innerHTML : null
  })
}

async function storedHTMLForFocusedTemplateOption(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-template-option-text-input]')) return null

    const optionId = active.dataset.templateOptionTextInputId
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const findOption = (
      items: Array<{ options?: Array<{ id: string; html: string }>; children?: unknown[] }>,
    ): string | null => {
      for (const item of items) {
        const option = item.options?.find((candidate) => candidate.id === optionId)
        if (option) return option.html
        const childHTML = findOption((item.children ?? []) as Array<{ options?: Array<{ id: string; html: string }>; children?: unknown[] }>)
        if (childHTML !== null) return childHTML
      }
      return null
    }

    return findOption(state.templates?.[0]?.items ?? [])
  })
}

async function storedTextForFocusedTemplateOption(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-template-option-text-input]')) return null

    const optionId = active.dataset.templateOptionTextInputId
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const findOption = (
      items: Array<{ options?: Array<{ id: string; text: string }>; children?: unknown[] }>,
    ): string | null => {
      for (const item of items) {
        const option = item.options?.find((candidate) => candidate.id === optionId)
        if (option) return option.text
        const childText = findOption((item.children ?? []) as Array<{ options?: Array<{ id: string; text: string }>; children?: unknown[] }>)
        if (childText !== null) return childText
      }
      return null
    }

    return findOption(state.templates?.[0]?.items ?? [])
  })
}

async function firstPlanItemHTML(page: import('@playwright/test').Page) {
  return page.evaluate(() => document.querySelector<HTMLElement>('[data-plan-text-input]')?.innerHTML ?? null)
}

async function selectedText(page: import('@playwright/test').Page) {
  return page.evaluate(() => document.getSelection()?.toString() ?? '')
}

async function inputValues(inputs: import('@playwright/test').Locator) {
  return inputs.evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement).value))
}

async function dragRangeToRatio(
  page: import('@playwright/test').Page,
  slider: import('@playwright/test').Locator,
  ratio: number,
) {
  const bounds = await slider.boundingBox()
  if (!bounds) throw new Error('Missing slider geometry')
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(bounds.x, y)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width * ratio, y)
  await page.mouse.up()
}

async function caretOffsetInFocusedEditor(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    const selection = document.getSelection()
    if (
      !(active instanceof HTMLElement) ||
      !active.matches('[data-plan-text-input], [data-template-option-text-input], [data-list-template-text-input]') ||
      !selection ||
      selection.rangeCount === 0
    ) {
      return null
    }

    const range = selection.getRangeAt(0).cloneRange()
    range.selectNodeContents(active)
    range.setEnd(selection.anchorNode ?? active, selection.anchorOffset)
    return range.toString().length
  })
}

async function topLevelTexts(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.plans?.[0]?.items?.map((item: { text: string }) => item.text) ?? []
  })
}

async function activePlanTopLevelTexts(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const plan = state.plans?.find((candidate: { date: string }) => candidate.date === state.activePlanDate)
    return plan?.items?.map((item: { text: string }) => item.text) ?? []
  })
}

async function topLevelTemplateOptionTexts(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.templates?.[0]?.items?.map((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text ?? '') ?? []
  })
}

async function listTemplateTopLevelTexts(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.listTemplates?.[0]?.items?.map((item: { text: string }) => item.text) ?? []
  })
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00`)
  parsed.setDate(parsed.getDate() + days)
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function pointerDrag(
  page: import('@playwright/test').Page,
  source: import('@playwright/test').Locator,
  target: import('@playwright/test').Locator,
  placement: 'before' | 'inside' | 'after',
) {
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Missing drag geometry')

  const targetY =
    placement === 'before'
      ? targetBox.y + 3
      : placement === 'after'
        ? targetBox.y + targetBox.height - 3
        : targetBox.y + targetBox.height / 2

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + Math.min(160, targetBox.width / 2), targetY, { steps: 8 })
  await page.mouse.up()
}

async function horizontalPointerDrag(
  page: import('@playwright/test').Page,
  source: import('@playwright/test').Locator,
  target: import('@playwright/test').Locator,
  placement: 'before' | 'after',
) {
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Missing tab drag geometry')

  const targetX = placement === 'before' ? targetBox.x + 3 : targetBox.x + targetBox.width - 3
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetX, targetBox.y + targetBox.height / 2, { steps: 8 })
  await page.mouse.up()
}

async function dragSelectAcrossEditors(
  page: import('@playwright/test').Page,
  source: import('@playwright/test').Locator,
  target: import('@playwright/test').Locator,
) {
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Missing selection drag geometry')

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 })
  await page.mouse.up()
}

async function verticalDrag(page: import('@playwright/test').Page, source: import('@playwright/test').Locator, yDelta: number) {
  const sourceBox = await source.boundingBox()
  if (!sourceBox) throw new Error('Missing drag geometry')

  const x = sourceBox.x + sourceBox.width / 2
  const y = sourceBox.y + sourceBox.height / 2

  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + yDelta, { steps: 4 })
  await page.mouse.up()
}

async function altVerticalDrag(page: import('@playwright/test').Page, source: import('@playwright/test').Locator, yDelta: number) {
  const sourceBox = await source.boundingBox()
  if (!sourceBox) throw new Error('Missing drag geometry')

  const x = sourceBox.x + sourceBox.width / 2
  const y = sourceBox.y + sourceBox.height / 2

  await page.keyboard.down('Alt')
  try {
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y + yDelta, { steps: 4 })
    await page.mouse.up()
  } finally {
    await page.keyboard.up('Alt')
  }
}
