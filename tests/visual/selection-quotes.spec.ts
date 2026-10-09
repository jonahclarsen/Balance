import { expect, test, type Locator } from '@playwright/test'
import { generateDay, openView } from '../helpers/navigation'

async function selectText(input: Locator, start: number, end: number) {
  await input.evaluate((element, [a, b]) => {
    const editable = element.closest<HTMLElement>('[contenteditable="true"]') ?? element as HTMLElement
    editable.focus()
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
    const point = (offset: number): [Node, number] => {
      for (const node of nodes) {
        if (offset <= node.length) return [node, offset]
        offset -= node.length
      }
      throw new Error('Selection offset outside text')
    }
    document.getSelection()!.setBaseAndExtent(...point(a), ...point(b))
  }, [start, end])
}

for (const view of ['Today', 'Days', 'Lists']) {
  test(`${view} surrounds selected task text with quotes`, async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    if (view === 'Lists') {
      await openView(page, 'Lists')
      await page.getByRole('button', { name: '+ New list' }).click()
    } else {
      if (view === 'Today') await generateDay(page)
      await openView(page, view)
    }
    const selector = view === 'Lists' ? '[data-list-template-text-input]'
      : view === 'Days' ? '[data-template-option-text-input]' : '[data-plan-text-input]'
    const input = page.locator(selector).first()
    await input.fill('before selected after')
    await selectText(input, 7, 15)
    await page.keyboard.press('"')
    await expect(input).toHaveText('before "selected" after')
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('selected')
    await page.keyboard.press("'")
    await expect(input).toHaveText(`before "'selected'" after`)
    await input.blur()
    await page.reload()
    await openView(page, view)
    await expect(input).toHaveText(`before "'selected'" after`)
  })
}

test('Notes wraps formatted selections and supports undo', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    const item = (id: string, html: string, text: string) => ({ id, kind: 'paragraph', html, text, done: false, startMinutes: null, endMinutes: null, children: [] })
    state.notes = [{ id: 'quotes-note', title: 'Quote wrapping', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
      items: [item('quotes-one', 'before <strong>selected</strong> after', 'before selected after'), item('quotes-two', 'second paragraph', 'second paragraph')] }]
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  await openView(page, 'Notes')
  const input = page.locator('[data-item-id="quotes-one"]').first()
  await selectText(input, 7, 15)
  await page.keyboard.press('"')
  await expect(input).toHaveText('before "selected" after')
  await expect(input.locator('strong, b')).toHaveText(/selected/)
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('selected')
  await page.keyboard.press('Control+z')
  await expect(input).toHaveText('before selected after')
  await selectText(input, 15, 7)
  await page.keyboard.press("'")
  await expect(input).toHaveText("before 'selected' after")
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('selected')
  await page.keyboard.press('Control+z')
  await expect(input).toHaveText('before selected after')
  const second = page.locator('[data-item-id="quotes-two"]').first()
  await selectText(second, 6, 6)
  await selectText(input, 7, 7)
  await page.evaluate(() => {
    const first = document.querySelector('[data-item-id="quotes-one"]')!
    const second = document.querySelector('[data-item-id="quotes-two"]')!
    const range = document.createRange()
    range.setStart(first.querySelector('strong, b')!.firstChild!, 0)
    const walker = document.createTreeWalker(second, NodeFilter.SHOW_TEXT)
    range.setEnd(walker.nextNode()!, 6)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.keyboard.press('"')
  await expect(input).toHaveText('before "selected after')
  await expect(second).toHaveText('second" paragraph')
  await page.keyboard.press('Control+z')
  await expect(input).toHaveText('before selected after')
  await expect(second).toHaveText('second paragraph')
  await selectText(input, 7, 15)
  await page.keyboard.press("'")
  await selectText(input, 23, 23)
  await page.keyboard.press("'")
  await expect(input).toHaveText("before 'selected' after'")
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    return state.notes[0].items[0].text
  })).toBe(await input.textContent())
  await page.reload()
  await openView(page, 'Notes')
  await expect(input).toContainText("'selected")
})
