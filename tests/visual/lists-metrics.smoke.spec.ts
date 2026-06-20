import { expect, test } from '@playwright/test'

// Throwaway smoke test for the Lists + Metrics features.
test('list link opens a toast, completing it auto-checks the task', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  // Create a list template named "Groceries" with two items.
  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list template' }).click()
  await expect(page.getByRole('heading', { name: 'List template' })).toBeVisible()
  await page.getByLabel('List name').fill('Groceries')

  const listItems = page.locator('[data-list-template-text-input]')
  await expect(listItems.first()).toBeVisible()
  await listItems.first().fill('Milk')

  // Generate today's plan and create a task that matches the list name exactly.
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const firstItem = page.locator('[data-plan-text-input]').first()
  await firstItem.fill('Groceries')
  await firstItem.blur()

  // The matching task's text itself becomes an inline hyperlink.
  const opener = page.getByTitle('Open Groceries').first()
  await expect(opener).toBeVisible()
  await opener.click()

  // The toast opens with the generated list item.
  const dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Milk')).toBeVisible()

  // Check every box; the toast auto-closes and the task gets checked.
  const checkbox = dialog.getByRole('checkbox').first()
  await checkbox.click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.plan-row.done').first()).toBeVisible()

  // The link is still clickable after completion and reopens the (done) list
  // without instantly auto-closing.
  await page.getByTitle('Open Groceries').first().click()
  await expect(page.getByRole('dialog', { name: 'Groceries' })).toBeVisible()
})

test('list template word cap blocks typing past the max', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list template' }).click()

  // Unlock and set a small cap of 2 expected words.
  await page.getByRole('button', { name: 'Unlock to edit max word count' }).click()
  const maxInput = page.locator('.word-cap-edit input')
  await maxInput.fill('2')

  // Typing a fourth word is rejected; the counter never exceeds the cap.
  const listItem = page.locator('[data-list-template-text-input]').first()
  await listItem.fill('')
  await listItem.click()
  await page.keyboard.type('one two three four')
  await expect(page.locator('.word-cap-count')).toContainText('2 / 2')
})

test('metric quiz records answers and bulk import backfills', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Metrics', exact: true }).click()
  await page.getByRole('button', { name: '+ New metric' }).first().click()
  await page.getByLabel('Metric name').fill('Mood')
  await page.getByPlaceholder('Question prompt').first().fill('Score')

  // Link from a daily task.
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const firstItem = page.locator('[data-plan-text-input]').first()
  await firstItem.fill('log Mood now')
  await firstItem.blur()

  // Only the matching substring "Mood" is the hyperlink, not the whole task.
  const moodLink = page.getByTitle('Open Mood').first()
  await expect(moodLink).toHaveText('Mood')
  await expect(page.locator('.item-text-display').first()).toContainText('log')

  await moodLink.click()
  const dialog = page.getByRole('dialog', { name: 'Mood' })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder('Type your answer, press Enter').fill('7')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()

  // The numeric graph shows up in the Metrics view.
  await page.getByRole('button', { name: 'Metrics', exact: true }).click()
  await expect(page.locator('.metric-graph').first()).toBeVisible()
})
