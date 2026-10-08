import { expect, test } from '@playwright/test'
import { openView } from '../helpers/navigation'

test('multiple tasks round-trip through plain text with hierarchy and links', async ({ page }) => {
  await page.goto('/')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => {
    const item = (id: string, text: string, html = text, children: unknown[] = []) => ({
      id, text, html, children, done: false, startMinutes: null, endMinutes: null,
    })
    const date = new Date().toISOString().slice(0, 10)
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1, deviceId: 'clipboard-test', localSequence: 0, historyRevision: 0,
      activePlanDate: date, templates: [], goals: [], goalCompletions: [], operations: [],
      plans: [{ id: 'clipboard-plan', date, dailyReminder: '', items: [
        item('parent', 'Parent', 'Parent', [item('child', 'Read docs', 'Read <a href="https://example.com/docs">docs</a>')]),
        item('sibling', 'Sibling'),
      ] }],
    }))
  })
  await page.reload()
  await page.locator('[data-plan-text-input]').first().focus()
  await page.keyboard.press('Meta+Shift+ArrowDown')
  await page.keyboard.press('Meta+Shift+ArrowDown')
  await page.keyboard.press('Meta+C')
  const expected = '<balance>\n- Parent\n  - Read [docs](https://example.com/docs)\n- Sibling\n</balance>'
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected)

  // Reload discards Balance's in-memory structured clipboard; only text survives.
  await page.reload()
  await page.locator('[data-plan-text-input]').last().focus()
  await page.keyboard.press('End')
  await page.keyboard.press('Meta+V')
  await expect(page.locator('[data-plan-text-input]')).toHaveCount(6)
  await expect(page.locator('[data-plan-text-input] a[href="https://example.com/docs"]')).toHaveCount(2)
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    return state.plans[0].items.map((item: any) => ({ text: item.text, children: item.children.map((child: any) => child.text) }))
  })).toEqual([
    { text: 'Parent', children: ['Read docs'] }, { text: 'Sibling', children: [] },
    { text: 'Parent', children: ['Read docs'] }, { text: 'Sibling', children: [] },
  ])
  await page.keyboard.press('Meta+Z')
  await expect(page.locator('[data-plan-text-input]')).toHaveCount(3)
})

test('marked text handles tabs, escaped content, blank tasks and unsafe links', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    // @ts-expect-error Loaded by the test Vite server.
    const { parsePlainTaskClipboard, planItemsClipboardText } = await import('/src/lib/taskClipboard.ts')
    const parsed = parsePlainTaskClipboard('<balance>\r\n- Parent\r\n\t- Child\\nnext\\tpart\r\n- \\[literal](https://example.com) [unsafe](javascript:alert)\r\n- \r\n</balance>')
    const portable = planItemsClipboardText(parsed, true)
    return {
      parsed, portable, again: parsePlainTaskClipboard(portable), single: planItemsClipboardText([parsed[0]]),
      multiline: parsePlainTaskClipboard('<balance>\n- Alpha\n  beta\n\n  gamma\n\n- Delta\n</balance>'),
      ordinary: parsePlainTaskClipboard('Parent\n  Child'),
      partial: parsePlainTaskClipboard('<balance>\n- Task'),
    }
  })
  expect(result.parsed[0].children[0].html).toBe('Child<br>next\tpart')
  // Line breaks inside a task are written as real newlines, indented past the marker.
  expect(result.portable).toBe('<balance>\n- Parent\n  - Child\n    next\\tpart\n- \\[literal\\](https://example.com) unsafe\n- \n</balance>')
  expect(result.multiline.map((item: any) => item.html)).toEqual(['Alpha<br>beta<br><br>gamma', 'Delta'])
  expect(result.parsed[1].text).toBe('[literal](https://example.com) unsafe')
  expect(result.parsed[1].html).not.toContain('<a')
  expect(result.parsed[2].text).toBe('')
  expect(result.again.map((item: any) => item.text)).toEqual(result.parsed.map((item: any) => item.text))
  expect(result.single).toBe('Parent\n  Childnext\tpart')
  expect(result.ordinary).toBeNull()
  expect(result.partial).toBeNull()
})

test('a bulleted list copied from Notes pastes into a task with markers and line breaks', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'desktop keyboard paste')
  await page.goto('/')
  await page.evaluate(() => {
    const date = new Date().toISOString().slice(0, 10)
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1, deviceId: 'clipboard-test', localSequence: 0, historyRevision: 0,
      activePlanDate: date, templates: [], goals: [], goalCompletions: [], operations: [],
      plans: [{ id: 'clipboard-plan', date, dailyReminder: '', items: [
        { id: 'target', text: '', html: '', children: [], done: false, startMinutes: null, endMinutes: null },
      ] }],
    }))
  })
  await page.reload()
  await page.locator('[data-plan-text-input]').first().focus()
  await page.evaluate(() => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/html', '<ul><li>Alpha<ul><li>Nested <a href="https://example.com/docs">docs</a></li></ul></li><li>Beta\nsecond</li></ul><p>Closing</p>')
    clipboardData.setData('text/plain', '- Alpha\n  - Nested docs\n- Beta\n  second\nClosing')
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  })
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    return state.plans[0].items.map((item: any) => item.html)
  })).toEqual(['- Alpha<br>  - Nested <a href="https://example.com/docs" target="_blank" rel="noreferrer">docs</a><br>- Beta<br>second<br>Closing'])
})

