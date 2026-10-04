import { expect, test } from '@playwright/test'
import { generateDay } from '../helpers/navigation'

test('mobile header quick add saves with Enter or Save and closes with Cancel or the backdrop', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'The quick-add button is mobile-only')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await generateDay(page)

  const addButton = page.getByRole('button', { name: 'Add task', exact: true })
  const input = page.getByRole('textbox', { name: 'New task' })
  const tasks = page.locator('[data-plan-text-input]')

  await addButton.click()
  await expect(input).toBeFocused()
  await input.fill('Synthetic enter task')
  await input.press('Enter')
  await expect(input).toBeHidden()
  await expect(tasks.filter({ hasText: 'Synthetic enter task' })).toHaveCount(1)

  await addButton.click()
  await input.fill('Synthetic save task')
  await page.screenshot({ path: info.outputPath('quick-add.png') })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(tasks.filter({ hasText: 'Synthetic save task' })).toHaveCount(1)

  await addButton.click()
  await input.fill('Synthetic cancelled task')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(input).toBeHidden()

  await addButton.click()
  await input.fill('Synthetic dismissed task')
  await page.mouse.click(8, 8)
  await expect(input).toBeHidden()
  await expect(tasks.filter({ hasText: /Synthetic (cancelled|dismissed) task/ })).toHaveCount(0)
  await expect(page.getByText('reminders from siri:')).toHaveCount(0)
})

for (const scenario of [
  { date: '2026-09-16', existing: true, done: false, name: 'past incomplete day' },
  { date: '2026-09-20', existing: true, done: true, name: 'future completed day' },
  { date: '2026-09-17', existing: true, done: true, empty: true, name: 'empty today' },
  { date: '2026-09-19', existing: false, done: false, name: 'ungenerated future day' },
]) {
  test(`mobile quick add stays on the viewed ${scenario.name} and survives reload`, async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'The quick-add button is mobile-only')
    await page.clock.setFixedTime(new Date('2026-09-17T12:00:00'))
    await page.goto('/')
    await page.evaluate(async (scenario) => {
      const path = '/src/lib/planner.ts'
      const { createInitialState, createPlanItem } = await import(/* @vite-ignore */ path)
      const state = createInitialState()
      state.activePlanDate = scenario.date
      state.plans = scenario.existing ? [{
        id: 'synthetic-viewed-plan', date: scenario.date, title: 'Synthetic viewed day',
        dailyReminder: '', generatedFromTemplateId: null, createdAt: '2026-09-17T12:00:00Z',
        items: scenario.empty ? [] : [{ ...createPlanItem('Synthetic existing task'), done: scenario.done }],
      }] : []
      localStorage.clear()
      localStorage.setItem('balance.appState.v1', JSON.stringify(state))
    }, scenario)
    await page.reload()
    await expect(page.locator('.date-input')).toHaveValue(scenario.date)
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    await page.getByRole('textbox', { name: 'New task' }).fill('Synthetic selected-day task')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('.date-input')).toHaveValue(scenario.date)
    await expect(page.locator('[data-plan-text-input]').filter({ hasText: 'Synthetic selected-day task' })).toHaveCount(1)
    await page.reload()
    await expect(page.locator('.date-input')).toHaveValue(scenario.date)
    await expect(page.locator('[data-plan-text-input]').filter({ hasText: 'Synthetic selected-day task' })).toHaveCount(1)
    const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).plans)
    expect(plans).toHaveLength(1)
    expect(plans[0].date).toBe(scenario.date)
    if (scenario.existing) expect(plans[0].id).toBe('synthetic-viewed-plan')
  })
}
