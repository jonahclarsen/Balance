import { expect, test, type Page } from '@playwright/test'

async function setup(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    const state = {
      totalRecords: 100, pendingRecords: 20, compressedRecords: 75, dictionaryRecords: 70,
      originalBytes: 102400, storedBytes: 20480, dictionaryBytes: 10240,
      dictionaryCount: 3, activeDictionaries: 2,
      lastCheckAtMs: 1700000000000, nextCheckAtMs: 1707776000000,
    }
    Object.assign(window, { isTauri: true, __listStats: state, __statsFailure: false, __statsReads: 0,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'get_list_storage_status') {
          (window as any).__statsReads++
          if ((window as any).__statsFailure) throw new Error('Synthetic measurement error')
          return { ...(window as any).__listStats }
        }
        if (command === 'list_recovery_entries' || command === 'list_metadata') return JSON.stringify({ entries: [] })
        if (command === 'inspect_database') return JSON.stringify({ operations: [], historyEntries: [], plans: [] })
        return null
      } },
    })
  })
  await page.keyboard.press('Control+Shift+P')
  const panel = page.getByRole('region', { name: 'Daily list compression' })
  await expect(panel).toBeVisible()
  return panel
}

test('recovery shows net payload savings, migration and retained dictionaries, then refreshes', async ({ page }) => {
  const panel = await setup(page)
  await expect(panel.getByRole('status')).toContainText('70.00 KiB saved (70.0% smaller)')
  await expect(panel).toContainText('80 / 100 lists checked · 20 remaining')
  await expect(panel).toContainText('75 / 100 · 70 using shared dictionaries')
  await expect(panel).toContainText('2 active · 1 retained')
  await expect(panel).toContainText('not total database-file savings')
  await page.evaluate(() => { (window as any).__listStats.pendingRecords = 0 })
  await page.getByRole('dialog', { name: 'Recovery history' }).getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(panel).toContainText('100 / 100 lists checked · complete')
  await expect(panel.getByText(/Keep Balance visible/)).toHaveCount(0)
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
})

test('empty, negative savings and failure states stay honest and can be retried', async ({ page }) => {
  const panel = await setup(page)
  await page.evaluate(() => { Object.assign((window as any).__listStats, { totalRecords: 0, pendingRecords: 0, compressedRecords: 0, dictionaryRecords: 0, originalBytes: 0, storedBytes: 0, dictionaryBytes: 0, dictionaryCount: 0, activeDictionaries: 0, lastCheckAtMs: null, nextCheckAtMs: null }) })
  await panel.getByRole('button').click()
  await expect(panel.getByRole('status')).toHaveText('No daily lists stored yet.')
  await page.evaluate(() => { Object.assign((window as any).__listStats, { totalRecords: 1, originalBytes: 100, storedBytes: 100, dictionaryBytes: 1024 }) })
  await panel.getByRole('button').click()
  await expect(panel.getByRole('status')).toContainText('1.00 KiB more than uncompressed')
  await page.evaluate(() => { (window as any).__statsFailure = true })
  await panel.getByRole('button').click()
  await expect(panel.getByRole('alert')).toContainText('Synthetic measurement error')
  await expect(panel.getByRole('status')).toHaveCount(0)
  await page.evaluate(() => { (window as any).__statsFailure = false })
  await panel.getByRole('button').click()
  await expect(panel.getByRole('status')).toBeVisible()
})

test('unfinished migration polls only while the recovery panel is open', async ({ page }) => {
  const panel = await setup(page)
  await expect(panel.getByRole('status')).toBeVisible()
  await page.clock.install()
  await page.evaluate(() => { (window as any).__listStats.pendingRecords = 0 })
  // Refresh starts the pending timer under the controlled clock.
  await page.evaluate(() => { (window as any).__listStats.pendingRecords = 20 })
  await panel.getByRole('button').click()
  await expect(panel.getByRole('button')).toBeEnabled()
  await page.evaluate(() => { (window as any).__listStats.pendingRecords = 0 })
  await page.clock.fastForward(15_000)
  await expect(panel).toContainText('100 / 100 lists checked · complete')
  await page.evaluate(() => { (window as any).__listStats.pendingRecords = 20 })
  await panel.getByRole('button').click()
  await expect(panel.getByRole('button')).toBeEnabled()
  await page.keyboard.press('Escape')
  const reads = await page.evaluate(() => (window as any).__statsReads)
  await page.clock.fastForward(30_000)
  expect(await page.evaluate(() => (window as any).__statsReads)).toBe(reads)
})
