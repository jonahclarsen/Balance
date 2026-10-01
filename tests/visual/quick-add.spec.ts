import { expect, test } from '@playwright/test'

test('mobile header quick add saves with Enter or Save and closes with Cancel or the backdrop', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'The quick-add button is mobile-only')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Close navigation' }).click()

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
