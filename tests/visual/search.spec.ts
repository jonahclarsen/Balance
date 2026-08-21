import { expect, test } from '@playwright/test'

test('search finds saved days, list history, and editable lists without Enter', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await page.evaluate(() => {
    const key = 'balance.appState.v1'
    const state = JSON.parse(localStorage.getItem(key) || '{}')
    const now = new Date().toISOString()

    state.plans.push({
      id: 'search-day',
      date: '2025-01-02',
      title: 'Archived planning day',
      dailyReminder: 'Keep it searchable',
      generatedFromTemplateId: state.templates[0].id,
      createdAt: now,
      items: [{
        id: 'search-day-item',
        text: 'Review the obsidian notebook',
        html: 'Review the obsidian notebook',
        done: false,
        startMinutes: null,
        endMinutes: null,
        children: [],
      }],
    })

    state.listTemplates.push({
      id: 'search-list-template',
      name: 'Market errands',
      maxExpectedWords: 0,
      createdAt: now,
      updatedAt: now,
      items: [{
        id: 'search-list-template-item',
        text: 'Buy saffron',
        html: 'Buy saffron',
        probability: 100,
        children: [],
      }],
    })
    state.lists.push({
      id: 'search-list',
      date: '2025-01-03',
      listTemplateId: 'search-list-template',
      createdAt: now,
      items: [{
        id: 'search-list-item',
        text: 'Buy saffron',
        html: 'Buy saffron',
        done: false,
        startMinutes: null,
        endMinutes: null,
        children: [],
      }],
    })
    localStorage.setItem(key, JSON.stringify(state))
  })
  await page.reload()

  await page.getByRole('button', { name: /Search/ }).click()
  const search = page.getByRole('searchbox', { name: 'Search everything' })
  await search.fill('obsidian')
  await expect(page.getByRole('heading', { name: /Saved days/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Archived planning day/ })).toBeVisible()

  await page.getByRole('button', { name: /Archived planning day/ }).click()
  await expect(page.locator('.date-input')).toHaveValue('2025-01-02')
  await expect(page.getByText('Review the obsidian notebook')).toBeVisible()

  await page.getByRole('button', { name: /Search/ }).click()
  await page.getByRole('searchbox', { name: 'Search everything' }).fill('saffron')
  await expect(page.getByRole('heading', { name: /List History/ })).toBeVisible()
  await expect(page.locator('#search-group-list-template')).toContainText('Lists')

  await page.getByRole('searchbox', { name: 'Search everything' }).fill('wake up')
  await expect(page.getByRole('heading', { name: /Day templates/ })).toBeVisible()
})

test('search finds readable text in retained task history', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const entries = [{
      historyId: 'history-deleted-kumquat',
      operationId: 'delete-kumquat',
      operationType: 'delete_plan_item',
      sequence: 42,
      undone: false,
      createdAtMs: Date.parse('2026-08-19T18:30:00Z'),
      timestamp: '2026-08-19T18:30:00Z',
      restoredItemCount: 1,
      preview: 'Buy the secret kumquat',
      undoJson: JSON.stringify({
        type: 'insert_plan_item_at',
        payload: { item: { id: 'deleted-item', text: 'Buy the secret kumquat', children: [] } },
      }),
    }]
    const emptyInspection = JSON.stringify({ operations: [], historyEntries: [], plans: [] })
    const invoke = async (command: string) => {
      if (command === 'search_recovery_history') return JSON.stringify({
        entries: [{
          historyId: entries[0].historyId,
          operationType: entries[0].operationType,
          createdAtMs: entries[0].createdAtMs,
          timestamp: entries[0].timestamp,
          preview: entries[0].preview,
        }],
      })
      if (command === 'list_recovery_entries') return JSON.stringify({ entries })
      if (command === 'list_metadata') return JSON.stringify({ entries: [] })
      if (command === 'inspect_database') return emptyInspection
      if (command === 'get_database_maintenance_status') return null
      throw new Error(`Unexpected test command: ${command}`)
    }
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke } })
  })
  await page.getByRole('button', { name: /Search/ }).click()
  await page.getByRole('searchbox', { name: 'Search everything' }).fill('secret kumquat')

  await expect(page.getByRole('heading', { name: /Earlier versions & removed items/ })).toBeVisible()
  const historyResult = page.getByRole('button', { name: /Removed content/ })
  await expect(historyResult).toContainText('Buy the secret kumquat')

  await historyResult.click()
  await expect(page.getByRole('heading', { name: 'Recovery history' })).toBeVisible()
  await expect(page.locator('[data-recovery-history-id="history-deleted-kumquat"]')).toContainText('Buy the secret kumquat')
})
