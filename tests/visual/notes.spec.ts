import { expect, test, type Locator, type Page } from '@playwright/test'

async function placeCaretAtEnd(editor: Locator) {
  await editor.evaluate((element) => {
    const input = element as HTMLElement
    input.focus()
    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(false)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
}

async function placeCaretAtOffset(editor: Locator, offset: number) {
  await editor.evaluate((element, caretOffset) => {
    const input = element as HTMLElement
    const node = input.firstChild
    if (!node) return
    input.focus()
    const range = document.createRange()
    range.setStart(node, caretOffset)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, offset)
}

async function noteSelectionEndpoints(page: Page) {
  return page.evaluate(() => {
    const selection = document.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) return null
    const endpoint = (node: Node, offset: number) => {
      const element = node instanceof Element ? node : node.parentElement
      const input = element?.closest<HTMLElement>('[data-note-text-input]')
      if (!input) return null
      const before = document.createRange()
      before.selectNodeContents(input)
      before.setEnd(node, offset)
      return { text: input.textContent, offset: before.toString().length }
    }
    return {
      anchor: endpoint(selection.anchorNode, selection.anchorOffset),
      focus: endpoint(selection.focusNode, selection.focusOffset),
    }
  })
}

test('IMAX mode maximizes Notes and restores its surrounding panels', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'IMAX is desktop-only')
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }))
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  const imaxButton = page.getByRole('button', { name: 'Enter IMAX mode' })
  const goalRhythm = page.getByRole('region', { name: 'Goal history' })
  const sidebar = page.getByRole('complementary', { name: 'Primary navigation drawer' })

  await expect(imaxButton).toBeVisible()
  await expect(goalRhythm).toBeVisible()
  await expect(sidebar).toBeVisible()
  await imaxButton.click()

  const exitImaxButton = page.getByRole('button', { name: 'Exit IMAX mode' })
  await expect(exitImaxButton).toHaveAttribute('aria-pressed', 'true')
  await expect(goalRhythm).toBeHidden()
  await expect(sidebar).toBeHidden()

  await exitImaxButton.click()
  await expect(imaxButton).toHaveAttribute('aria-pressed', 'false')
  await expect(goalRhythm).toBeVisible()
  await expect(sidebar).toBeVisible()
})

test('shift arrow keys extend note selection to the matching position on an adjacent block', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const firstLine = page.locator('[data-note-text-input]').first()
  await firstLine.type('First line')
  await placeCaretAtEnd(firstLine)
  await firstLine.press('Enter')
  const secondLine = page.locator('[data-note-text-input]').nth(1)
  await secondLine.type('Second line')

  await placeCaretAtOffset(secondLine, 4)
  await secondLine.press('Shift+ArrowUp')
  await expect.poll(() => noteSelectionEndpoints(page)).toEqual({
    anchor: { text: 'Second line', offset: 4 },
    focus: { text: 'First line', offset: 4 },
  })

  await placeCaretAtOffset(firstLine, 4)
  await firstLine.press('Shift+ArrowDown')
  await expect.poll(() => noteSelectionEndpoints(page)).toEqual({
    anchor: { text: 'First line', offset: 4 },
    focus: { text: 'Second line', offset: 4 },
  })
})

