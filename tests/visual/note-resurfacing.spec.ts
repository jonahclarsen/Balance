import { expect, test, type Page } from '@playwright/test'
import { generateDay, openView } from '../helpers/navigation'

test.use({ timezoneId: 'America/Vancouver' })

// 11 a.m. in Vancouver, well clear of the 5 a.m. day boundary.
const NOW = new Date('2026-10-08T18:00:00Z')

function stored(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!))
}

test('a resurfacing note blocks day generation until it is read', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await openView(page, 'Notes')
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByRole('textbox', { name: 'Note title' }).fill('Remember why')
  const body = page.locator('.note-document [contenteditable="true"]').first()
  await body.click()
  await page.keyboard.type('Slow down.')
  await page.getByRole('button', { name: 'Resurface', exact: true }).click()
  await page.getByRole('group', { name: 'Resurface every' }).getByRole('button', { name: '≈2 wk' }).click()
  await expect(page.getByRole('button', { name: 'Resurface ≈2 wk' })).toBeVisible()
  await expect.poll(async () => (await stored(page)).noteResurfacing.map(({ days, last }: { days: number; last: string }) => ({ days, last })))
    .toEqual([{ days: 14, last: '2026-10-08' }])

  // Pretend it was set up three weeks ago, past the longest jittered wait.
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    state.noteResurfacing[0] = { ...state.noteResurfacing[0], last: '2026-09-17', next: '2026-10-01' }
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  await generateDay(page)
  const dialog = page.getByRole('dialog', { name: 'Remember why' })
  await expect(dialog).toContainText('Slow down.')
  await dialog.getByRole('button', { name: '≈1 mo' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  const [record] = (await stored(page)).noteResurfacing
  expect(record).toMatchObject({ days: 28, last: '2026-10-08' })
  expect(record.next >= '2026-10-31' && record.next <= '2026-11-09').toBe(true)
})
