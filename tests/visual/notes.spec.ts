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

async function openPrimaryView(page: Page, name: 'Notes' | 'Day Templates') {
  const mobileMenu = page.locator('.mobile-app-header').getByRole('button', { name: 'Open navigation' })
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click()
    await page.getByRole('complementary', { name: 'Primary navigation drawer' })
      .getByRole('button', { name, exact: true })
      .click()
    return
  }
  await page.getByRole('button', { name, exact: true }).click()
}

async function openNotesView(page: Page) {
  await openPrimaryView(page, 'Notes')
}

async function setNoteScrollTop(page: Page, scrollTop: number) {
  return page.evaluate((top) => {
    const noteDocument = document.querySelector<HTMLElement>('.note-document')
    const noteDocumentScrolls = noteDocument && ['auto', 'scroll'].includes(getComputedStyle(noteDocument).overflowY)
    const scroller = noteDocumentScrolls ? noteDocument : document.scrollingElement
    if (!(scroller instanceof HTMLElement)) return 0
    scroller.scrollTop = top
    return scroller.scrollTop
  }, scrollTop)
}

async function noteScrollTop(page: Page) {
  return page.evaluate(() => {
    const noteDocument = document.querySelector<HTMLElement>('.note-document')
    const noteDocumentScrolls = noteDocument && ['auto', 'scroll'].includes(getComputedStyle(noteDocument).overflowY)
    const scroller = noteDocumentScrolls ? noteDocument : document.scrollingElement
    return scroller?.scrollTop ?? 0
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

async function placeCaretOnLastLine(editor: Locator) {
  await editor.evaluate((element) => {
    const input = element as HTMLElement
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let node = walker.nextNode()
    while (node) {
      nodes.push(node as Text)
      node = walker.nextNode()
    }
    const lastNode = nodes.at(-1)
    if (!lastNode) return
    const lastBreak = lastNode.data.lastIndexOf('\n')
    const offset = Math.min(lastNode.length, Math.max(0, lastBreak + 2))
    input.focus()
    const range = document.createRange()
    range.setStart(lastNode, offset)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
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

async function noteCaretVisualPosition(page: Page) {
  return page.evaluate(() => {
    const selection = document.getSelection()
    if (!selection?.isCollapsed || selection.rangeCount === 0) return null
    const caret = selection.getRangeAt(0)
    const element = caret.startContainer instanceof Element ? caret.startContainer : caret.startContainer.parentElement
    const input = element?.closest<HTMLElement>('[data-note-text-input]')
    if (!input) return null

    const caretRect = caret.getBoundingClientRect()
    const content = document.createRange()
    content.selectNodeContents(input)
    const lineTops = Array.from(content.getClientRects())
      .filter((rect) => rect.height > 0 && rect.width > 0)
      .map((rect) => rect.top)
    return {
      inputIndex: Array.from(document.querySelectorAll('[data-note-text-input]')).indexOf(input),
      caretLeft: caretRect.left,
      caretTop: caretRect.top,
      firstLineTop: Math.min(...lineTops),
      lastLineTop: Math.max(...lineTops),
      lineCount: new Set(lineTops.map((top) => Math.round(top))).size,
    }
  })
}

async function noteInputContentLeft(editor: Locator) {
  return editor.evaluate((element) => {
    const input = element as HTMLElement
    const rect = input.getBoundingClientRect()
    const style = getComputedStyle(input)
    return rect.left
      + (Number.parseFloat(style.borderLeftWidth) || 0)
      + (Number.parseFloat(style.paddingLeft) || 0)
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
  const notesPageActions = page.locator('.notes-page-actions')
  const notesPageHeader = page.locator('.notes-page-header')
  const notesSidebar = page.locator('.notes-sidebar')
  const binButton = notesPageActions.getByRole('button', { name: 'Bin', exact: true })
  const imaxButton = page.getByRole('button', { name: 'Enter IMAX mode' })
  const goalRhythm = page.getByRole('region', { name: 'Goal history' })
  const sidebar = page.getByRole('complementary', { name: 'Primary navigation drawer' })

  await expect(notesPageActions.locator('button')).toHaveCount(2)
  await expect(binButton).toBeVisible()
  await expect(imaxButton).toBeVisible()
  await expect(goalRhythm).toBeVisible()
  await expect(sidebar).toBeVisible()
  await expect(notesPageHeader).toBeVisible()
  await expect(notesSidebar).toBeVisible()
  await expect(notesSidebar.getByRole('heading', { name: 'Notes', exact: true })).toHaveCount(0)
  await imaxButton.click()

  const exitImaxButton = page.locator('.imax-exit-control').getByRole('button', { name: 'Exit IMAX mode' })
  await expect(exitImaxButton).toHaveAttribute('aria-pressed', 'true')
  await expect(goalRhythm).toBeHidden()
  await expect(sidebar).toBeHidden()
  await expect(notesPageHeader).toBeHidden()
  await expect(notesSidebar).toBeHidden()

  await exitImaxButton.click()
  await expect(imaxButton).toHaveAttribute('aria-pressed', 'false')
  await expect(goalRhythm).toBeVisible()
  await expect(sidebar).toBeVisible()
  await expect(notesPageHeader).toBeVisible()
  await expect(notesSidebar).toBeVisible()
})

test('the Notes sidebar list scrolls independently and keeps New beside the filter', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the mobile note picker remains horizontal')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openNotesView(page)
  await page.getByRole('button', { name: '+ New note' }).click()
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.notes?.length ?? 0
  })).toBe(1)
  await page.locator('.workspace').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: testInfo.outputPath('notes-sidebar-short.png') })

  await page.evaluate(() => {
    const key = 'balance.appState.v1'
    const state = JSON.parse(localStorage.getItem(key) || '{}')
    const source = state.notes[0]
    state.notes = Array.from({ length: 40 }, (_, index) => ({
      ...source,
      id: `note_sidebar_${index}`,
      title: `Sidebar note ${String(index + 1).padStart(2, '0')}`,
      items: source.items.map((item: { id: string }) => ({ ...item, id: `${item.id}_${index}` })),
      updatedAt: new Date(Date.now() - index * 1_000).toISOString(),
    }))
    localStorage.setItem(key, JSON.stringify(state))
  })
  await page.reload()
  await openNotesView(page)

  const sidebar = page.locator('.notes-sidebar')
  const newButton = sidebar.getByRole('button', { name: 'New', exact: true })
  const filter = sidebar.getByRole('searchbox', { name: 'Filter notes' })
  await expect(newButton).toBeVisible()
  await expect(sidebar.getByRole('button', { name: '+ New', exact: true })).toHaveCount(0)
  const controls = await Promise.all([newButton.boundingBox(), filter.boundingBox()])
  expect(controls[0]).not.toBeNull()
  expect(controls[1]).not.toBeNull()
  expect(controls[0]!.x + controls[0]!.width).toBeLessThan(controls[1]!.x)
  expect(Math.abs(
    controls[0]!.y + controls[0]!.height / 2 - (controls[1]!.y + controls[1]!.height / 2),
  )).toBeLessThanOrEqual(2)

  const workspace = page.locator('.workspace')
  const noteDocument = page.locator('.note-document')
  const notesList = sidebar.locator('.notes-list')
  const noteEditor = page.locator('[data-note-text-input]').first()
  await noteEditor.fill(Array.from({ length: 80 }, (_, index) => `Pinned sidebar line ${index + 1}`).join('\n'))
  const sidebarBeforeNoteScroll = await sidebar.boundingBox()
  await noteDocument.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => noteDocument.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const sidebarAfterNoteScroll = await sidebar.boundingBox()
  expect(sidebarBeforeNoteScroll).not.toBeNull()
  expect(sidebarAfterNoteScroll).not.toBeNull()
  expect(sidebarAfterNoteScroll?.x).toBeCloseTo(sidebarBeforeNoteScroll?.x ?? 0, 0)
  expect(sidebarAfterNoteScroll?.y).toBeCloseTo(sidebarBeforeNoteScroll?.y ?? 0, 0)
  expect(sidebarAfterNoteScroll?.height).toBeCloseTo(sidebarBeforeNoteScroll?.height ?? 0, 0)
  await expect.poll(() => workspace.evaluate((element) => element.scrollTop)).toBe(0)

  const before = await page.evaluate(() => ({
    workspace: document.querySelector<HTMLElement>('.workspace')?.scrollTop ?? -1,
    listClientHeight: document.querySelector<HTMLElement>('.notes-list')?.clientHeight ?? -1,
    listScrollHeight: document.querySelector<HTMLElement>('.notes-list')?.scrollHeight ?? -1,
  }))
  expect(before.listScrollHeight).toBeGreaterThan(before.listClientHeight)
  await notesList.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => notesList.evaluate((element) => (
    element.scrollTop + element.clientHeight >= element.scrollHeight - 1
  ))).toBe(true)
  await expect.poll(() => workspace.evaluate((element) => element.scrollTop)).toBe(before.workspace)
  await page.screenshot({ path: testInfo.outputPath('notes-sidebar.png') })
})

