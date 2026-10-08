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
  await expect(page.locator('.retained-day')).toHaveCount(0)
})
