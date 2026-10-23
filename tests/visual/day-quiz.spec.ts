import { expect, test } from '@playwright/test'
import { generateDay, openView } from '../helpers/navigation'

test.use({ timezoneId: 'America/Vancouver' })

// 11 a.m. in Vancouver, well clear of the 5 a.m. day boundary.
const NOW = new Date('2026-10-08T18:00:00Z')

test('a question with a blank only answer takes a typed answer after the question', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await page.clock.install({ time: NOW })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openView(page, 'Days')
  await page.getByRole('button', { name: 'New day', exact: true }).last().click()
  await page.getByRole('button', { name: 'Ask a question when generating the day' }).first().click()
  await page.keyboard.type('Focus:')

  await generateDay(page)
  const quiz = page.locator('.day-quiz')
  await expect(quiz.getByText('Focus:', { exact: true })).toBeVisible()
  const answer = quiz.getByRole('textbox', { name: 'Focus:' })
  await expect(answer).toBeFocused()
  // Quiz letter shortcuts must not fire while typing.
  await page.keyboard.type('snack break')
  await expect(answer).toHaveValue('snack break')
  await page.keyboard.press('Enter')

  await expect(quiz).toBeHidden()
  await expect(page.getByRole('region', { name: 'Daily plan' }).locator('[data-plan-text-input]')).toHaveText(['Focus: snack break'])
})

test('Cmd+Shift+A selects the row from its question field', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openView(page, 'Days')
  await page.getByRole('button', { name: 'New day', exact: true }).last().click()
  await page.locator('[data-template-option-text-input]').first().fill('Breakfast')
  await page.getByRole('button', { name: 'Ask a question when generating the day' }).first().click()
  await expect(page.locator('.question-input')).toBeFocused()
  await page.keyboard.press('Meta+Shift+A')
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-template-option-text-input]')).not.toHaveText(['Breakfast'])
  await expect(page.locator('.question-input')).toHaveCount(0)
})

test('a day row can wait for no active project, shown by a row indicator', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openView(page, 'Days')
  await page.getByRole('button', { name: 'New day', exact: true }).last().click()
  await page.locator('[data-template-option-text-input]').first().fill('Breakfast')
  await page.getByRole('button', { name: '+ Add template item', exact: true }).click()
  const row = page.locator('[data-template-option-text-input]').nth(1)
  await row.fill('Pick projects')
  await page.getByRole('button', { name: 'Ask a question when generating the day' }).last().click()
  await page.keyboard.type('Pick projects?')

  const gate = page.locator('.active-project-gate')
  await expect(gate).toHaveCount(0)
  await row.click({ button: 'right' })
  const toggle = page.getByRole('menuitemcheckbox', { name: 'Only when no active project' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(gate).toBeVisible()

  await generateDay(page)
  const quiz = page.locator('.day-quiz')
  await expect(quiz.getByText('Pick projects?', { exact: true })).toBeVisible()
  await page.keyboard.press('y')
  await expect(quiz).toBeHidden()
  await expect(page.getByRole('region', { name: 'Daily plan' }).locator('[data-plan-text-input]')).toHaveText(['Breakfast', 'Pick projects'])

  // Activity is judged at noon on the generated day: a project active until
  // 7 a.m. on the 10th counts on the 9th but not the 10th.
  const generated = await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let state: any
    const read = () => { plannerStore.subscribe((value: any) => { state = value })(); return state }
    const template = read().templates.at(-1)
    const gated = template.items.find((item: any) => item.id === read().templateItemConditions[0].id)
    const project = plannerStore.addProject('Synthetic project')
    plannerStore.setProjectActiveDays(project, 2)
    const items = (date: string) => {
      plannerStore.generatePlan(template.id, date, false, { [gated.id]: gated.options[0].id })
      return read().plans.find((plan: any) => plan.date === date).items.map((item: any) => item.text)
    }
    return { active: items('2026-10-09'), lapsed: items('2026-10-10') }
  })
  expect(generated).toEqual({ active: ['Breakfast'], lapsed: ['Breakfast', 'Pick projects'] })

  await openView(page, 'Days')
  await gate.click()
  await expect(gate).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).templateItemConditions)).toEqual([])
})

test('a list question is asked when the list is generated', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openView(page, 'Lists')
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.getByLabel('List name').fill('Groceries')
  await page.locator('[data-list-template-text-input]').first().fill('Milk')
  await page.getByRole('button', { name: 'Ask a question when generating the list' }).click()
  await page.keyboard.type('Which milk?')
  await page.getByRole('button', { name: 'Add answer' }).click()
  await page.keyboard.type('Oat milk')

  await openView(page, 'Today')
  await generateDay(page)
  const task = page.locator('[data-plan-text-input]').first()
  await task.fill('Groceries')
  await task.blur()
  await page.getByTitle('Open Groceries').first().click()

  const quiz = page.locator('.day-quiz')
  await expect(quiz.getByText('Which milk?', { exact: true })).toBeVisible()
  await quiz.getByRole('button', { name: 'Oat milk' }).click()
  await expect(quiz).toBeHidden()
  const list = page.getByRole('dialog', { name: 'Groceries' })
  await expect(list.getByText('Oat milk')).toBeVisible()
  await expect(list.getByText('Milk', { exact: true })).toHaveCount(0)
})
