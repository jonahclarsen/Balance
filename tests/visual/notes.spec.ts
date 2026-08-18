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

async function copyNoteSelection(page: Page) {
  return page.evaluate(() => {
    const target = document.activeElement
    if (!(target instanceof HTMLElement)) return null

    const clipboardData = new DataTransfer()
    const copied = target.dispatchEvent(new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }))
    return {
      handled: !copied,
      plainText: clipboardData.getData('text/plain'),
      html: clipboardData.getData('text/html'),
    }
  })
}

async function watchNextNoteCopy(page: Page) {
  await page.evaluate(() => {
    const browserWindow = window as Window & { capturedNoteCopy?: { handled: boolean; plainText: string; html: string } }
    browserWindow.capturedNoteCopy = undefined
    document.addEventListener('copy', (event) => {
      browserWindow.capturedNoteCopy = {
        handled: event.defaultPrevented,
        plainText: event.clipboardData?.getData('text/plain') ?? '',
        html: event.clipboardData?.getData('text/html') ?? '',
      }
    }, { once: true })
  })
}

async function capturedNoteCopy(page: Page) {
  return page.evaluate(() => (
    window as Window & { capturedNoteCopy?: { handled: boolean; plainText: string; html: string } }
  ).capturedNoteCopy ?? null)
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

test('arrow keys keep the caret position when moving between numbered note items', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Numbered list' }).click()

  const first = page.locator('[data-note-text-input]').first()
  await first.fill('First numbered item')
  await placeCaretAtEnd(first)
  await first.press('Enter')
  const second = page.locator('[data-note-text-input]').nth(1)
  await second.fill('Second numbered item')

  await placeCaretAtOffset(second, 6)
  await second.press('ArrowUp')
  await expect.poll(() => noteSelectionEndpoints(page)).toEqual({
    anchor: { text: 'First numbered item', offset: 6 },
    focus: { text: 'First numbered item', offset: 6 },
  })

  await first.press('ArrowDown')
  await expect.poll(() => noteSelectionEndpoints(page)).toEqual({
    anchor: { text: 'Second numbered item', offset: 6 },
    focus: { text: 'Second numbered item', offset: 6 },
  })
})

test('shift arrow keys select adjacent bullet items without relying on a cross-editor DOM range', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Bulleted list' }).click()

  const first = page.locator('[data-note-text-input]').first()
  await first.fill('First bullet')
  await placeCaretAtEnd(first)
  await first.press('Enter')
  const second = page.locator('[data-note-text-input]').nth(1)
  await second.fill('Second bullet')

  await placeCaretAtOffset(first, 4)
  await first.press('Shift+ArrowDown')
  await expect(page.locator('.note-multi-selected')).toHaveCount(2)
  await watchNextNoteCopy(page)
  await second.press('Meta+C')
  await expect.poll(() => capturedNoteCopy(page)).toEqual({
    handled: true,
    plainText: '- First bullet\n- Second bullet',
    html: '<ul><li>First bullet</li><li>Second bullet</li></ul>',
  })

  await second.press('Shift+ArrowUp')
  await expect(page.locator('.note-multi-selected')).toHaveCount(0)
})

test('typing the next number resumes a numbered list after outdenting a bulleted child', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop list keyboard behavior is covered here')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Numbered list' }).click()

  const editors = page.locator('[data-note-text-input]')
  const first = editors.first()
  await first.fill('First item')
  await placeCaretAtEnd(first)
  await first.press('Enter')

  const child = editors.nth(1)
  await child.press('Tab')
  await child.type('- ')
  await child.type('Bulleted child')
  await placeCaretAtEnd(child)
  await child.press('Enter')

  const continuation = editors.nth(2)
  await continuation.press('Shift+Tab')
  await continuation.type('2. ')

  const continuationRow = continuation.locator('xpath=ancestor::*[@data-note-item-id]')
  await expect(continuationRow).toHaveAttribute('data-note-item-depth', '0')
  await expect(continuationRow).toHaveClass(/note-numbered/)
  await expect(continuationRow).toHaveAttribute('data-note-item-number', '2')
  await expect(continuation).toHaveText('')
})

