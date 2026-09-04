import { expect, test, type Locator, type Page } from '@playwright/test'

const auditExpect = expect.configure({ timeout: 750 })

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The paragraph-editing audit runs in the desktop editor')
})

async function openFreshNote(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
}

async function placeCaret(editor: Locator, offset: number) {
  await editor.evaluate((element, caretOffset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let remaining = caretOffset
    let node = walker.nextNode()
    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        element.focus()
        const range = document.createRange()
        range.setStart(node, remaining)
        range.collapse(true)
        const selection = document.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return
      }
      remaining -= length
      node = walker.nextNode()
    }
  }, offset)
}

async function selectText(editor: Locator, start: number, end: number) {
  await editor.evaluate((element, offsets) => {
    const node = element.firstChild
    if (!node) return
    element.focus()
    const range = document.createRange()
    range.setStart(node, offsets.start)
    range.setEnd(node, offsets.end)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, { start, end })
}

async function caretCoordinates(editor: Locator, offset: number) {
  return editor.evaluate((element, caretOffset) => {
    const node = element.firstChild
    if (!node) throw new Error('Editor has no text node')
    const range = document.createRange()
    range.setStart(node, caretOffset)
    range.collapse(true)
    const bounds = range.getBoundingClientRect()
    return { x: bounds.x, y: bounds.y + bounds.height / 2 }
  }, offset)
}

async function paste(editor: Locator, plainText: string, html = '') {
  await editor.evaluate((element, clipboard) => {
    element.focus()
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', clipboard.plainText)
    if (clipboard.html) clipboardData.setData('text/html', clipboard.html)
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }))
  }, { plainText, html })
}

async function caretState(page: Page) {
  return page.evaluate(() => {
    const selection = document.getSelection()
    if (!selection?.isCollapsed || !selection.focusNode) return null
    const element = selection.focusNode instanceof Element ? selection.focusNode : selection.focusNode.parentElement
    const editor = element?.closest<HTMLElement>('[data-note-text-input]')
    if (!editor) return null
    const before = document.createRange()
    before.selectNodeContents(editor)
    before.setEnd(selection.focusNode, selection.focusOffset)
    return {
      index: Array.from(document.querySelectorAll('[data-note-text-input]')).indexOf(editor),
      offset: before.toString().length,
    }
  })
}

test('Enter in the middle of a paragraph splits it and moves the caret to the new block', async ({ page }) => {
  await openFreshNote(page)
  const first = page.locator('[data-note-text-input]').first()
  await first.fill('AlphaBeta')
  await placeCaret(first, 5)
  await first.press('Enter')

  await expect(page.locator('[data-note-text-input]')).toHaveText(['Alpha', 'Beta'])
  await expect.poll(() => caretState(page)).toEqual({ index: 1, offset: 0 })
})

test('Enter replaces selected paragraph text with a block boundary', async ({ page }) => {
  await openFreshNote(page)
  const first = page.locator('[data-note-text-input]').first()
  await first.fill('AlphaBeta')
  await selectText(first, 3, 7)
  await first.press('Enter')

  await expect(page.locator('[data-note-text-input]')).toHaveText(['Alp', 'ta'])
  await expect.poll(() => caretState(page)).toEqual({ index: 1, offset: 0 })
})

test('Shift+Enter inserts a soft line break without creating another paragraph', async ({ page }) => {
  await openFreshNote(page)
  const editor = page.locator('[data-note-text-input]').first()
  await editor.fill('AlphaBeta')
  await placeCaret(editor, 5)
  await editor.press('Shift+Enter')

  await expect(page.locator('[data-note-text-input]')).toHaveCount(1)
  await expect(editor).toHaveText('Alpha\nBeta')
})

test('Backspace at the start of a paragraph merges it into the previous paragraph', async ({ page }) => {
  await openFreshNote(page)
  const first = page.locator('[data-note-text-input]').first()
  await first.fill('Alpha')
  await placeCaret(first, 5)
  await first.press('Enter')
  const second = page.locator('[data-note-text-input]').nth(1)
  await second.fill('Beta')
  await placeCaret(second, 0)
  await second.press('Backspace')

  await expect(page.locator('[data-note-text-input]')).toHaveText(['AlphaBeta'])
  await expect.poll(() => caretState(page)).toEqual({ index: 0, offset: 5 })
})

test('Delete at the end of a paragraph merges the following paragraph', async ({ page }) => {
  await openFreshNote(page)
  const first = page.locator('[data-note-text-input]').first()
  await first.fill('Alpha')
  await placeCaret(first, 5)
  await first.press('Enter')
  await page.locator('[data-note-text-input]').nth(1).fill('Beta')
  await placeCaret(first, 5)
  await first.press('Delete')

  await auditExpect(page.locator('[data-note-text-input]')).toHaveText(['AlphaBeta'])
  await expect.poll(() => caretState(page)).toEqual({ index: 0, offset: 5 })
})

test('Meta+Backspace deletes to the start of the paragraph without removing the block', async ({ page }) => {
  await openFreshNote(page)
  const first = page.locator('[data-note-text-input]').first()
  await first.fill('Previous')
  await placeCaret(first, 8)
  await first.press('Enter')
  const second = page.locator('[data-note-text-input]').nth(1)
  await second.fill('Alpha Beta')
  await placeCaret(second, 10)
  await second.press('Meta+Backspace')

  await auditExpect(page.locator('[data-note-text-input]')).toHaveText(['Previous', ''])
  await expect.poll(() => caretState(page)).toEqual({ index: 1, offset: 0 })
})

