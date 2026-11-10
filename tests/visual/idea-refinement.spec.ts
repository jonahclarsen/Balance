import { expect, test, type Page } from '@playwright/test'
import { openView } from '../helpers/navigation'

test.use({ timezoneId: 'America/Vancouver', reducedMotion: 'no-preference' })
const dialog = (page: Page) => page.locator('.idea-sort[role="dialog"]')
const effect = (page: Page) => page.locator('.refinement')

async function seed(page: Page, count = 2) {
  await page.clock.install({ time: new Date('2026-10-08T18:00:00Z') })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await page.evaluate(async (length) => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    for (let i = 1; i <= length; i++) plannerStore.addIdea(`Synthetic idea ${i}`)
  }, count)
  await openView(page, 'Ideas')
  await page.locator('.ideas-panel').getByRole('button', { name: 'Sort', exact: true }).click()
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000))
}

async function bucketTexts(page: Page, kind: string) {
  return page.evaluate(async (destination) => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let state: any
    plannerStore.subscribe((value: any) => { state = value })()
    return state.ideaBuckets.find((group: any) => group.kind === destination)?.items.map((item: any) => item.text) ?? []
  }, kind)
}

test('refining commits immediately, refuses locked choices, and Back cancels it without duplicating an idea', async ({ page }) => {
  await seed(page)
  await dialog(page).getByRole('button', { name: 'Yes (Y)', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Genuinely Worth Doing (G)', exact: true }).click({ force: true })
  await expect(effect(page)).toHaveCount(0)
  await page.clock.fastForward(3000)
  await dialog(page).getByRole('button', { name: 'Genuinely Worth Doing (G)', exact: true }).click()
  await expect(effect(page)).toHaveAttribute('data-destination', 'genuine')
  const bounds = await effect(page).boundingBox()
  const viewport = page.viewportSize()!
  expect(bounds).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height })
  expect(await bucketTexts(page, 'genuine')).toEqual(['Synthetic idea 1'])
  // The flourish cannot accidentally accept a second pointer decision.
  await expect(dialog(page).locator('.paste-review')).toHaveAttribute('inert', '')
  // Back is intentional, immediate, and still owns the real operation undo.
  await page.keyboard.press('b')
  await expect(effect(page)).toHaveCount(0)
  expect(await bucketTexts(page, 'genuine')).toEqual([])
  await expect(dialog(page).locator('.idea-sort-card')).toContainText('Synthetic idea 1')
})

test('the final idea finishes after refining, with only one saved decision', async ({ page }) => {
  await seed(page, 1)
  await dialog(page).getByRole('button', { name: 'No (N)', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Trash (T)', exact: true }).click()
  await expect(effect(page)).toHaveAttribute('data-destination', 'trash')
  await page.keyboard.press('t')
  await page.clock.runFor(1400)
  await expect(dialog(page)).toHaveCount(0)
  expect(await bucketTexts(page, 'trash')).toEqual(['Synthetic idea 1'])
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  expect(await bucketTexts(page, 'trash')).toEqual(['Synthetic idea 1'])
})

test('closing during refining keeps the saved decision and cancels its delayed finish', async ({ page }) => {
  await seed(page)
  await dialog(page).getByRole('button', { name: 'No (N)', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Trash (T)', exact: true }).click()
  await expect(effect(page)).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await page.clock.runFor(1400)
  expect(await bucketTexts(page, 'trash')).toEqual(['Synthetic idea 1'])
  expect(await bucketTexts(page, 'proposition')).toEqual(['Synthetic idea 2'])
})

test('Back during the last flourish restores the idea and cancels completion', async ({ page }) => {
  await seed(page, 1)
  await dialog(page).getByRole('button', { name: 'No (N)', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Trash (T)', exact: true }).click()
  await expect(effect(page)).toHaveCount(1)
  await page.keyboard.press('b')
  await page.clock.runFor(1400)
  await expect(dialog(page)).toBeVisible()
  await expect(effect(page)).toHaveCount(0)
  expect(await bucketTexts(page, 'trash')).toEqual([])
  expect(await bucketTexts(page, 'proposition')).toEqual(['Synthetic idea 1'])
})

test('reduced motion sorts immediately without the terminal or delayed completion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await seed(page, 1)
  await dialog(page).getByRole('button', { name: 'No (N)', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Trash (T)', exact: true }).click()
  await expect(effect(page)).toHaveCount(0)
  await expect(dialog(page)).toHaveCount(0)
  expect(await bucketTexts(page, 'trash')).toEqual(['Synthetic idea 1'])
})
