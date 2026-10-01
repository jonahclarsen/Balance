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

test('copied day options retain checked and unchecked expansion choices independently of their source', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'desktop structured clipboard')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(async () => {
    // @ts-expect-error Served by Vite.
    const { plannerStore: store } = await import('/src/lib/store.ts')
    const id = store.addListTemplate()
    store.renameListTemplate(id, 'Synthetic routine')
  })
  await openView(page, 'Days')
  await page.getByRole('button', { name: 'New day', exact: true }).last().click()
  const editors = page.locator('[data-template-option-text-input]')
  await editors.first().fill('Synthetic routine')
  await editors.first().press('End')
  await editors.first().press('Enter')
  await editors.last().fill('Synthetic routine unchecked')
  const choices = page.getByRole('checkbox', { name: 'Expand Synthetic routine into tasks' })
  await expect(choices).toHaveCount(2)
  await choices.first().check()
  await editors.first().focus()
  await page.keyboard.press('End')
  await page.keyboard.press('Meta+Shift+ArrowDown')
  await page.keyboard.press('Meta+C')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('unchecked')
  // Changing the original after copying must not change the clipboard snapshot.
  await choices.first().uncheck()
  await page.getByRole('button', { name: 'New day', exact: true }).last().click()
  await editors.first().fill('')
  await page.keyboard.press('Meta+V')
  await expect(choices).toHaveCount(2)
  await expect(choices.first()).toBeChecked()
  await expect(choices.last()).not.toBeChecked()
  await page.keyboard.press('Meta+Z')
  await expect(choices).toHaveCount(0)
  await page.keyboard.press('Meta+Shift+Z')
  await expect(choices.first()).toBeChecked()
  await expect(choices.last()).not.toBeChecked()
  await page.reload()
  await openView(page, 'Days')
  await expect(choices.first()).toBeChecked()
})

test('expansion controls sit inside the editor immediately after short and wrapped text', async ({ page }) => {
  await page.evaluate(async () => {
    // @ts-expect-error Served by Vite.
    const { plannerStore: store } = await import('/src/lib/store.ts')
    const id = store.addListTemplate()
    store.renameListTemplate(id, 'Synthetic routine')
  })
  await openView(page, 'Days')
  const editor = page.locator('[data-template-option-text-input]').first()
  const checkbox = page.getByRole('checkbox', { name: 'Expand Synthetic routine into tasks' })
  for (const text of ['Synthetic routine', 'Synthetic routine ' + 'more synthetic text '.repeat(20)]) {
    await editor.fill(text)
    await expect(checkbox).toBeVisible()
    await expect.poll(() => editor.evaluate((node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      const end = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).at(-1)!
      const box = node.getBoundingClientRect()
      const control = node.parentElement!.querySelector('input[type="checkbox"]')!.getBoundingClientRect()
      return control.left >= end.right && control.left - end.right < 16 && control.right <= box.right &&
        control.top >= box.top && control.bottom <= box.bottom && control.top < end.bottom && control.bottom > end.top
    })).toBe(true)
  }
  await checkbox.check()
  await expect(editor).toHaveText('Synthetic routine ' + 'more synthetic text '.repeat(20))
})
