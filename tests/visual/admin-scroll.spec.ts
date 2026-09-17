import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    const date = new Date().toISOString().slice(0, 10)
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1, deviceId: 'scroll-test', localSequence: 0, historyRevision: 0,
      activePlanDate: date, templates: [], goals: [], goalCompletions: [], operations: [],
      plans: [{ id: 'scroll-plan', date, dailyReminder: '', items: Array.from({ length: 100 }, (_, i) => ({
        id: `task-${i}`, text: `Synthetic task ${i}`, html: `Synthetic task ${i}`,
        children: [], done: false, startMinutes: null, endMinutes: null,
      })) }],
    }))
  })
  await page.reload()
})

test('Escape leaves task editing; held W/S scroll linearly and stop immediately', async ({ page }) => {
  const editor = page.locator('[data-plan-text-input]').first()
  await editor.focus()
  await page.keyboard.press('Escape')
  await expect(editor).not.toBeFocused()
  const scrollTop = () => page.locator('.workspace').evaluate(el => el.scrollTop)
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  const initial = await scrollTop()
  await page.keyboard.down('s')
  await page.clock.runFor(500)
  const first = await scrollTop()
  await page.clock.runFor(500)
  const second = await scrollTop()
  expect(first - initial).toBeGreaterThan(280)
  expect(first - initial).toBeLessThan(315)
  expect(second - first).toBeGreaterThan(280)
  expect(second - first).toBeLessThan(315)
  await page.keyboard.up('s')
  await page.clock.runFor(500)
  expect(await scrollTop()).toBe(second)
  await page.keyboard.down('w')
  await page.clock.runFor(500)
  await page.keyboard.up('w')
  expect(second - await scrollTop()).toBeGreaterThan(280)
  await editor.focus()
  const beforeTyping = await scrollTop()
  await page.keyboard.down('s')
  await page.clock.runFor(500)
  await page.keyboard.up('s')
  expect(await scrollTop()).toBe(beforeTyping)
  await expect(editor).toContainText('s')
  await page.keyboard.press('Escape')
  await page.keyboard.down('s')
  await page.clock.runFor(100)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  const afterBlur = await scrollTop()
  await page.clock.runFor(500)
  expect(await scrollTop()).toBe(afterBlur)
  await page.keyboard.up('s')
})

test('admin settings show defaults, persist speed and reset it; studio moved out of Settings', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByLabel('Iridescent background controls')).toHaveCount(0)
  await page.getByRole('button', { name: 'Admin Settings', exact: true }).click()
  await expect(page.getByText('Default: 600 px/s.', { exact: false })).toBeVisible()
  const speed = page.getByLabel('Scroll speed (px/s)')
  await expect(speed).toHaveValue('600')
  await speed.fill('1200')
  await speed.press('Tab')
  await page.reload()
  await page.getByRole('button', { name: 'Admin Settings', exact: true }).click()
  await expect(speed).toHaveValue('1200')
  await expect(page.getByLabel('Iridescent background controls')).toBeVisible()
  await page.getByRole('button', { name: 'Reset scroll speed' }).click()
  await expect(speed).toHaveValue('600')
})