test('tasks copied from Today paste as rows in list and day templates', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'desktop keyboard paste')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const copied = '<balance>\n- Parent\n  - Read [docs](https://example.com/docs)\n- Sibling\n</balance>'
  const shape = (items: any[], text: (item: any) => string): unknown =>
    items.map((item) => ({ text: text(item), children: shape(item.children, text) }))
  const expected = [
    { text: 'Parent', children: [{ text: 'Read docs', children: [] }] },
    { text: 'Sibling', children: [] },
  ]

  await page.getByRole('button', { name: 'Lists', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.locator('[data-list-template-text-input]').first().fill('')
  await page.evaluate((text) => navigator.clipboard.writeText(text), copied)
  await page.keyboard.press('Meta+V')
  await expect(page.locator('[data-list-template-text-input]')).toHaveCount(3)
  await expect(page.locator('[data-list-template-text-input] a[href="https://example.com/docs"]')).toHaveCount(1)
  await expect.poll(async () => shape(
    (await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!))).listTemplates.at(-1).items,
    (item) => item.text,
  )).toEqual(expected)

  await page.getByRole('button', { name: 'Days', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: 'New day', exact: true }).last().click()
  await page.locator('[data-template-option-text-input]').first().fill('')
  await page.evaluate((text) => navigator.clipboard.writeText(text), copied)
  await page.keyboard.press('Meta+V')
  await expect(page.locator('[data-template-option-text-input]')).toHaveCount(3)
  await expect.poll(async () => shape(
    (await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!))).templates.at(-1).items,
    (item) => item.options[0].text,
  )).toEqual(expected)
})

test('selected day and list template trees paste across template types with undo', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'desktop keyboard clipboard')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openView(page, 'Days')
  await page.getByRole('button', { name: 'New day', exact: true }).last().click()
  const dayInput = page.locator('[data-template-option-text-input]').first()
  await dayInput.fill('Copied day row')
  await dayInput.focus()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+C')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Copied day row')
  await openView(page, 'Lists')
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.locator('[data-list-template-text-input]').first().fill('')
  await page.keyboard.press('Meta+V')
  const listInput = page.locator('[data-list-template-text-input]').first()
  await expect(listInput).toHaveText('Copied day row')
  await page.keyboard.press('Meta+Z')
  await expect(listInput).toHaveText('First item')
  await listInput.fill('')
  await page.keyboard.press('Meta+V')
  await expect(listInput).toHaveText('Copied day row')
  await listInput.fill('Copied list row')
  await listInput.focus()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+C')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Copied list row')
  await openView(page, 'Days')
  await page.getByRole('button', { name: 'New day', exact: true }).last().click()
  await dayInput.fill('')
  await page.keyboard.press('Meta+V')
  await expect(dayInput).toHaveText('Copied list row')
})

test('day template rows keep their generation question when pasted into another day', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'desktop keyboard clipboard')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!))
  await openView(page, 'Days')
  await page.getByRole('button', { name: 'New day', exact: true }).last().click()
  const sourceInput = page.locator('[data-template-option-text-input]').first()
  await sourceInput.fill('No laptop until noon')
  await page.getByRole('button', { name: 'Ask a question when generating the day' }).first().click()
  await page.keyboard.type('Ban laptop this morning?')
  await page.getByRole('button', { name: 'Select item' }).filter({ visible: true }).first().click()
  await page.keyboard.press('Meta+C')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('No laptop until noon')

  await page.getByRole('button', { name: 'New day', exact: true }).last().click()
  await page.locator('[data-template-option-text-input]').first().fill('')
  await page.keyboard.press('Meta+V')
  await expect(page.locator('.question-input')).toHaveValue('Ban laptop this morning?')
  const pastedQuestion = async () => {
    const state = await saved()
    const pasted = state.templates.at(-1).items[0]
    return state.templateQuestions.find((record: any) => record.id === pasted.id)?.question ?? null
  }
  await expect.poll(pastedQuestion).toBe('Ban laptop this morning?')
  expect((await saved()).templates.at(-1).items[0].id).not.toBe((await saved()).templates.at(-2).items[0].id)

  await page.keyboard.press('Meta+Z')
  await expect(page.locator('.question-input')).toHaveCount(0)
})
