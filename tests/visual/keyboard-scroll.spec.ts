import { expect, test } from '@playwright/test'
import { todayISO } from '../../src/lib/planner'
import { openView } from '../helpers/navigation'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate((date) => {
    localStorage.clear()
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1, deviceId: 'scroll-test', localSequence: 0, historyRevision: 0,
      activePlanDate: date, templates: [], goals: [], goalCompletions: [], operations: [],
      plans: [{ id: 'scroll-plan', date, dailyReminder: '', items: Array.from({ length: 100 }, (_, i) => ({
        id: `task-${i}`, text: `Synthetic task ${i}`, html: `Synthetic task ${i}`,
        children: [], done: false, startMinutes: null, endMinutes: null,
      })) }],
    }))
  }, todayISO())
  await page.reload()
})

test('Escape leaves task editing; held W/S accelerates linearly and stops immediately', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'W/S scrolling is a desktop keyboard feature')
  const editor = page.locator('[data-plan-text-input]').first()
  await editor.focus()
  await page.keyboard.press('Escape')
  await expect(editor).not.toBeFocused()
  const scrollTop = () => page.locator('.workspace').evaluate(el => el.scrollTop)
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  // Align Playwright's 16 ms frames so the 400 ms intervals end on a frame.
  await page.clock.runFor(16 - (await page.evaluate(() => performance.now() % 16)))
  const initial = await scrollTop()
  await page.keyboard.down('s')
  await page.clock.runFor(400)
  const first = await scrollTop()
  await page.clock.runFor(400)
  const second = await scrollTop()
  // At 950 px/s with a linear 50% ramp over 1000 ms, the first and second
  // 400 ms intervals cover 418 px and 494 px respectively.
  expect(first - initial).toBeGreaterThan(408)
  expect(first - initial).toBeLessThan(428)
  expect(second - first).toBeGreaterThan(484)
  expect(second - first).toBeLessThan(504)
  await page.clock.runFor(400)
  const third = await scrollTop()
  // The ramp completes during this interval and reaches 1425 px/s.
  expect(third - second).toBeGreaterThan(550)
  expect(third - second).toBeLessThan(571)
  await page.keyboard.up('s')
  await page.clock.runFor(500)
  expect(await scrollTop()).toBe(third)
  await page.keyboard.down('w')
  await page.clock.runFor(500)
  await page.keyboard.up('w')
  expect(third - await scrollTop()).toBeGreaterThan(515)
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

test('held arrow keys scroll other pages unless a control claims them', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard scrolling is a desktop keyboard feature')
  await openView(page, 'Settings')
  const workspace = page.locator('.workspace')
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  const initial = await workspace.evaluate(el => el.scrollTop)
  await page.keyboard.down('ArrowDown')
  await expect.poll(() => workspace.evaluate(el => el.scrollTop)).toBeGreaterThan(initial + 100)
  await page.keyboard.up('ArrowDown')
  const afterArrow = await workspace.evaluate(el => el.scrollTop)
  await page.keyboard.down('w')
  await expect.poll(() => workspace.evaluate(el => el.scrollTop)).toBeLessThan(afterArrow - 100)
  await page.keyboard.up('w')

  // A focused celebration grid uses the arrows to move between options.
  await page.locator('[aria-controls="celebration-gallery"]').click()
  const option = page.locator('[data-celebration-option]').first()
  await option.focus()
  const beforeGrid = await workspace.evaluate(el => el.scrollTop)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.down('ArrowDown')
  await page.waitForTimeout(500)
  await page.keyboard.up('ArrowDown')
  await expect(page.locator('[data-celebration-option]').first()).not.toBeFocused()
  // Revealing the newly focused row may nudge the page; a held scroll would
  // cover more than 450 px in this time.
  expect(Math.abs(await workspace.evaluate(el => el.scrollTop) - beforeGrid)).toBeLessThan(250)
})
