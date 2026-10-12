import { expect, test } from '@playwright/test'
import { openView } from '../helpers/navigation'

type StoredItem = { text: string; probability: number; alternatives?: { text: string; probability: number }[] }

async function storedItem(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    const item = state.listTemplates[0].items[0]
    return {
      text: item.text,
      probability: item.probability,
      alternatives: item.alternatives?.map(({ text, probability }: { text: string; probability: number }) => ({ text, probability })),
    } as StoredItem
  })
}

test('a list item alternative splits its odds, persists, and undoes', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openView(page, 'Lists')
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.locator('[data-list-template-text-input]').first().fill('Tidy 5 min')

  await page.getByRole('button', { name: 'Add alternative' }).click()
  const alternative = page.getByRole('textbox', { name: 'List item alternative' })
  await expect(alternative).toBeFocused()
  await page.keyboard.type('Tidy 10 min')
  await expect.poll(() => storedItem(page)).toEqual({
    text: 'Tidy 5 min',
    probability: 50,
    alternatives: [{ text: 'Tidy 10 min', probability: 50 }],
  })

  await page.reload()
  await openView(page, 'Lists')
  await expect(page.getByRole('textbox', { name: 'List item alternative' })).toHaveText('Tidy 10 min')

  await page.getByRole('button', { name: 'Delete alternative' }).click()
  await expect(page.getByRole('textbox', { name: 'List item alternative' })).toHaveCount(0)
  await expect.poll(async () => (await storedItem(page)).alternatives).toBeUndefined()

  await page.keyboard.press('ControlOrMeta+Z')
  await expect(page.getByRole('textbox', { name: 'List item alternative' })).toHaveText('Tidy 10 min')
})