test('the Notes new-note command creates and selects a note', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openNotesView(page)

  const newNoteButton = page.locator('.note-new')
  await expect(newNoteButton).toHaveAttribute('aria-keyshortcuts', 'Control+N Meta+N')
  await expect(newNoteButton.locator('kbd')).toHaveText(/^(Ctrl\+|⌘)N$/)

  await page.getByRole('button', { name: '+ New note' }).click()
  await expect(page.getByLabel('Note title')).toBeFocused()
  await page.keyboard.press('Control+n')

  await expect(page.getByLabel('Note title')).toBeFocused()
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.notes?.length ?? 0
  })).toBe(2)

  await page.keyboard.press('Alt+/')
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(shortcuts.getByText('Create note (while in Notes)', { exact: true })).toBeVisible()
})

test('note style menu stays visible inside the note scroller and viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop popup placement is covered here')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const workspace = page.locator('.workspace')
  const firstEditor = page.locator('[data-note-text-input]').first()
  await firstEditor.fill(Array.from({ length: 60 }, (_, index) => `Popup positioning line ${index + 1}`).join('\n'))
  await placeCaretAtEnd(firstEditor)
  await firstEditor.press('Enter')
  const slashEditor = page.locator('[data-note-text-input]').nth(1)
  await workspace.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await page.getByLabel('Bottom writing space').fill('0')
  await workspace.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await slashEditor.fill('/')

  const menu = page.getByRole('listbox', { name: 'Note styles' })
  await expect(menu).toBeVisible()
  const geometry = await page.evaluate(() => {
    const menuBounds = document.querySelector('.note-slash-menu')?.getBoundingClientRect()
    const noteBounds = document.querySelector('.notes-workspace')?.getBoundingClientRect()
    return menuBounds && noteBounds
      ? {
          menuTop: menuBounds.top,
          menuBottom: menuBounds.bottom,
          noteBottom: noteBounds.bottom,
          viewportHeight: window.innerHeight,
        }
      : null
  })
  expect(geometry).not.toBeNull()
  expect(geometry?.menuTop).toBeGreaterThanOrEqual(8)
  expect(geometry?.menuBottom).toBeLessThanOrEqual((geometry?.viewportHeight ?? 0) - 8)
  expect(geometry?.menuBottom).toBeLessThanOrEqual(geometry?.noteBottom ?? 0)
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

