import { expect, test } from '@playwright/test'

test('undo opens the sidebar page that owns the restored change', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard undo navigation is covered by the desktop project')

  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const planItem = page.locator('[data-plan-text-input]').first()
  await planItem.fill('Restored on Today')
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.operations?.at(-1)?.type
  })).toBe('patch_plan_item')
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Notes', exact: true }).first()).toBeVisible()

  await dispatchUndo(page)

  await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveClass(/active/)
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await expect(page.locator('[data-plan-text-input]').first()).toHaveText('Wake up')

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.getByLabel('List name').fill('Undo destination')
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.operations?.at(-1)?.type
  })).toBe('rename_list_template')
  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Goals', exact: true })).toBeVisible()

  await dispatchUndo(page)

  await expect(page.getByRole('button', { name: 'Lists', exact: true })).toHaveClass(/active/)
  await expect(page.getByRole('heading', { name: 'Lists', exact: true })).toBeVisible()
  await expect(page.getByLabel('List name')).toHaveValue('New list')
})

async function dispatchUndo(page: import('@playwright/test').Page) {
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'z',
    code: 'KeyZ',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })))
}