test('notes support a seamless editor, natural formatting, persistence, search, and app links', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Project Brain')

  const firstBlock = page.locator('[data-note-text-input]').first()
  await firstBlock.fill('/hea')
  await expect(page.getByRole('listbox', { name: 'Note styles' })).toBeVisible()
  await firstBlock.press('Enter')
  await firstBlock.fill('Reference material')
  await expect(page.locator('.note-item').first()).toHaveClass(/note-heading/)

  await placeCaretAtEnd(firstBlock)
  await firstBlock.press('Enter')
  let noteBlocks = page.locator('[data-note-text-input]')
  await expect(noteBlocks).toHaveCount(2)
  const bodyBlock = noteBlocks.nth(1)
  await bodyBlock.fill('Formatted ideas feel like one document')
  await bodyBlock.press('Meta+A')
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? '')).toContain('Formatted ideas')
  await page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Bold' }).click()
  await expect(bodyBlock.locator('b, strong')).toContainText('Formatted ideas')

  await placeCaretAtEnd(bodyBlock)
  await bodyBlock.press('Enter')
  noteBlocks = page.locator('[data-note-text-input]')
  await expect(noteBlocks).toHaveCount(3)
  const checklistBlock = noteBlocks.nth(2)
  await checklistBlock.type('[] ')
  await checklistBlock.type('Ship the notes feature')
  await page.getByLabel('Mark checked').check()
  await expect(page.locator('.note-done')).toContainText('Ship the notes feature')

  await placeCaretAtEnd(checklistBlock)
  await checklistBlock.press('Enter')
  noteBlocks = page.locator('[data-note-text-input]')
  await expect(noteBlocks).toHaveCount(4)
  const emptyChecklist = page.locator('.note-item').filter({ has: page.getByLabel('Mark checked') })
  await expect(emptyChecklist).toHaveCount(1)
  const emptyChecklistId = await emptyChecklist.getAttribute('data-note-item-id')
  expect(emptyChecklistId).toBeTruthy()
  const emptyChecklistItem = page.locator(`[data-note-item-id="${emptyChecklistId}"]`)
  await emptyChecklistItem.locator('[data-note-text-input]').press('Enter')
  await expect(noteBlocks).toHaveCount(4)
  await expect(emptyChecklistItem).not.toHaveClass(/note-list-item/)
  await expect(page.locator('[data-note-text-input]').nth(1)).toContainText('Formatted ideas')

  await page.getByRole('button', { name: 'Copy note link' }).click()
  await expect(page.getByText('Link copied!')).toBeVisible()
  const noteLink = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return `balance://note/${state.notes[0].id}`
  })

  await page.getByRole('button', { name: 'Day Templates', exact: true }).click()
  const templateText = page.locator('[data-template-option-text-input]').first()
  await templateText.fill(`Open ${noteLink}`)
  await templateText.press('Meta+A')
  await templateText.press('Meta+B')
  await templateText.blur()
  const internalLink = page.getByTitle('Open Project Brain')
  await expect(internalLink).toBeVisible()
  await expect(templateText.locator('strong')).toContainText('Open')
  await internalLink.click()
  await expect(page.getByLabel('Note title')).toHaveValue('Project Brain')
  await expect(page.locator('[data-note-text-input]').nth(1)).toContainText('Formatted ideas')

  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByLabel('Note title')).toHaveValue('Project Brain')
  await expect(page.locator('[data-note-text-input]').nth(1)).toContainText('Formatted ideas')
  await expect(page.locator('.note-done')).toContainText('Ship the notes feature')
  if (testInfo.project.name === 'desktop') {
    await page.screenshot({ path: testInfo.outputPath('notes-desktop.png'), fullPage: true })
  }

  await page.getByRole('button', { name: /Search/ }).click()
  await page.getByRole('searchbox', { name: 'Search everything' }).fill('Formatted ideas')
  const searchDialog = page.getByRole('dialog', { name: 'Search Balance' })
  await expect(searchDialog.getByRole('heading', { name: /Notes/ })).toBeVisible()
  await searchDialog.getByRole('button', { name: /Project Brain/ }).click()
  await expect(page.getByLabel('Note title')).toHaveValue('Project Brain')
})

test('note inline formatting shortcuts and toolbar buttons are true toggles', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const editor = page.locator('[data-note-text-input]').first()
  const toolbar = page.getByRole('toolbar', { name: 'Note formatting' })
  const bold = toolbar.getByRole('button', { name: 'Bold' })
  const italic = toolbar.getByRole('button', { name: 'Italic' })
  const underline = toolbar.getByRole('button', { name: 'Underline' })
  await editor.fill('Toggle this text')
  await editor.press('Meta+A')

  await editor.press('Meta+I')
  const italicText = editor.locator('i, em')
  await expect(italicText).toHaveText('Toggle this text')
  await expect.poll(() => italicText.evaluate((element) => ({
    fontStyle: getComputedStyle(element).fontStyle,
    fontSynthesis: getComputedStyle(element).fontSynthesis,
  }))).toEqual({ fontStyle: 'italic', fontSynthesis: 'style' })
  await expect(italic).toHaveAttribute('aria-pressed', 'true')
  await editor.press('Meta+I')
  await expect(editor.locator('i, em')).toHaveCount(0)
  await expect(italic).toHaveAttribute('aria-pressed', 'false')

  await bold.click()
  await expect(editor.locator('b, strong')).toHaveText('Toggle this text')
  await expect(bold).toHaveAttribute('aria-pressed', 'true')
  await bold.click()
  await expect(editor.locator('b, strong')).toHaveCount(0)
  await expect(bold).toHaveAttribute('aria-pressed', 'false')
  await bold.click()
  await expect(editor.locator('b, strong')).toHaveCount(1)
  await expect(editor.locator('b b, b strong, strong b, strong strong')).toHaveCount(0)
  await expect(bold).toHaveAttribute('aria-pressed', 'true')

  await underline.click()
  await expect(editor.locator('u')).toHaveText('Toggle this text')
  await expect(underline).toHaveAttribute('aria-pressed', 'true')
})