test('ArrowUp from a new empty note paragraph enters the line directly above', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openNotesView(page)
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.locator('.note-blocks').evaluate((element) => (element.style.width = '420px'))

  const first = page.locator('[data-note-text-input]').first()
  await first.fill('This first paragraph is deliberately long enough to wrap across multiple visual lines before the new empty paragraph')
  await placeCaretAtEnd(first)
  await first.press('Enter')

  const second = page.locator('[data-note-text-input]').nth(1)
  await expect(second).toBeFocused()
  const sourceLeft = await noteInputContentLeft(second)
  await second.press('ArrowUp')

  const movedUp = await noteCaretVisualPosition(page)
  expect(movedUp?.inputIndex).toBe(0)
  expect(movedUp?.lineCount).toBeGreaterThan(1)
  expect(movedUp?.caretTop).toBeCloseTo(movedUp?.lastLineTop ?? -1, 0)
  expect(Math.abs((movedUp?.caretLeft ?? 0) - sourceLeft)).toBeLessThan(12)
})

test('ArrowUp from an empty bullet preserves its indented visual column', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openNotesView(page)
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.locator('.note-blocks').evaluate((element) => (element.style.width = '420px'))

  const first = page.locator('[data-note-text-input]').first()
  await first.fill('This first paragraph is deliberately long enough to wrap across multiple visual lines before the new empty bullet')
  await placeCaretAtEnd(first)
  await first.press('Enter')

  const second = page.locator('[data-note-text-input]').nth(1)
  await page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Bulleted list' }).click()
  await expect(second).toBeFocused()
  const sourceLeft = await noteInputContentLeft(second)
  await second.press('ArrowUp')

  const movedUp = await noteCaretVisualPosition(page)
  expect(movedUp?.inputIndex).toBe(0)
  expect(movedUp?.lineCount).toBeGreaterThan(1)
  expect(movedUp?.caretTop).toBeCloseTo(movedUp?.lastLineTop ?? -1, 0)
  expect(Math.abs((movedUp?.caretLeft ?? 0) - sourceLeft)).toBeLessThan(6)
})

test('arrow keys keep the visual caret column when moving between numbered note items', async ({ page }) => {
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
  const source = await noteCaretVisualPosition(page)
  expect(source).not.toBeNull()
  await second.press('ArrowUp')
  const movedUp = await noteCaretVisualPosition(page)
  expect(movedUp?.inputIndex).toBe(0)
  expect(Math.abs((movedUp?.caretLeft ?? 0) - (source?.caretLeft ?? 0))).toBeLessThan(6)

  await first.press('ArrowDown')
  const movedDown = await noteCaretVisualPosition(page)
  expect(movedDown?.inputIndex).toBe(1)
  expect(Math.abs((movedDown?.caretLeft ?? 0) - (source?.caretLeft ?? 0))).toBeLessThan(6)
})

