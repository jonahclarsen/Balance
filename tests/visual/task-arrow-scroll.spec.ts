import { expect, test } from '@playwright/test'

// Arrowing onto a task above or below the screen scrolls it into view.
test('arrowing between tasks on Today keeps the focused task on screen', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop keyboard interaction')
  const date = '2026-10-08'
  await page.clock.install({ time: new Date(`${date}T12:00:00`) })
  await page.goto('/')
  await page.evaluate((date) => {
    const items = Array.from({ length: 60 }, (_, index) => ({
      id: `task_${index + 1}`, text: `Task ${index + 1}`, html: `Task ${index + 1}`,
      done: false, startMinutes: null, endMinutes: null, children: [],
    }))
    localStorage.clear()
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1, deviceId: 'arrow-scroll-test', localSequence: 0, historyRevision: 0, activePlanDate: date, templates: [],
      plans: [{ id: 'plan', date, title: 'Day', dailyReminder: '', items }],
      listTemplates: [], lists: [], metrics: [], metricEntries: [], goals: [], goalCompletions: [], operations: [],
    }))
  }, date)
  await page.reload()

  const editor = (id: number) => page.locator(`[data-plan-text-input-id="task_${id}"]`)
  const onScreen = (id: number) => editor(id).evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return rect.top >= 0 && rect.bottom <= window.innerHeight
  })

  await editor(60).click()
  await expect(editor(60)).toBeFocused()
  for (let id = 59; id >= 40; id -= 1) {
    await page.keyboard.press('ArrowUp')
    await expect(editor(id)).toBeFocused()
  }
  expect(await onScreen(40)).toBe(true)

  await editor(1).evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }))
  await expect.poll(() => onScreen(40)).toBe(false)
  await page.keyboard.press('ArrowDown')
  await expect(editor(41)).toBeFocused()
  await expect.poll(() => onScreen(41)).toBe(true)
})
