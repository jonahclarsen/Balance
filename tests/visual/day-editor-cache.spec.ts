import { expect, test } from '@playwright/test'
import { openView } from '../helpers/navigation'

test('recent days reuse editors, stay current through edits and undo, and expire', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-08T12:00:00') })
  await page.goto('/')
  const fixtures = await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    await plannerStore.ready
    let state: any
    const stop = plannerStore.subscribe((value: any) => { state = value })
    const dates = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']
    for (const date of dates) plannerStore.generatePlan(state.templates[0].id, date)
    plannerStore.setActivePlanDate(dates[0])
    const fixtures = dates.map((date) => {
      const plan = state.plans.find((plan: any) => plan.date === date)
      return { date, planId: plan.id, itemId: plan.items[0].id }
    })
    stop()
    return fixtures
  })
  const first = page.locator(`[data-plan-text-input-id="${fixtures[0].itemId}"]`)
  await expect(first).toBeVisible()
  await first.evaluate((node) => { (window as any).retainedEditor = node })
  await first.evaluate(async (editor) => {
    const path = '/src/lib/imageService.ts'
    const { selectedImage } = await import(/* @vite-ignore */ path)
    const image = document.createElement('img')
    editor.append(image)
    selectedImage.set({ image, editor, commit: () => {} })
  })
  await page.getByLabel('Day date', { exact: true }).fill(fixtures[1].date)
  await expect(first).toBeHidden()
  await expect(page.locator('.image-selection')).toHaveCount(0)
  await expect(page.locator('.retained-day')).toHaveCount(2)

  // A background update (the same live store path used by sync) must reach a
  // retained editor. Undo must also reconcile it before it is shown again.
  await page.evaluate(async ({ planId, itemId }) => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    plannerStore.patchPlanItem(planId, itemId, { text: 'Updated while hidden', html: 'Updated while hidden', done: true })
  }, fixtures[0])
  await page.getByLabel('Day date', { exact: true }).fill(fixtures[0].date)
  await expect(first).toHaveText('Updated while hidden')
  expect(await first.evaluate((node) => node === (window as any).retainedEditor)).toBe(true)
  await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    await plannerStore.undo()
  })
  await expect(first).not.toHaveText('Updated while hidden')
  await first.fill('Edited after returning')
  await page.getByLabel('Day date', { exact: true }).fill(fixtures[1].date)
  await page.getByLabel('Day date', { exact: true }).fill(fixtures[0].date)
  await expect(first).toHaveText('Edited after returning')

  for (const fixture of fixtures.slice(1)) {
    await page.getByLabel('Day date', { exact: true }).fill(fixture.date)
    await expect(page.locator(`[data-plan-text-input-id="${fixture.itemId}"]`)).toBeVisible()
  }
  await expect(page.locator('.retained-day')).toHaveCount(3)
  await expect(first).toHaveCount(0) // The least recently used day is evicted.
  await page.clock.fastForward(3 * 60 * 1000 + 1)
  await expect(page.locator('.retained-day')).toHaveCount(1)
  await expect(page.locator(`[data-plan-text-input-id="${fixtures[3].itemId}"]`)).toBeVisible()
  await page.getByLabel('Day date', { exact: true }).fill(fixtures[0].date)
  await expect(first).toHaveText('Edited after returning')
  expect(await first.evaluate((node) => node === (window as any).retainedEditor)).toBe(false)
  await openView(page, 'Notes')
  await expect(page.locator('.retained-day')).not.toHaveCount(0)
  await page.clock.fastForward(30_001)
  await expect(page.locator('.retained-day')).toHaveCount(0)
})

for (const themeId of ['graphite', 'windowsvista']) {
  test(`held Alt-arrow keeps the editor usable through moves, undo and reload in ${themeId}`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop keyboard interaction')
    const date = '2026-10-08'
    await page.clock.setFixedTime(new Date(`${date}T12:00:00`))
    await page.addInitScript(({ date, themeId }) => {
      if (localStorage.getItem('keyboard-test-ready')) return
      const item = (id: string, text: string) => ({ id, text, html: text, done: false, startMinutes: null, endMinutes: null, children: [] })
      localStorage.setItem('balance.appState.v1', JSON.stringify({
        schemaVersion: 1, deviceId: 'keyboard-test', localSequence: 0, historyRevision: 0,
        activePlanDate: date, templates: [], goals: [], goalCompletions: [], operations: [],
        plans: [{ id: 'keyboard-plan', date, dailyReminder: '', items: [
          { ...item('moving', 'Moving task'), children: [item('child', 'Child task')] },
          ...Array.from({ length: 12 }, (_, index) => item(`sibling-${index}`, `Sibling ${index}`)),
        ] }],
      }))
      localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, themeId }))
    }, { date, themeId })
    await page.goto('/')
    const editor = page.locator('[data-plan-text-input-id="moving"]')
    await editor.focus()
    await page.keyboard.down('Alt')
    await page.keyboard.down('ArrowDown')
    await page.keyboard.down('ArrowDown')
    await page.keyboard.up('ArrowDown')
    await page.keyboard.up('Alt')
    const order = () => page.locator('[data-plan-item-scope="keyboard-plan"] > .item-shell > [data-plan-item-id]').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.planItemId))
    await expect.poll(order).toEqual(['sibling-0', 'sibling-1', 'moving', ...Array.from({ length: 10 }, (_, index) => `sibling-${index + 2}`)])
    await expect(editor).toBeFocused()
    expect(await editor.evaluate(element => {
      const selection = document.getSelection()
      return Boolean(selection?.isCollapsed && element.contains(selection.anchorNode))
    })).toBe(true)
    await page.keyboard.press('x')
    await expect(editor).toHaveText('Moving taskx')
    await expect(page.locator('[data-plan-text-input-id="child"]')).toHaveText('Child task')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(editor).toHaveText('Moving task')
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await order())[1]).toBe('moving')
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await order())[0]).toBe('moving')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await order())[1]).toBe('moving')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await order())[2]).toBe('moving')
    // Skip reseeding on reload so persisted order is tested.
    await page.evaluate(() => localStorage.setItem('keyboard-test-ready', '1'))
    await page.reload()
    await expect.poll(async () => (await order())[2]).toBe('moving')
  })
}