test('arrow keys enter the boundary line of a wrapped numbered note item', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Numbered list' }).click()
  await page.locator('.note-blocks').evaluate((element) => (element.style.width = '520px'))

  const first = page.locator('[data-note-text-input]').first()
  await first.fill('This first numbered item is deliberately long enough to wrap while leaving plenty of text on its final visual line')
  await placeCaretAtEnd(first)
  await first.press('Enter')
  const second = page.locator('[data-note-text-input]').nth(1)
  await second.fill('Second numbered item')

  await placeCaretAtOffset(second, 6)
  const source = await noteCaretVisualPosition(page)
  expect(source?.lineCount).toBe(1)
  await second.press('ArrowUp')
  const movedUp = await noteCaretVisualPosition(page)
  expect(movedUp?.inputIndex).toBe(0)
  expect(movedUp?.lineCount).toBeGreaterThan(1)
  expect(movedUp?.caretTop).toBeCloseTo(movedUp?.lastLineTop ?? -1, 0)
  expect(Math.abs((movedUp?.caretLeft ?? 0) - (source?.caretLeft ?? 0))).toBeLessThan(6)

  await first.press('ArrowDown')
  const movedDown = await noteCaretVisualPosition(page)
  expect(movedDown?.inputIndex).toBe(1)
  expect(movedDown?.caretTop).toBeCloseTo(movedDown?.firstLineTop ?? -1, 0)
  expect(Math.abs((movedDown?.caretLeft ?? 0) - (source?.caretLeft ?? 0))).toBeLessThan(6)
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

test('a bullet indented below a heading keeps ordinary body typography', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop Tab indentation is covered here')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const editors = page.locator('[data-note-text-input]')
  const heading = editors.first()
  await heading.fill('/h1')
  await heading.press('Enter')
  await heading.fill('Section heading')
  await placeCaretAtEnd(heading)
  await heading.press('Enter')

  const bullet = editors.nth(1)
  await bullet.type('- ')
  await bullet.type('Nested bullet')
  await bullet.press('Tab')

  const bulletRow = bullet.locator('xpath=ancestor::*[@data-note-item-id][1]')
  await expect(bulletRow).toHaveClass(/note-bullet/)
  await expect(bulletRow).toHaveAttribute('data-note-item-depth', '1')
  await expect(heading).toHaveCSS('font-size', '25px')
  await expect(bullet).toHaveCSS('font-size', '15px')
  await expect(bullet).toHaveCSS('min-height', '30px')
  await expect(bullet).toHaveCSS('line-height', '25.5px')
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
  await second.press('Shift+Enter')
  await second.type('Beta continuation')
  await placeCaretAtEnd(second)
  await second.press('Enter')

  const third = page.locator('[data-note-text-input]').nth(2)
  await third.fill('Gamma')
  await third.press('Meta+A')
  await third.press('Meta+A')

  await expect(page.locator('.note-multi-selected')).toHaveCount(3)
  await expect.poll(() => copyNoteSelection(page)).toEqual({
    handled: true,
    plainText: '- Alpha\n- Beta\n  Beta continuation\n- Gamma',
    html: '<ul><li><strong>Alpha</strong></li><li>Beta\nBeta continuation</li><li>Gamma</li></ul>',
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

test('shift-clicking extends a note selection across list items', async ({ page }, testInfo) => {
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
  await placeCaretAtEnd(second)
  await second.press('Enter')
  const third = page.locator('[data-note-text-input]').nth(2)
  await third.fill('Third line')

  await placeCaretAtOffset(first, 4)
  await expect.poll(() => noteSelectionEndpoints(page)).toEqual({
    anchor: { text: 'First line', offset: 4 },
    focus: { text: 'First line', offset: 4 },
  })
  await third.click({ modifiers: ['Shift'] })

  await expect(page.locator('.note-multi-selected')).toHaveCount(3)
  await expect.poll(() => copyNoteSelection(page)).toEqual({
    handled: true,
    plainText: '- First line\n- Second line\n- Third line',
    html: '<ul><li>First line</li><li>Second line</li><li>Third line</li></ul>',
  })

  await second.click({ modifiers: ['Shift'] })
  await expect(page.locator('.note-multi-selected')).toHaveCount(2)
  await expect.poll(() => copyNoteSelection(page)).toEqual({
    handled: true,
    plainText: '- First line\n- Second line',
    html: '<ul><li>First line</li><li>Second line</li></ul>',
  })
})

test('empty bulleted and numbered note items remain list items on Enter', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const toolbar = page.getByRole('toolbar', { name: 'Note formatting' })
  await toolbar.getByRole('button', { name: 'Bulleted list' }).click()
  const first = page.locator('.note-item').first()
  await expect(first).toHaveClass(/note-bullet/)
  await first.locator('[data-note-text-input]').fill('Bullet')
  await placeCaretAtEnd(first.locator('[data-note-text-input]'))
  await first.locator('[data-note-text-input]').press('Enter')

  await expect(page.locator('.note-item')).toHaveCount(2)
  const second = page.locator('.note-item').nth(1)
  await expect(second).toHaveClass(/note-bullet/)
  const secondId = await second.getAttribute('data-note-item-id')
  expect(secondId).not.toBeNull()
  await second.locator('[data-note-text-input]').press('Enter')

  await expect(page.locator('.note-item')).toHaveCount(3)
  await expect(page.locator('.note-item').nth(1)).toHaveAttribute('data-note-item-id', secondId!)
  const newBullet = page.locator('.note-item').nth(2)
  await expect(newBullet).toHaveClass(/note-bullet/)
  await expect(newBullet.locator('[data-note-text-input]')).toBeFocused()

  const third = newBullet
  await third.locator('[data-note-text-input]').fill('1. ')
  await expect(third).toHaveClass(/note-numbered/)
  await third.locator('[data-note-text-input]').fill('Numbered')
  await placeCaretAtEnd(third.locator('[data-note-text-input]'))
  await third.locator('[data-note-text-input]').press('Enter')

  await expect(page.locator('.note-item')).toHaveCount(4)
  const fourth = page.locator('.note-item').nth(3)
  await expect(fourth).toHaveClass(/note-numbered/)
  const fourthId = await fourth.getAttribute('data-note-item-id')
  expect(fourthId).not.toBeNull()
  await fourth.locator('[data-note-text-input]').press('Enter')

  await expect(page.locator('.note-item')).toHaveCount(5)
  await expect(page.locator('.note-item').nth(3)).toHaveAttribute('data-note-item-id', fourthId!)
  const newNumbered = page.locator('.note-item').nth(4)
  await expect(newNumbered).toHaveClass(/note-numbered/)
  await expect(newNumbered.locator('[data-note-text-input]')).toBeFocused()
})

test('notes support a seamless editor, natural formatting, persistence, search, and app links', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Project Brain')

  const firstBlock = page.locator('[data-note-text-input]').first()
  await firstBlock.fill('/h1')
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

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.getByLabel('List name').fill('Reading')
  const templateText = page.locator('[data-list-template-text-input]').first()
  await templateText.fill('Open Project Brain')
  const pasteResult = await templateText.evaluate((element, link) => {
    element.focus()
    const selection = document.getSelection()
    const range = document.createRange()
    range.setStart(element.firstChild!, 5)
    range.setEnd(element.firstChild!, 18)
    selection?.removeAllRanges()
    selection?.addRange(range)
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', link)
    const selectedText = selection?.toString()
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
    return { selectedText, html: element.innerHTML }
  }, noteLink)
  expect(pasteResult.selectedText).toBe('Project Brain')
  expect(pasteResult.html).toContain(`<a href="${noteLink}">Project Brain</a>`)
  await templateText.blur()
  const internalLink = templateText.getByRole('link', { name: 'Project Brain' })
  await expect(internalLink).toBeVisible()
  await expect(internalLink).toHaveAttribute('href', noteLink)
  await expect(templateText).toHaveText('Open Project Brain')
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

test('note formatting toolbar stays visible in a wide centered workspace while scrolling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop workspace geometry is covered here')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const editor = page.locator('[data-note-text-input]').first()
  const workspace = page.locator('.workspace')
  const noteDocument = page.locator('.note-document')
  const toolbar = page.getByRole('toolbar', { name: 'Note formatting' })
  const formatHint = toolbar.locator('.note-format-hint')
  const slashKey = toolbar.locator('.note-format-hint kbd')
  const notesWorkspace = page.locator('.notes-workspace')
  await editor.fill(Array.from({ length: 80 }, (_, index) => `Long note line ${index + 1}`).join('\n'))
  await expect(notesWorkspace).toHaveCSS('zoom', '1')
  await expect(formatHint).toHaveCSS('display', 'flex')
  await expect(formatHint).toHaveCSS('align-items', 'center')
  await expect(formatHint).toHaveCSS('font-size', '12px')
  await expect(slashKey).toHaveCSS('display', 'grid')
  await expect(slashKey).toHaveCSS('place-items', 'center')
  await expect(slashKey).toHaveCSS('width', '15px')
  await expect(slashKey).toHaveCSS('height', '15px')
  const hintAlignment = await slashKey.evaluate((element) => {
    const keyBounds = element.getBoundingClientRect()
    const hintBounds = element.parentElement?.getBoundingClientRect()
    return hintBounds
      ? { keyCenter: keyBounds.top + keyBounds.height / 2, hintCenter: hintBounds.top + hintBounds.height / 2 }
      : null
  })
  expect(hintAlignment).not.toBeNull()
  expect(Math.abs((hintAlignment?.keyCenter ?? 0) - (hintAlignment?.hintCenter ?? 0))).toBeLessThan(1)
  const workspaceGeometry = await page.evaluate(() => {
    const workspaceBounds = document.querySelector('.workspace')?.getBoundingClientRect()
    const notesBounds = document.querySelector('.notes-workspace')?.getBoundingClientRect()
    return workspaceBounds && notesBounds
      ? {
          widthRatio: notesBounds.width / workspaceBounds.width,
          leftGap: notesBounds.left - workspaceBounds.left,
          rightGap: workspaceBounds.right - notesBounds.right,
        }
      : null
  })
  expect(workspaceGeometry).not.toBeNull()
  expect(workspaceGeometry?.widthRatio).toBeGreaterThan(0.94)
  expect(Math.abs((workspaceGeometry?.leftGap ?? 0) - (workspaceGeometry?.rightGap ?? 0))).toBeLessThan(1)
  await noteDocument.evaluate((element) => element.scrollTo({ top: element.scrollHeight / 2 }))

  await expect.poll(async () => {
    const workspaceBox = await noteDocument.boundingBox()
    const toolbarBox = await toolbar.boundingBox()
    if (!workspaceBox || !toolbarBox) return false
    const top = toolbarBox.y - workspaceBox.y
    return toolbarBox.y + toolbarBox.height > workspaceBox.y
      && toolbarBox.y < workspaceBox.y + workspaceBox.height
      && top >= 8
      && top <= 48
  }).toBe(true)

  const stickyOffsets = await noteDocument.evaluate((scroller) => {
    const toolbarElement = scroller.querySelector<HTMLElement>('.note-format-toolbar')
    if (!toolbarElement) return []
    return [0.5, 0.75, 1].map((progress) => {
      scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * progress
      return toolbarElement.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    })
  })
  expect(stickyOffsets).toHaveLength(3)
  expect(Math.max(...stickyOffsets) - Math.min(...stickyOffsets)).toBeLessThanOrEqual(1)
  await expect.poll(() => workspace.evaluate((element) => element.scrollTop)).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('notes-toolbar-sticky.png'), fullPage: false })
})

