import { expect, test } from '@playwright/test'
import { generateDay, openView } from '../helpers/navigation'

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-02T12:00:00'))
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('list expansion checkbox persists, supports undo and generates separate tasks in place', async ({ page }) => {
  await page.evaluate(async () => {
    // @ts-expect-error Served by Vite.
    const { plannerStore: store } = await import('/src/lib/store.ts')
    let state: any
    const unsubscribe = store.subscribe((value: any) => { state = value })
    const listId = store.addListTemplate()
    store.renameListTemplate(listId, 'Synthetic routine')
    const list = state.listTemplates.find((value: any) => value.id === listId)
    store.patchListTemplateItem(listId, list.items[0].id, { text: 'First synthetic task', html: '<b>First synthetic task</b>' })
    store.addRootListTemplateItem(listId)
    const second = state.listTemplates.find((value: any) => value.id === listId).items.at(-1).id
    store.patchListTemplateItem(listId, second, { text: 'Second synthetic task', html: 'Second synthetic task' })
    const day = state.templates[0]
    store.patchTemplateOption(day.id, day.items[0].id, day.items[0].options[0].id, { text: 'Synthetic routine', html: 'Synthetic routine' })
    unsubscribe()
  })
  await openView(page, 'Days')
  const expand = page.getByRole('checkbox', { name: 'Expand Synthetic routine into tasks' })
  await expect(expand).not.toBeChecked()
  await expand.check()
  await page.keyboard.press('Meta+Z')
  await expect(expand).not.toBeChecked()
  await expand.check()
  await page.reload()
  await openView(page, 'Days')
  await expect(expand).toBeChecked()
  await generateDay(page)
  const tasks = page.locator('[data-plan-text-input]')
  await expect(tasks.nth(0)).toHaveText('First synthetic task')
  await expect(tasks.nth(1)).toHaveText('Second synthetic task')
  await expect(tasks.filter({ hasText: 'Synthetic routine' })).toHaveCount(0)
})


test('new lists open with an empty name and focus ready for typing', async ({ page }) => {
  await openView(page, 'Lists')
  await page.getByRole('button', { name: '+ New list' }).click()
  const name = page.getByRole('textbox', { name: 'List name', exact: true })
  await expect(name).toHaveValue('')
  await expect(name).toBeFocused()
  await page.keyboard.type('Synthetic new list')
  await expect(name).toHaveValue('Synthetic new list')
})
