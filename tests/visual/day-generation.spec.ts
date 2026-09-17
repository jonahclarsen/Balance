import { expect, test } from '@playwright/test'

test('generation rejects past days and preserves existing history', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-17T12:00:00'))
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await page.locator('.date-input').fill('2026-09-16')
  if (await page.getByRole('button', { name: 'Open navigation' }).isVisible()) {
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(page.getByRole('button', { name: 'Generate selected day' })).toBeDisabled()
    await page.getByRole('button', { name: 'Close navigation', exact: true }).first().click()
  } else {
    await expect(page.getByRole('button', { name: 'Generate selected day' })).toBeDisabled()
  }
  await expect(page.locator('.empty-state')).toContainText('Days before today cannot be generated.')
  await expect(page.locator('.empty-state input[type="radio"]')).toHaveCount(0)

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
  await expect(page.locator('[data-plan-text-input]').first()).toBeVisible()
})