test('deleting a selection across two paragraphs merges the remaining text', async ({ page }) => {
  await openFreshNote(page)
  const first = page.locator('[data-note-text-input]').first()
  await first.fill('Alpha')
  await placeCaret(first, 5)
  await first.press('Enter')
  const second = page.locator('[data-note-text-input]').nth(1)
  await second.fill('Beta')
  const start = await caretCoordinates(first, 2)
  const end = await caretCoordinates(second, 2)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.press('Backspace')

  await auditExpect(page.locator('[data-note-text-input]')).toHaveText(['Alta'])
  await expect.poll(() => caretState(page)).toEqual({ index: 0, offset: 2 })
})

test('pasting plain text lines creates separate paragraphs', async ({ page }) => {
  await openFreshNote(page)
  const editor = page.locator('[data-note-text-input]').first()
  await paste(editor, 'Alpha\nBeta')

  await auditExpect(page.locator('[data-note-text-input]')).toHaveText(['Alpha', 'Beta'])
})

test('pasting paragraph HTML creates separate paragraphs', async ({ page }) => {
  test.fail(true, 'Audit: paragraph HTML is flattened into one block')
  await openFreshNote(page)
  const editor = page.locator('[data-note-text-input]').first()
  await paste(editor, 'Alpha\nBeta', '<p>Alpha</p><p>Beta</p>')

  await auditExpect(page.locator('[data-note-text-input]')).toHaveText(['Alpha', 'Beta'])
})

test('pasting bulleted-list HTML creates separate bulleted blocks', async ({ page }) => {
  test.fail(true, 'Audit: non-checklist list HTML is flattened into one block')
  await openFreshNote(page)
  const editor = page.locator('[data-note-text-input]').first()
  await paste(editor, '- Alpha\n- Beta', '<ul><li>Alpha</li><li>Beta</li></ul>')

  await auditExpect(page.locator('.note-item')).toHaveCount(2)
  await expect(page.locator('.note-item').nth(0)).toHaveClass(/note-bullet/)
  await expect(page.locator('.note-item').nth(1)).toHaveClass(/note-bullet/)
  await expect(page.locator('[data-note-text-input]')).toHaveText(['Alpha', 'Beta'])
})

test('Shift+Tab removes a top-level bulleted-list marker and keeps its text', async ({ page }) => {
  await openFreshNote(page)
  const toolbar = page.getByRole('toolbar', { name: 'Note formatting' })
  await toolbar.getByRole('button', { name: 'Bulleted list' }).click()
  const item = page.locator('.note-item').first()
  const editor = item.locator('[data-note-text-input]')
  await editor.fill('Alpha')
  await editor.press('Shift+Tab')

  await auditExpect(item).not.toHaveClass(/note-list-item/)
  await expect(editor).toHaveText('Alpha')
})

test('Shift+Tab removes a top-level numbered-list marker and keeps its text', async ({ page }) => {
  await openFreshNote(page)
  const toolbar = page.getByRole('toolbar', { name: 'Note formatting' })
  await toolbar.getByRole('button', { name: 'Numbered list' }).click()
  const item = page.locator('.note-item').first()
  const editor = item.locator('[data-note-text-input]')
  await editor.fill('Alpha')
  await editor.press('Shift+Tab')

  await auditExpect(item).not.toHaveClass(/note-list-item/)
  await expect(editor).toHaveText('Alpha')
})

test('cutting selected checklist blocks removes them and writes their structured text', async ({ page }) => {
  test.fail(true, 'Audit: note block selection has copy handling but no matching cut handling')
  await openFreshNote(page)
  const toolbar = page.getByRole('toolbar', { name: 'Note formatting' })
  await toolbar.getByRole('button', { name: 'Checklist' }).click()
  const first = page.locator('[data-note-text-input]').first()
  await first.fill('Alpha')
  await placeCaret(first, 5)
  await first.press('Enter')
  const second = page.locator('[data-note-text-input]').nth(1)
  await second.fill('Beta')
  await second.press('Meta+A')
  await second.press('Meta+A')

  const cut = await second.evaluate((element) => {
    const clipboardData = new DataTransfer()
    const allowed = element.dispatchEvent(new ClipboardEvent('cut', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }))
    return {
      handled: !allowed,
      plainText: clipboardData.getData('text/plain'),
    }
  })
  expect(cut).toEqual({ handled: true, plainText: '☐ Alpha\n☐ Beta' })
  await expect(page.locator('.note-item')).toHaveCount(0)
})

test('inline formatting survives splitting a paragraph', async ({ page }) => {
  await openFreshNote(page)
  const editor = page.locator('[data-note-text-input]').first()
  await editor.fill('Alpha')
  await editor.press('Meta+A')
  await page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Bold' }).click()
  await placeCaret(editor, 2)
  await editor.press('Enter')

  const editors = page.locator('[data-note-text-input]')
  await expect(editors).toHaveText(['Al', 'pha'])
  await expect(editors.nth(0).locator('b, strong')).toHaveText('Al')
  await expect(editors.nth(1).locator('b, strong')).toHaveText('pha')
})

test('undo restores a paragraph after splitting it', async ({ page }) => {
  await openFreshNote(page)
  const editor = page.locator('[data-note-text-input]').first()
  await editor.fill('AlphaBeta')
  await placeCaret(editor, 5)
  await editor.press('Enter')
  await expect(page.locator('[data-note-text-input]')).toHaveText(['Alpha', 'Beta'])
  await page.keyboard.press('Meta+z')

  await expect(page.locator('[data-note-text-input]')).toHaveText(['AlphaBeta'])
})