test('note formatting toolbar uses a complete static pink stroke on Iridescent', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop toolbar styling is covered here')
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({
      version: 1,
      themeId: 'iridescent',
      randomThemeStartDate: '',
      doneTintColor: '',
      checkboxColor: '',
    }))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const toolbar = page.getByRole('toolbar', { name: 'Note formatting' })
  const toolbarStroke = await toolbar.evaluate((element) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--iridescent-border-pink)'
    document.body.append(probe)
    const styles = getComputedStyle(element)
    const afterStyles = getComputedStyle(element, '::after')
    const result = {
      borderColors: [styles.borderTopColor, styles.borderRightColor, styles.borderBottomColor, styles.borderLeftColor],
      borderWidths: [styles.borderTopWidth, styles.borderRightWidth, styles.borderBottomWidth, styles.borderLeftWidth],
      expectedColor: getComputedStyle(probe).color,
      afterContent: afterStyles.content,
      afterAnimation: afterStyles.animationName,
    }
    probe.remove()
    return result
  })
  expect(new Set(toolbarStroke.borderColors)).toEqual(new Set([toolbarStroke.expectedColor]))
  expect(new Set(toolbarStroke.borderWidths)).toEqual(new Set(['1px']))
  expect(toolbarStroke.afterContent).toBe('none')
  expect(toolbarStroke.afterAnimation).toBe('none')
  await page.screenshot({ path: testInfo.outputPath('notes-iridescent-toolbar.png'), fullPage: false })
})

