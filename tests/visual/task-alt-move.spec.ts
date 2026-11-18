import { expect, test } from '@playwright/test'

// Alt+Arrow moves the focused task without detaching its editor, in both
// directions. Svelte used to relocate the focused row's own DOM node on every
// Alt+Down (see patches/svelte@*.patch), blurring the editor and resetting the
// caret.
test('Alt+Arrow moves a task down and up keeping its editor and caret', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop keyboard interaction')
  test.setTimeout(60_000)
  const date = '2026-10-08'
  await page.clock.install({ time: new Date(`${date}T12:00:00`) })
  await page.goto('/')
  await page.evaluate((date) => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `task_${index + 1}`, text: `Task ${index + 1}`, html: `Task ${index + 1}`,
      done: false, startMinutes: null, endMinutes: null, children: [],
    }))
    localStorage.clear()
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1, deviceId: 'alt-move-test', localSequence: 0, historyRevision: 0, activePlanDate: date, templates: [],
      plans: [{ id: 'plan', date, title: 'Day', dailyReminder: '', items }],
      listTemplates: [], lists: [], metrics: [], metricEntries: [], goals: [], goalCompletions: [], operations: [],
    }))
  }, date)
  await page.reload()

  const editor = page.locator('[data-plan-text-input-id="task_5"]')
  const order = () => page.locator('[data-plan-text-input-id]').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.planTextInputId))
  await editor.click()
  await expect(editor).toBeFocused()
  // Put the caret inside the text: "Ta|sk 5".
  await editor.evaluate((node) => document.getSelection()?.collapse(node.firstChild, 2))
  await editor.evaluate((node) => {
    const runtime = window as unknown as { altMoveBlurs: number }
    runtime.altMoveBlurs = 0
    node.addEventListener('blur', () => { runtime.altMoveBlurs += 1 })
  })

  const timings: Record<'ArrowDown' | 'ArrowUp', number[]> = { ArrowDown: [], ArrowUp: [] }
  await page.keyboard.down('Alt')
  try {
    for (const key of ['ArrowDown', 'ArrowUp'] as const) {
      const before = (await order()).indexOf('task_5')
      for (let press = 0; press < 5; press += 1) {
        await page.evaluate(() => {
          const runtime = window as unknown as { altMoveSample: Promise<number> }
          runtime.altMoveSample = new Promise((resolve) => {
            let started = 0
            window.addEventListener('keydown', () => {
              started = performance.now()
              requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)))
            }, { once: true, capture: true })
          })
        })
        await page.keyboard.press(key)
        timings[key].push(await page.evaluate(() => (window as unknown as { altMoveSample: Promise<number> }).altMoveSample))
      }
      await expect.poll(async () => (await order()).indexOf('task_5')).toBe(before + (key === 'ArrowDown' ? 5 : -5))
      await expect(editor).toBeFocused()
    }
  } finally {
    await page.keyboard.up('Alt')
  }

  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  console.log(`ALT_MOVE_TIMING ${JSON.stringify({
    browser: test.info().project.name,
    downMedianMs: median(timings.ArrowDown), upMedianMs: median(timings.ArrowUp), timings,
    blurs: await page.evaluate(() => (window as unknown as { altMoveBlurs: number }).altMoveBlurs),
  })}`)

  expect(await page.evaluate(() => (window as unknown as { altMoveBlurs: number }).altMoveBlurs)).toBe(0)
  expect(await editor.evaluate((node) => {
    const range = document.getSelection()?.getRangeAt(0)
    return range && node.contains(range.startContainer) ? range.startOffset : -1
  })).toBe(2)
})
