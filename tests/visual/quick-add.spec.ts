import { expect, test } from '@playwright/test'
import { openView } from '../helpers/navigation'

test('mobile header quick add saves ideas with Enter or Save and closes with Cancel or the backdrop', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'The header quick-add button is mobile-only')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()

  const addButton = page.getByRole('button', { name: 'Add idea', exact: true })
  const input = page.getByRole('textbox', { name: 'New idea' })
  const ideas = () => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    return state.ideaBuckets.flatMap((bucket: any) => bucket.items.map((item: any) => `${bucket.kind}:${item.text}`))
  })

  await addButton.click()
  await expect(input).toBeFocused()
  await input.fill('Synthetic enter idea')
  await input.press('Enter')
  await expect(input).toBeHidden()
  expect(await ideas()).toEqual(['proposition:Synthetic enter idea'])

  // The button is available on every page, not just Today.
  await openView(page, 'Notes')
  await addButton.click()
  await input.fill('Synthetic save idea')
  await page.screenshot({ path: info.outputPath('quick-add.png') })
  await page.getByRole('button', { name: 'Save' }).click()
  expect(await ideas()).toEqual(['proposition:Synthetic enter idea', 'proposition:Synthetic save idea'])

  await addButton.click()
  await input.fill('Synthetic cancelled idea')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(input).toBeHidden()

  await addButton.click()
  await input.fill('Synthetic dismissed idea')
  await page.mouse.click(8, 8)
  await expect(input).toBeHidden()
  expect(await ideas()).toHaveLength(2)

  await openView(page, 'Buckets')
  await expect(page.locator('.bucket-card[data-bucket="proposition"] [data-plan-text-input]')).toHaveText(['Synthetic enter idea', 'Synthetic save idea'])
})