test('moving the caret onto the final visual line scrolls fully to the page bottom', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop scroll behavior is covered here')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openNotesView(page)
  await page.getByRole('button', { name: '+ New note' }).click()

  const editor = page.locator('[data-note-text-input]').first()
  const workspace = page.locator('.note-document')
  await editor.fill(Array.from({ length: 80 }, (_, index) => `Caret scroll line ${index + 1}`).join('\n'))
  await workspace.evaluate((element) => element.scrollTo({ top: 0 }))
  await placeCaretOnLastLine(editor)

  await expect.poll(() => workspace.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeLessThanOrEqual(4)
})

test('Enter moves the caret into the newly created note line', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openNotesView(page)
  await page.getByRole('button', { name: '+ New note' }).click()

  const firstEditor = page.locator('[data-note-text-input]').first()
  const workspace = page.locator('.note-document')
  await firstEditor.fill(Array.from({ length: 80 }, (_, index) => `Enter focus line ${index + 1}`).join('\n'))
  await placeCaretAtEnd(firstEditor)
  await workspace.evaluate((element) => element.scrollTo({ top: 0 }))
  await firstEditor.press('Enter')
  await expect(page.locator('[data-note-text-input]')).toHaveCount(2)
  await expect.poll(() => page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll<HTMLElement>('[data-note-text-input]'))
    const selection = document.getSelection()
    const activeIndex = inputs.indexOf(document.activeElement as HTMLElement)
    const activeInput = inputs[activeIndex]
    if (!activeInput || !selection?.isCollapsed || !selection.focusNode || !activeInput.contains(selection.focusNode)) {
      return null
    }
    const before = document.createRange()
    before.selectNodeContents(activeInput)
    before.setEnd(selection.focusNode, selection.focusOffset)
    return { activeIndex, caretOffset: before.toString().length }
  })).toEqual({ activeIndex: 1, caretOffset: 0 })
  await expect.poll(() => workspace.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeLessThanOrEqual(4)
})

