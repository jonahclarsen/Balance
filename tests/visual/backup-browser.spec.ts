import { expect, test, type Page } from '@playwright/test'

async function setup(page: Page, mode: 'normal' | 'locked' | 'empty' = 'normal') {
  await page.goto('/')
  await page.evaluate((mode) => {
    const calls: { command: string; args?: Record<string, unknown> }[] = []
    const backups = [
      { filename: 'balance-daily-2-200.sqlite3', createdAtMs: Date.parse('2026-09-05T10:00:00Z'), bytes: 40960 },
      { filename: 'balance-daily-1-100.sqlite3', createdAtMs: Date.parse('2026-09-04T10:00:00Z'), bytes: 40960 },
    ]
    const item = (text: string) => ({ id: text, text, html: '<img src="https://invalid.example/backup-image" onerror="window.backupExecuted=true">', done: false, children: [] })
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args })
      if (command === 'list_database_backups') return mode === 'empty' ? [] : backups
      if (command === 'read_database_backup') {
        if (mode === 'locked' && args?.recoveryKey !== 'synthetic-old-key') throw new Error('This backup could not be unlocked. Enter its original recovery key.')
        return {
          plans: [{ id: 'plan', date: '2026-09-03', title: 'Synthetic saved day', dailyReminder: 'Remember', items: [item(args?.filename === backups[0].filename ? 'Newest saved task' : 'Recovered kumquat task')] }],
          notes: [{ id: 'note', title: 'Synthetic note', items: [item('Hidden orchid note')] }],
          templates: [], lists: [], listTemplates: [], metrics: [], metricEntries: [], goals: [],
        }
      }
      if (command === 'list_recovery_entries' || command === 'list_metadata') return JSON.stringify({ entries: [] })
      if (command === 'inspect_database') return JSON.stringify({ operations: [], historyEntries: [], plans: [] })
      return null
    }
    Object.assign(window, { isTauri: true, __backupCalls: calls, __TAURI_INTERNALS__: { invoke } })
  }, mode)
  await page.keyboard.press('Control+Shift+P')
  const dialog = page.getByRole('dialog', { name: 'Recovery history' })
  await expect(dialog).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__backupCalls.filter((call: any) => call.command.includes('database_backup')).length)).toBe(0)
  await dialog.getByText('Browse encrypted backups', { exact: true }).click()
  return dialog
}

test('browse, search and copy encrypted backup text without changing the workspace', async ({ page }, testInfo) => {
  const dialog = await setup(page)
  const browser = dialog.getByRole('region', { name: 'Encrypted backup browser' })
  const search = browser.getByRole('searchbox', { name: 'Search this backup' })
  await search.fill('newest')
  await expect(browser.getByLabel('Backup text')).toContainText('Newest saved task')
  await browser.getByRole('button', { name: 'Older', exact: true }).click()
  await search.fill('kumquat')
  await expect(browser.getByLabel('Backup text')).toContainText('Recovered kumquat task')
  await browser.getByRole('button', { name: 'Copy text', exact: true }).click()
  await expect(browser.getByRole('status')).toContainText('Copied to clipboard')
  await search.fill('orchid')
  await expect(browser.getByLabel('Backup text')).toContainText('Hidden orchid note')
  await expect(browser.locator('img')).toHaveCount(0)
  await browser.getByRole('combobox', { name: 'Content', exact: true }).selectOption('Plans')
  await expect(browser.getByText('No matching content in this backup.')).toBeVisible()
  await browser.getByRole('combobox', { name: 'Content', exact: true }).selectOption('')
  await search.fill('no such text')
  await expect(browser.getByText('No matching content in this backup.')).toBeVisible()
  await search.fill('newest')
  await browser.getByRole('button', { name: 'Newer', exact: true }).click()
  await expect(browser.getByLabel('Backup text')).toContainText('Newest saved task')
  await search.focus()
  await page.keyboard.press('Control+z')
  const calls = await page.evaluate(() => (window as any).__backupCalls)
  expect(calls.find((call: any) => call.command === 'write_balance_clipboard').args.plainText).toContain('Recovered kumquat task')
  expect(calls.filter((call: any) => /persist|undo_last|restore_/.test(call.command))).toEqual([])
  await search.fill('')
  await browser.getByRole('button', { name: /Synthetic saved day/ }).click()
  expect(await browser.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('backup-browser.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
})

test('old-key retry clears the password and does not reuse it for another backup', async ({ page }) => {
  const dialog = await setup(page, 'locked')
  await expect(dialog.getByRole('alert')).toContainText('could not be unlocked')
  const key = dialog.getByLabel('Original recovery key', { exact: true })
  await key.fill('synthetic-old-key')
  await dialog.getByRole('button', { name: 'Unlock backup' }).click()
  await dialog.getByRole('searchbox', { name: 'Search this backup' }).fill('newest')
  await expect(dialog.getByLabel('Backup text')).toContainText('Newest saved task')
  await expect(key).not.toBeVisible()
  await dialog.getByRole('button', { name: 'Older', exact: true }).click()
  await expect(key).toHaveValue('')
  await expect(dialog.getByLabel('Backup text')).not.toBeVisible()
})

test('empty backup directory explains when backups are created', async ({ page }) => {
  const dialog = await setup(page, 'empty')
  await expect(dialog.getByText(/No saved backups yet/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Older', exact: true })).toBeDisabled()
})
