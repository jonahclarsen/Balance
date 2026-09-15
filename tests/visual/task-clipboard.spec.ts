import { expect, test } from '@playwright/test'

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
      parsed, again: parsePlainTaskClipboard(portable), single: planItemsClipboardText([parsed[0]]),
      ordinary: parsePlainTaskClipboard('Parent\n  Child'),
      partial: parsePlainTaskClipboard('<balance>\n- Task'),
    }
  })
  expect(result.parsed[0].children[0].html).toBe('Child<br>next\tpart')
  expect(result.parsed[1].text).toBe('[literal](https://example.com) unsafe')
  expect(result.parsed[1].html).not.toContain('<a')
  expect(result.parsed[2].text).toBe('')
  expect(result.again.map((item: any) => item.text)).toEqual(result.parsed.map((item: any) => item.text))
  expect(result.single).toBe('Parent\n  Childnext\tpart')
  expect(result.ordinary).toBeNull()
  expect(result.partial).toBeNull()
})
