import { expect, test, type Page } from '@playwright/test'
import { generateDay } from '../helpers/navigation'

const check = (page: Page) => page.getByRole('dialog', { name: 'Emptied your whole calendar?' })
const topTexts = (page: Page) => page.locator('[data-plan-text-input]:visible').allTextContents()

async function pasteText(page: Page, text: string) {
  await page.evaluate((text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
}

test('the calendar check sorts pasted ideas and adds its task at most every other day', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-17T12:00:00'))
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()

  await generateDay(page)
  await expect(check(page)).toBeVisible()
  await pasteText(page, 'Dentist at 3\nCall the bank')
  await expect(check(page).getByRole('status')).toHaveText('2 to sort')
  await page.keyboard.press('d')

  // Pasted lines go through the idea sort before the day is made.
  const sorter = page.getByRole('dialog', { name: 'Sort new ideas' })
  await expect(sorter).toBeVisible()
  await expect(sorter).toContainText('Call the bank')
  await sorter.getByRole('button', { name: 'Close' }).first().click()
  await expect(page.locator('[data-plan-text-input]').filter({ hasText: 'Wake up' })).toHaveCount(0)

  // Closing cancels; generating again asks again.
  await generateDay(page)
  await expect(check(page)).toBeVisible()
  await page.keyboard.press('d')
  await expect(sorter).toBeVisible()
  for (const remaining of [2, 1]) {
    await expect(sorter).toContainText(remaining === 2 ? 'Call the bank' : 'Dentist at 3')
    await page.keyboard.press('y')
    await page.keyboard.press('d')
  }
  await expect(sorter).toBeHidden()
  await expect(page.locator('[data-plan-text-input]:visible').filter({ hasText: 'Wake up' })).toBeVisible()
  expect((await topTexts(page)).slice(0, 3)).toEqual(['Empty out your calendar', 'Dentist at 3', 'Call the bank'])

  // The next day it can only be passed with Done.
  await page.locator('.date-input').fill('2026-09-18')
  await generateDay(page)
  await expect(check(page).getByRole('button', { name: 'Add to day (D)' })).toBeDisabled()
  await page.keyboard.press('d')
  await expect(check(page)).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(check(page)).toBeHidden()
  await expect(page.locator('[data-plan-text-input]:visible').filter({ hasText: 'Wake up' })).toBeVisible()
  expect(await topTexts(page)).not.toContain('Empty out your calendar')
})
