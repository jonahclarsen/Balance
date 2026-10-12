import { openView } from '../helpers/navigation'
import { expect, test, type Page } from '@playwright/test'

function storedNotes(page: Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return (state.notes ?? []) as Array<{ id: string, title: string, versionOf?: string, versionName?: string, deletedAt?: string | null, items: Array<{ id: string, text: string }> }>
  })
}

test('note versions sit side by side as tabs with their own text and a shared title', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openView(page, 'Notes')
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Launch script')
  await page.locator('.note-text').first().fill('Cold open draft')

  const tabs = page.getByRole('tablist', { name: 'Versions' })
  await expect(tabs).toHaveCount(0)
  await page.getByRole('button', { name: 'New version', exact: true }).first().click()

  await expect(tabs.getByRole('tab')).toHaveText(['V1', 'V2'])
  await expect(tabs.getByRole('tab', { name: 'V2' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.note-text').first()).toHaveText('Cold open draft')
  await page.locator('.note-text').first().fill('Second take')

  await tabs.getByRole('tab', { name: 'V1' }).click()
  await expect(page.locator('.note-text').first()).toHaveText('Cold open draft')
  await tabs.getByRole('tab', { name: 'V1' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: 'V2' })).toBeFocused()
  await expect(page.locator('.note-text').first()).toHaveText('Second take')

  // One sidebar card stands for the whole note.
  await expect(page.locator('.note-card')).toHaveCount(1)
  await expect(page.locator('.note-card')).toContainText('2 versions')

  await page.getByLabel('Note title').fill('Launch video script')
  await tabs.getByRole('tab', { name: 'V2' }).dblclick()
  await page.getByLabel('Version name').fill('Punchier')
  await page.keyboard.press('Enter')
  await expect(tabs.getByRole('tab')).toHaveText(['V1', 'Punchier'])

  await expect.poll(async () => (await storedNotes(page)).map((note) => ({
    title: note.title,
    versionName: note.versionName ?? '',
    text: note.items[0]?.text,
    linked: Boolean(note.versionOf),
  })).sort((a, b) => Number(a.linked) - Number(b.linked))).toEqual([
    { title: 'Launch video script', versionName: '', text: 'Cold open draft', linked: false },
    { title: 'Launch video script', versionName: 'Punchier', text: 'Second take', linked: true },
  ])
  const notes = await storedNotes(page)
  const [first, second] = [notes.find((note) => !note.versionOf)!, notes.find((note) => note.versionOf)!]
  expect(second.versionOf).toBe(first.id)
  expect(second.items[0].id).not.toBe(first.items[0].id)

  await page.reload()
  await openView(page, 'Notes')
  await expect(page.getByRole('tablist', { name: 'Versions' }).getByRole('tab')).toHaveText(['V1', 'Punchier'])
})

test('binning one version keeps the rest, and Bin it takes every version', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openView(page, 'Notes')
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Pitch')
  const newVersion = page.getByRole('button', { name: 'New version', exact: true }).first()
  await newVersion.click()
  await newVersion.click()

  const tabs = page.getByRole('tablist', { name: 'Versions' })
  await expect(tabs.getByRole('tab')).toHaveText(['V1', 'V2', 'V3'])
  await tabs.getByRole('tab', { name: 'V2' }).click()
  await page.getByRole('button', { name: 'Bin V2' }).click()
  await expect(tabs.getByRole('tab')).toHaveText(['V1', 'V2'])
  await expect(tabs.getByRole('tab', { name: 'V2' })).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('ControlOrMeta+z')
  await expect(tabs.getByRole('tab')).toHaveText(['V1', 'V2', 'V3'])

  await page.getByRole('button', { name: 'Bin it' }).click()
  await expect(page.getByRole('heading', { name: 'Your notes live here' })).toBeVisible()
  await expect.poll(async () => (await storedNotes(page)).filter((note) => !note.deletedAt).length).toBe(0)
})