test('notes save adjustable breathing room and follow the final caret to the bottom', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop scroll behavior is covered here')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()

  const editor = page.locator('[data-note-text-input]').first()
  const workspace = page.locator('.note-document')
  const spacingSlider = page.getByLabel('Bottom writing space')
  await editor.fill(Array.from({ length: 80 }, (_, index) => `Long note line ${index + 1}`).join('\n'))
  await expect(editor).toHaveCSS('line-height', '25.5px')

  await expect(spacingSlider).toHaveAttribute('min', '0')
  await expect(spacingSlider).toHaveAttribute('max', '100')
  await expect(spacingSlider).toHaveValue('60')
  await expect(spacingSlider).toHaveAttribute('aria-valuetext', '31.2% of note area')

  const writingSpace = await page.locator('.note-scroll-space').evaluate((element) => {
    const spacer = element.getBoundingClientRect()
    const scroller = element.closest<HTMLElement>('.note-document')
    return {
      height: spacer.height,
      scrollerHeight: scroller?.clientHeight ?? 0,
      insideNoteDocument: Boolean(element.closest('.note-document')),
    }
  })
  expect(writingSpace.insideNoteDocument).toBe(true)
  expect(writingSpace.height / writingSpace.scrollerHeight).toBeGreaterThan(0.3)
  expect(writingSpace.height / writingSpace.scrollerHeight).toBeLessThan(0.32)

  await page.locator('.content-shell').evaluate((element) => {
    ;(element as HTMLElement).style.setProperty('--goal-history-height', '320px')
  })
  await expect.poll(() => page.locator('.note-scroll-space').evaluate((element) => {
    const scroller = element.closest<HTMLElement>('.note-document')
    return scroller ? element.getBoundingClientRect().height / scroller.clientHeight : 0
  })).toBeCloseTo(0.312, 2)
  const resizedSpaceHeight = await page.locator('.note-scroll-space').evaluate((element) => element.getBoundingClientRect().height)
  expect(resizedSpaceHeight).toBeLessThan(writingSpace.height)
  await page.locator('.content-shell').evaluate((element) => {
    ;(element as HTMLElement).style.removeProperty('--goal-history-height')
  })

  await workspace.evaluate((element) => element.scrollTo({ top: 0 }))
  const spacingControl = page.locator('.note-scroll-space-control')
  await expect(spacingControl).toHaveCSS('opacity', '0')
  await expect(spacingControl).toHaveCSS('visibility', 'hidden')
  await expect(spacingControl).toHaveCSS('transition-property', /opacity.*visibility/)

  await workspace.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(spacingControl).toHaveCSS('opacity', '1')
  await expect(spacingControl).toHaveCSS('visibility', 'visible')

  await workspace.evaluate((element) => element.scrollTo({ top: element.scrollTop - 20 }))
  await expect(spacingControl).toHaveCSS('opacity', '0')
  await expect(spacingControl).toHaveCSS('visibility', 'hidden')

  await workspace.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(spacingControl).toHaveCSS('opacity', '1')
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
    const control = document.querySelector('.note-scroll-space-control')?.getBoundingClientRect()
    return track && fill && thumb && control
      ? {
          trackLeft: track.left,
          thumbCenter: thumb.left + thumb.width / 2,
          thumbLeft: thumb.left,
          controlLeft: control.left,
          fillLeft: fill.left,
          fillWidth: fill.width,
        }
      : null
  })
  expect(startGeometry).not.toBeNull()
  expect(startGeometry?.thumbCenter).toBeCloseTo(startGeometry?.trackLeft ?? 0, 0)
  expect(startGeometry?.fillLeft).toBeCloseTo(startGeometry?.trackLeft ?? 0, 0)
  expect(startGeometry?.fillWidth).toBeCloseTo(0, 0)
  expect(startGeometry?.thumbLeft).toBeGreaterThanOrEqual(startGeometry?.controlLeft ?? Number.POSITIVE_INFINITY)

  const fixedControlBottom = await page.locator('.note-scroll-space-control').evaluate((element) => element.getBoundingClientRect().bottom)
  await spacingSlider.evaluate((element) => {
    const input = element as HTMLInputElement
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    input.value = '100'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  await expect(spacingSlider).toHaveValue('100')
  await expect(spacingSlider).toHaveAttribute('aria-valuetext', '49.2% of note area')
  await expect(spacingControl).toHaveClass(/visible/)
  await expect(spacingControl).toHaveCSS('opacity', '1')
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })))
  await expect.poll(() => workspace.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(4)
  await expect.poll(() => page.locator('.note-scroll-space-control').evaluate((element, expectedBottom) => (
    Math.abs(element.getBoundingClientRect().bottom - expectedBottom)
  ), fixedControlBottom)).toBeLessThanOrEqual(1)
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
  const pillGeometry = await page.evaluate(() => {
    const control = document.querySelector('.note-scroll-space-control')?.getBoundingClientRect()
    const thumb = document.querySelector('.note-scroll-space-thumb')?.getBoundingClientRect()
    return control && thumb
      ? {
          controlLeft: control.left,
          controlRight: control.right,
          controlWidth: control.width,
          thumbLeft: thumb.left,
          thumbRight: thumb.right,
        }
      : null
  })
  expect(pillGeometry).not.toBeNull()
  expect(pillGeometry?.controlWidth).toBeGreaterThan(330)
  expect(pillGeometry?.thumbLeft).toBeGreaterThanOrEqual(pillGeometry?.controlLeft ?? Number.POSITIVE_INFINITY)
  expect(pillGeometry?.thumbRight).toBeLessThanOrEqual(pillGeometry?.controlRight ?? Number.NEGATIVE_INFINITY)
  const maximumSpace = await page.locator('.note-scroll-space').evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scrollerHeight: element.closest<HTMLElement>('.note-document')?.clientHeight ?? 0,
  }))
  expect(maximumSpace.height / maximumSpace.scrollerHeight).toBeGreaterThan(0.49)
  expect(maximumSpace.height / maximumSpace.scrollerHeight).toBeLessThan(0.5)
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
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

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
  await openNotesView(page)
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Pocket note')
  await page.locator('[data-note-text-input]').first().fill(
    Array.from({ length: 80 }, (_, index) => `Mobile note line ${index + 1}`).join('\n'),
  )

  const viewport = page.viewportSize()
  const documentBox = await page.locator('.note-document').boundingBox()
  expect(documentBox?.x).toBeGreaterThanOrEqual(0)
  expect((documentBox?.x ?? 0) + (documentBox?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0)
  expect(documentBox?.width ?? 0).toBeGreaterThan((viewport?.width ?? 0) - 30)
  const toolbar = page.getByRole('toolbar', { name: 'Note formatting' })
  const mobileHeader = page.locator('.mobile-app-header')
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2))
  await expect.poll(async () => {
    const headerBox = await mobileHeader.boundingBox()
    const toolbarBox = await toolbar.boundingBox()
    return headerBox && toolbarBox
      ? toolbarBox.y >= headerBox.y + headerBox.height + 3
        && toolbarBox.y + toolbarBox.height <= (page.viewportSize()?.height ?? 0)
      : false
  }).toBe(true)
  const mobileToolbarTop = (await toolbar.boundingBox())?.y ?? -1
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.75))
  await expect.poll(async () => (await toolbar.boundingBox())?.y ?? -1).toBeCloseTo(mobileToolbarTop, 0)
  await expect(page.locator('.note-scroll-space-control')).toHaveCSS('display', 'none')
  await expect(page.locator('.goal-history-panel')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('notes-mobile-toolbar.png'), fullPage: false })
  await page.screenshot({ path: testInfo.outputPath('notes-mobile.png'), fullPage: true })

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('complementary', { name: 'Primary navigation drawer' })
    .getByRole('button', { name: 'Today', exact: true })
    .click()
  await expect(page.getByRole('region', { name: 'Goal history' })).toBeVisible()
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

