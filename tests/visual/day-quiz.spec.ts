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
