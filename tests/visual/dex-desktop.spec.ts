import { expect, test, type Page } from '@playwright/test'
import { openView } from '../helpers/navigation'
import { createScreenshotState } from '../../website/capture/seed'

// Samsung DeX: an Android phone driving a desktop-sized window with a
// keyboard and mouse. It should behave like the desktop layout it shows.
const ANDROID = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

async function open(page: Page, themeId = 'graphite') {
  await page.clock.install({ time: new Date('2026-10-14T14:20:00') })
  await page.goto('/')
  await page.evaluate(([state, themeId]) => {
    localStorage.clear()
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
    localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, themeId, colorScheme: 'light' }))
  }, [createScreenshotState('2026-10-14'), themeId] as const)
  await page.reload()
}

const plainRow = (page: Page, text: string) =>
  page.locator('[data-plan-item-id]').filter({ has: page.locator('[data-plan-text-focus-target]', { hasText: new RegExp(`^${text}$`) }) }).first()

test.describe('desktop-sized Android window', () => {
  test.use({ userAgent: ANDROID, viewport: { width: 1280, height: 800 } })

  for (const themeId of ['windowsxp', 'windowsvista', 'system1']) {
    test(`${themeId} fills the window, with Control Panel beside Settings`, async ({ page }, testInfo) => {
      await open(page, themeId)
      const caption = page.locator('.window-caption')
      await expect(caption).toBeVisible()
      await expect(caption.locator('.caption-button:visible')).toHaveCount(0)
      expect((await page.locator('.content-shell').boundingBox())!.height).toBeGreaterThan(600)
      if (themeId === 'system1') return

      await openView(page, 'Settings')
      const pane = page.locator('.control-panel-tasks')
      const theme = page.locator('.settings-section[data-cp="theme"]')
      await expect(pane).toBeVisible()
      const paneBox = (await pane.boundingBox())!
      const themeBox = (await theme.boundingBox())!
      expect(paneBox.x + paneBox.width).toBeLessThanOrEqual(themeBox.x)
      expect(paneBox.height).toBeGreaterThan(500)
      await page.screenshot({ path: testInfo.outputPath(`${themeId}-settings.png`) })
    })
  }

  test('tasks use desktop editing: Enter splits once and times drag inline', async ({ page }) => {
    await open(page)
    const row = page.getByRole('listitem', { name: /^Plan item: Admin and email/ })
    await expect(row.locator('.time-range')).toBeVisible()
    await expect(page.locator('.mobile-time-summary')).toHaveCount(0)

    const editor = row.locator('[data-plan-text-focus-target]').first()
    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Inbox zero')
    await expect(plainRow(page, 'Inbox zero')).toHaveCount(1)
    await expect(editor).toHaveText('Admin and email')
  })

  test('time drags read Alt and Shift held on the keyboard', async ({ page }) => {
    await open(page)
    const row = page.getByRole('listitem', { name: /^Plan item: Admin and email/ })
    const start = row.locator('.time-start-side .time-part')
    const box = (await start.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    // Android can leave modifiers off mouse events; only the key events carry them.
    const key = (type: 'keydown' | 'keyup', key: 'Alt' | 'Shift', altKey: boolean, shiftKey: boolean) =>
      page.evaluate(([type, key, altKey, shiftKey]) => {
        window.dispatchEvent(new KeyboardEvent(type as string, { key: key as string, altKey: altKey as boolean, shiftKey: shiftKey as boolean }))
      }, [type, key, altKey, shiftKey] as const)

    await key('keydown', 'Alt', true, false)
    await key('keydown', 'Shift', true, true)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y - 10, { steps: 2 })
    await page.mouse.up()
    await key('keyup', 'Shift', true, false)
    await key('keyup', 'Alt', false, false)
    // Alt moves only the start; Shift steps by five minutes.
    await expect(row.locator('.time-range')).toHaveText(/2:05pm\s*-\s*3pm/)
  })
})

test.describe('phone-sized Android window with a mouse', () => {
  test.use({ userAgent: ANDROID, viewport: { width: 412, height: 860 } })

  test('a mouse press on a button lands before the keyboard closes', async ({ page }) => {
    await open(page)
    const editor = page.getByRole('listitem', { name: /^Plan item: Admin and email/ }).locator('[data-plan-text-focus-target]').first()
    await editor.click()
    await expect(editor).toBeFocused()
    await page.evaluate(() => {
      const button = document.createElement('button')
      button.id = 'press-fixture'
      button.textContent = 'Press'
      button.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:99999'
      button.addEventListener('click', () => { button.dataset.pressed = 'true' })
      document.body.append(button)
    })
    const button = page.locator('#press-fixture')
    const box = (await button.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    // Focus, and so the on-screen keyboard, stays until the press completes.
    await expect(editor).toBeFocused()
    await page.mouse.up()
    await expect(button).toHaveAttribute('data-pressed', 'true')
    await expect(editor).not.toBeFocused()
  })
})
