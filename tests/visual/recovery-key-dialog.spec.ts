import { expect, test } from '@playwright/test'

test('Android recovery-key confirmation stays usable in a short viewport and submits with Enter', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'The regression is caused by the phone-width column layout')

  await page.setViewportSize({ width: 360, height: 420 })
  await page.addInitScript(() => {
    type TestRuntime = typeof globalThis & {
      isTauri: boolean
      __confirmedRecoveryKeys: string[]
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
        transformCallback: () => number
      }
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => void
      }
    }

    const runtime = globalThis as TestRuntime
    const syntheticRecoveryKey = 'TEST-ONLY-RECO-VERY-KEY0-0000-0000-0000-0000-0000-0000-0000'
    let confirmed = false

    Object.defineProperty(navigator, 'userAgent', { value: 'Balance Android CI', configurable: true })
    runtime.isTauri = true
    runtime.__confirmedRecoveryKeys = []
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
    runtime.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        switch (command) {
          case 'read_app_state':
          case 'initialize_app_state':
          case 'plugin:event|listen':
          case 'plugin:event|unlisten':
          case 'complete_database_maintenance_startup':
            return null
          case 'get_recovery_key_status':
            return {
              confirmed,
              recoveryKey: confirmed ? null : syntheticRecoveryKey,
              databasePath: '/tmp/synthetic-balance.sqlite3',
            }
          case 'confirm_recovery_key':
            runtime.__confirmedRecoveryKeys.push(String(args?.recoveryKey ?? ''))
            confirmed = true
            return null
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
              autoJsonExportErrorAt: null,
              autoJsonExportErrorAckAt: null,
            }
          case 'get_sync_settings':
            return { enabled: false, pairingCode: null, relayUrl: '' }
          case 'build_info':
            return { version: 'test', commit: 'test' }
          case 'get_database_maintenance_status':
            return {
              due: false,
              lastCompletedAt: null,
              checkpointCoordinator: true,
              databaseBytes: 0,
              reclaimableBytes: 0,
              reclaimablePercent: 0,
              operationCount: 0,
              operationBytes: 0,
              checkpointRecommended: false,
            }
          default:
            return null
        }
      },
    }
  })

  await page.goto('/')

  const dialog = page.getByRole('dialog', { name: 'Save your recovery key' })
  const input = page.getByLabel('Re-enter the complete key to prove your saved copy works.')
  const continueButton = dialog.getByRole('button', { name: 'Continue' })
  await expect(dialog).toBeVisible()

  const layout = await dialog.evaluate((element) => {
    const confirmation = element.querySelector<HTMLInputElement>('#recovery-key-confirmation')
    if (!confirmation) throw new Error('Missing recovery-key confirmation input')
    const style = getComputedStyle(element)
    return {
      dialogHeight: element.getBoundingClientRect().height,
      inputHeight: confirmation.getBoundingClientRect().height,
      overflowY: style.overflowY,
      viewportHeight: window.innerHeight,
    }
  })

  expect(layout.inputHeight).toBeLessThan(60)
  expect(layout.dialogHeight).toBeLessThanOrEqual(layout.viewportHeight - 40)
  expect(layout.overflowY).toBe('auto')

  await continueButton.scrollIntoViewIfNeeded()
  await expect(continueButton).toBeVisible()

  const syntheticRecoveryKey = await dialog.locator('.recovery-key').textContent()
  expect(syntheticRecoveryKey).toBeTruthy()
  await input.fill(syntheticRecoveryKey ?? '')
  await input.press('Enter')

  await expect(dialog).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __confirmedRecoveryKeys: string[] }
    return runtime.__confirmedRecoveryKeys
  })).toEqual([syntheticRecoveryKey])
})