test('note formatting toolbar stays visible while scrolling a long note', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const editor = page.locator('[data-note-text-input]').first()
  const workspace = page.locator('.workspace')
  const toolbar = page.getByRole('toolbar', { name: 'Note formatting' })
  await editor.fill(Array.from({ length: 80 }, (_, index) => `Long note line ${index + 1}`).join('\n'))
  await workspace.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))

  await expect.poll(async () => {
    const workspaceBox = await workspace.boundingBox()
    const toolbarBox = await toolbar.boundingBox()
    if (!workspaceBox || !toolbarBox) return false
    const top = toolbarBox.y - workspaceBox.y
    return toolbarBox.y + toolbarBox.height > workspaceBox.y
      && toolbarBox.y < workspaceBox.y + workspaceBox.height
      && top >= 8
      && top <= 48
  }).toBe(true)
})

test('notes layout remains usable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Pocket note')
  await page.locator('[data-note-text-input]').first().fill('Readable on a phone')

  const viewport = page.viewportSize()
  const documentBox = await page.locator('.note-document').boundingBox()
  expect(documentBox?.x).toBeGreaterThanOrEqual(0)
  expect((documentBox?.x ?? 0) + (documentBox?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0)
  await page.screenshot({ path: testInfo.outputPath('notes-mobile.png'), fullPage: true })
})

test('an empty note always has a place to start typing', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const onlyLine = page.locator('[data-note-text-input]')
  await onlyLine.fill('Temporary text')
  await placeCaretAtEnd(onlyLine)
  await onlyLine.press('Meta+Backspace')
  await expect(onlyLine).toHaveCount(1)
  await expect(onlyLine).toHaveText('')
  await expect(onlyLine).toBeFocused()

  await page.evaluate(() => {
    const key = 'balance.appState.v1'
    const state = JSON.parse(localStorage.getItem(key) || '{}')
    state.notes[0].items = []
    localStorage.setItem(key, JSON.stringify(state))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()

  const emptySurface = page.getByRole('button', { name: 'Start writing…' })
  await expect(emptySurface).toBeVisible()
  await emptySurface.click()
  await expect(page.locator('[data-note-text-input]')).toHaveCount(1)
  await expect(page.locator('[data-note-text-input]')).toBeFocused()
  await page.locator('[data-note-text-input]').type('The first line')
  await expect(page.locator('[data-note-text-input]')).toHaveText('The first line')
})

test('note text restores the caret after tabbing away mid-edit', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const noteText = page.locator('[data-note-text-input]').first()
  await noteText.fill('Draft note')
  await noteText.focus()

  await page.evaluate(() => {
    const input = document.activeElement
    if (!(input instanceof HTMLElement) || !input.matches('[data-note-text-input]')) return

    const range = document.createRange()
    range.setStart(input.firstChild as Node, 5)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await noteText.type('x')
  await expect(noteText).toHaveText('Draftx note')

  await page.evaluate(async () => {
    const input = document.activeElement
    if (!(input instanceof HTMLElement) || !input.matches('[data-note-text-input]')) return

    // The native webview can collapse the selection before editor blur is delivered.
    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    input.blur()

    await new Promise((resolve) => window.setTimeout(resolve, 25))
    window.dispatchEvent(new FocusEvent('blur'))
  })

  await page.evaluate(() => {
    const input = document.querySelector<HTMLElement>('[data-note-text-input]')
    if (!input) return
    input.focus()

    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    window.dispatchEvent(new FocusEvent('focus'))
  })

  await expect
    .poll(() =>
      page.evaluate(() => {
        const input = document.activeElement
        const selection = document.getSelection()
        if (!(input instanceof HTMLElement) || !selection || selection.rangeCount === 0) return null
        const range = selection.getRangeAt(0).cloneRange()
        range.selectNodeContents(input)
        range.setEnd(selection.anchorNode ?? input, selection.anchorOffset)
        return range.toString().length
      }),
    )
    .toBe(6)
})

test('deleting a note confirms and remains undoable', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Temporary note')

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByLabel('Note title')).toHaveCount(0)

  await page.keyboard.press('Meta+Z')
  await expect(page.getByLabel('Note title')).toHaveValue('Temporary note')
})
