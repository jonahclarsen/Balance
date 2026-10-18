import { expect, test } from '@playwright/test'
import { openView } from '../helpers/navigation'

test('past days can be generated once but existing past plans are kept', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-17T12:00:00'))
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await page.locator('.date-input').fill('2026-09-16')
  await expect(page.locator('.empty-state input[type="radio"]').first()).toBeVisible()

  const generate = async (date: string, replaceExisting = false) => page.evaluate(async ({ date, replaceExisting }) => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    await plannerStore.ready
    let state: any
    const stop = plannerStore.subscribe((value: any) => { state = value })
    const before = JSON.stringify(state)
    plannerStore.generatePlan(state.templates[0].id, date, replaceExisting)
    const result = { unchanged: JSON.stringify(state) === before, dates: state.plans.map((plan: any) => plan.date) }
    stop()
    return result
  }, { date, replaceExisting })

  expect((await generate('2026-09-16')).dates).toContain('2026-09-16')
  expect((await generate('2026-09-16', true)).unchanged).toBe(true)
  expect((await generate('2026-09-16')).unchanged).toBe(true)
  expect((await generate('2026-09-17')).dates).toContain('2026-09-17')
  expect((await generate('2026-09-18')).dates).toContain('2026-09-18')
  await page.clock.setFixedTime(new Date('2026-09-18T12:00:00'))
  expect((await generate('2026-09-17', true)).unchanged).toBe(true)
  await page.reload()
  await page.locator('.date-input').fill('2026-09-17')
  if (await page.getByRole('button', { name: 'Open navigation' }).isVisible()) {
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(page.getByRole('button', { name: 'Generate selected day' })).toBeDisabled()
    await page.getByRole('button', { name: 'Close navigation', exact: true }).first().click()
  } else {
    await expect(page.getByRole('button', { name: 'Generate selected day' })).toBeDisabled()
  }
  await expect(page.locator('[data-plan-text-input]:visible').first()).toBeVisible()
})

for (const shortcut of ['Meta+Shift+g', 'Control+Shift+g']) {
  test(`${shortcut} generates the selected day`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-17T12:00:00'))
    await page.goto('/')
    await page.locator('.date-input').fill('2026-09-18')
    await page.keyboard.press(shortcut)

    await expect(page.locator('.date-input')).toHaveValue('2026-09-18')
    await expect(page.locator('[data-plan-text-input]').filter({ hasText: 'Wake up' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
      return state.plans?.map((plan: { date: string }) => plan.date)
    })).toEqual(['2026-09-18'])
  })
}

test('unshifted Cmd/Ctrl+G does not generate a day and Find keeps its shortcuts', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-17T12:00:00'))
  await page.goto('/')
  await page.locator('.date-input').fill('2026-09-18')
  for (const shortcut of ['Meta+g', 'Control+g']) {
    await page.keyboard.press(shortcut)
    await expect(page.locator('.empty-state')).toBeVisible()
  }
  await expect(page.locator('.generate-day-button').first()).toHaveAttribute('aria-keyshortcuts', /(?:Meta|Control)\+Shift\+G/)
  await page.keyboard.press('Meta+f')
  await expect(page.getByLabel('Find text', { exact: true })).toBeVisible()
  await page.keyboard.press('Meta+g')
  await expect(page.locator('.empty-state')).toBeVisible()
  await page.keyboard.press('Meta+Shift+g')
  await expect(page.locator('.empty-state')).toBeVisible()
  await page.keyboard.press('Escape')
  await openView(page, 'Days')
  await page.keyboard.press('Meta+g')
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeHidden()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1') || '{}').plans ?? [])).toEqual([])
})