test('notes select all blocks and copy plain text plus semantic HTML lists', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop keyboard and rich clipboard behavior is covered here')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const toolbar = page.getByRole('toolbar', { name: 'Note formatting' })
  await toolbar.getByRole('button', { name: 'Bulleted list' }).click()

  const first = page.locator('[data-note-text-input]').first()
  await first.fill('Alpha')
  await first.press('Meta+A')
  await first.press('Meta+B')
  await placeCaretAtEnd(first)
  await first.press('Enter')

  const second = page.locator('[data-note-text-input]').nth(1)
  await second.fill('Beta')
  await placeCaretAtEnd(second)
  await second.press('Enter')

  const third = page.locator('[data-note-text-input]').nth(2)
  await third.fill('Gamma')
  await third.press('Meta+A')
  await third.press('Meta+A')

  await expect(page.locator('.note-multi-selected')).toHaveCount(3)
  await expect.poll(() => copyNoteSelection(page)).toEqual({
    handled: true,
    plainText: '- Alpha\n- Beta\n- Gamma',
    html: '<ul><li><strong>Alpha</strong></li><li>Beta</li><li>Gamma</li></ul>',
  })
})

test('dragging can extend a note selection across list items', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'touch selection is owned by the platform')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Bulleted list' }).click()

  const first = page.locator('[data-note-text-input]').first()
  await first.fill('First line')
  await placeCaretAtEnd(first)
  await first.press('Enter')
  const second = page.locator('[data-note-text-input]').nth(1)
  await second.fill('Second line')

  const firstBox = await first.boundingBox()
  const secondBox = await second.boundingBox()
  expect(firstBox).not.toBeNull()
  expect(secondBox).not.toBeNull()
  await page.mouse.move(firstBox!.x + 3, firstBox!.y + firstBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(secondBox!.x + secondBox!.width - 3, secondBox!.y + secondBox!.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect(page.locator('.note-multi-selected')).toHaveCount(2)
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? '')).toBe('')
  await expect.poll(() => copyNoteSelection(page)).toEqual({
    handled: true,
    plainText: '- First line\n- Second line',
    html: '<ul><li>First line</li><li>Second line</li></ul>',
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

test('notes save adjustable breathing room and follow edits only from the bottom', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop scroll behavior is covered here')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const editor = page.locator('[data-note-text-input]').first()
  const workspace = page.locator('.workspace')
  const spacingSlider = page.getByLabel('Bottom writing space')
  await editor.fill(Array.from({ length: 80 }, (_, index) => `Long note line ${index + 1}`).join('\n'))

  await expect(spacingSlider).toHaveAttribute('min', '0')
  await expect(spacingSlider).toHaveAttribute('max', '100')
  await expect(spacingSlider).toHaveValue('60')

  const writingSpace = await page.locator('.note-scroll-space').evaluate((element) => {
    const spacer = element.getBoundingClientRect()
    const notesWorkspace = element.previousElementSibling
    const workspaceBounds = notesWorkspace?.getBoundingClientRect()
    return {
      height: spacer.height,
      outsideNotesWorkspace: notesWorkspace?.classList.contains('notes-workspace') && !notesWorkspace.contains(element),
      startsAfterNotesWorkspace: workspaceBounds ? spacer.top >= workspaceBounds.bottom : false,
    }
  })
  expect(writingSpace.outsideNotesWorkspace).toBe(true)
  expect(writingSpace.startsAfterNotesWorkspace).toBe(true)
  expect(writingSpace.height).toBeGreaterThan((page.viewportSize()?.height ?? 0) * 0.3)
  expect(writingSpace.height).toBeLessThan((page.viewportSize()?.height ?? 0) * 0.32)

  await workspace.evaluate((element) => element.scrollTo({ top: 0 }))
  const controlIsHiddenBeforeBottom = await page.locator('.note-scroll-space-control').evaluate((element) => {
    const control = element.getBoundingClientRect()
    const scroller = element.closest('.workspace')?.getBoundingClientRect()
    return scroller ? control.top >= scroller.bottom : false
  })
  expect(controlIsHiddenBeforeBottom).toBe(true)

  await workspace.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await spacingSlider.fill('0')
  const minimumSpace = await page.locator('.note-scroll-space').evaluate((element) => ({
    spacerHeight: element.getBoundingClientRect().height,
    controlHeight: element.querySelector('label')?.getBoundingClientRect().height ?? Number.POSITIVE_INFINITY,
  }))
  expect(minimumSpace.spacerHeight).toBeGreaterThanOrEqual(minimumSpace.controlHeight + 8)

  const startGeometry = await page.evaluate(() => {
    const track = document.querySelector('.note-scroll-space-track')?.getBoundingClientRect()
    const fill = document.querySelector('.note-scroll-space-fill')?.getBoundingClientRect()
    const thumb = document.querySelector('.note-scroll-space-thumb')?.getBoundingClientRect()
    return track && fill && thumb
      ? { trackLeft: track.left, thumbCenter: thumb.left + thumb.width / 2, fillLeft: fill.left, fillWidth: fill.width }
      : null
  })
  expect(startGeometry).not.toBeNull()
  expect(startGeometry?.thumbCenter).toBeCloseTo(startGeometry?.trackLeft ?? 0, 0)
  expect(startGeometry?.fillLeft).toBeCloseTo(startGeometry?.trackLeft ?? 0, 0)
  expect(startGeometry?.fillWidth).toBeCloseTo(0, 0)

  const fixedControlBottom = await page.locator('.note-scroll-space-control').evaluate((element) => element.getBoundingClientRect().bottom)
  await spacingSlider.fill('100')
  await expect.poll(() => workspace.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(4)
  await expect.poll(() => page.locator('.note-scroll-space-control').evaluate((element) => element.getBoundingClientRect().bottom)).toBeCloseTo(fixedControlBottom, 0)
  const endGeometry = await page.evaluate(() => {
    const track = document.querySelector('.note-scroll-space-track')?.getBoundingClientRect()
    const fill = document.querySelector('.note-scroll-space-fill')?.getBoundingClientRect()
    const thumb = document.querySelector('.note-scroll-space-thumb')?.getBoundingClientRect()
    return track && fill && thumb
      ? { trackRight: track.right, trackWidth: track.width, thumbCenter: thumb.left + thumb.width / 2, fillWidth: fill.width }
      : null
  })
  expect(endGeometry).not.toBeNull()
  expect(endGeometry?.thumbCenter).toBeCloseTo(endGeometry?.trackRight ?? 0, 0)
  expect(endGeometry?.fillWidth).toBeCloseTo(endGeometry?.trackWidth ?? 0, 0)
  await page.screenshot({ path: testInfo.outputPath('note-spacing-slider-at-bottom.png'), fullPage: false })
  const visibleNoteHeight = await page.evaluate(() => {
    const scroller = document.querySelector('.workspace')?.getBoundingClientRect()
    const notesWorkspace = document.querySelector('.notes-workspace')?.getBoundingClientRect()
    return scroller && notesWorkspace ? notesWorkspace.bottom - scroller.top : 0
  })
  expect(visibleNoteHeight).toBeGreaterThan(96)

  await spacingSlider.fill('40')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('balance:noteScrollSpacePercent'))).toBe('40')
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByLabel('Bottom writing space')).toHaveValue('40')

  await workspace.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await placeCaretAtEnd(editor)
  await editor.press('Enter')
  await expect(page.locator('[data-note-text-input]')).toHaveCount(2)
  await expect.poll(() => workspace.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(4)

  const secondEditor = page.locator('[data-note-text-input]').nth(1)
  await secondEditor.type('Still following the bottom')
  await expect.poll(() => workspace.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(4)

  const scrolledUpPosition = await workspace.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollTop - 160)
    return element.scrollTop
  })
  await secondEditor.evaluate((element) => {
    element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }))
  })
  await expect.poll(() => workspace.evaluate((element) => element.scrollTop)).toBeCloseTo(scrolledUpPosition, 0)
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