test('notes restores its caret and scroll position after visiting another page', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openNotesView(page)
  await page.getByRole('button', { name: '+ New note' }).click()

  const noteText = page.locator('[data-note-text-input]').first()
  const content = Array.from({ length: 100 }, (_, index) => `Return to this exact note line ${index + 1}`).join(' ')
  await noteText.fill(content)
  await placeCaretAtOffset(noteText, 17)
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')))
  const savedScrollTop = await setNoteScrollTop(page, 240)
  expect(savedScrollTop).toBeGreaterThan(0)
  await expect.poll(() => noteSelectionEndpoints(page)).toMatchObject({
    anchor: { offset: 17 },
    focus: { offset: 17 },
  })

  await openPrimaryView(page, 'Day Templates')
  await expect(page.getByRole('heading', { name: 'Daily template' })).toBeVisible()
  await openNotesView(page)

  await expect(noteText).toBeFocused()
  await expect.poll(() => noteSelectionEndpoints(page)).toMatchObject({
    anchor: { offset: 17 },
    focus: { offset: 17 },
  })
  await expect.poll(() => noteScrollTop(page)).toBe(savedScrollTop)
})

test('binning a note happens immediately and remains undoable', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openNotesView(page)
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Temporary note')

  await page.locator('.note-actions').getByRole('button', { name: 'Bin it', exact: true }).click()
  await expect(page.getByLabel('Note title')).toHaveCount(0)
  await expect(page.locator('.notes-page-actions').getByRole('button', { name: 'Bin', exact: true })).toBeVisible()

  await page.keyboard.press('Meta+Z')
  await expect(page.getByLabel('Note title')).toHaveValue('Temporary note')
})

test('Bin keeps notes read-only, restores them, and supports immediate deletion', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openNotesView(page)
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Recoverable thought')
  await page.getByLabel('Note text').fill('Worth keeping after all')

  await page.locator('.note-actions').getByRole('button', { name: 'Bin it', exact: true }).click()
  await page.locator('.notes-page-actions').getByRole('button', { name: 'Bin', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Recoverable thought' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Permanently deleted in 30 days')
  await expect(page.locator('.note-readonly-blocks').getByText('Worth keeping after all')).toBeVisible()
  await expect(page.getByLabel('Note text')).toHaveCount(0)

  await page.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByLabel('Note title')).toHaveValue('Recoverable thought')
  await expect(page.locator('.notes-page-actions').getByRole('button', { name: 'Bin', exact: true })).toBeVisible()

  await page.locator('.note-actions').getByRole('button', { name: 'Bin it', exact: true }).click()
  await page.locator('.notes-page-actions').getByRole('button', { name: 'Bin', exact: true }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete now' }).click()
  await expect(page.getByRole('heading', { name: 'Bin is empty' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back to Notes' })).toBeVisible()

  await page.keyboard.press('Meta+Z')
  await expect(page.getByRole('heading', { name: 'Recoverable thought' })).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Empty Bin' }).click()
  await expect(page.getByRole('heading', { name: 'Bin is empty' })).toBeVisible()
  await page.keyboard.press('Meta+Z')
  await expect(page.getByRole('heading', { name: 'Recoverable thought' })).toBeVisible()
})

test('notes expire from Bin after 30 days', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await openNotesView(page)
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Old discarded note')

  await page.locator('.note-actions').getByRole('button', { name: 'Bin it', exact: true }).click()
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    state.notes[0].deletedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  await openNotesView(page)

  await expect(page.locator('.notes-page-actions').getByRole('button', { name: 'Bin', exact: true })).toBeVisible()
  await page.locator('.notes-page-actions').getByRole('button', { name: 'Bin', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Bin is empty' })).toBeVisible()
})
