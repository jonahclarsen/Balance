import { expect, test } from '@playwright/test'

test('notes support rich blocks, persistence, search, and app links from templates', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.getByLabel('Note title').fill('Project Brain')

  const firstBlock = page.locator('[data-note-text-input]').first()
  await firstBlock.fill('Reference material with formatted ideas')
  await page.locator('.note-kind').first().selectOption('heading')
  await expect(firstBlock).toHaveCSS('font-weight', '700')

  await page.getByRole('button', { name: '+ Checklist' }).click()
  const noteBlocks = page.locator('[data-note-text-input]')
  await expect(noteBlocks).toHaveCount(2)
  await noteBlocks.nth(1).fill('Ship the notes feature')
  await page.getByLabel('Mark checked').check()
  await expect(page.locator('.note-done')).toContainText('Ship the notes feature')

  await page.getByRole('button', { name: 'Copy note link' }).click()
  await expect(page.getByText('Note link copied')).toBeVisible()
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

  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByLabel('Note title')).toHaveValue('Project Brain')
  await expect(page.locator('.note-done')).toContainText('Ship the notes feature')
  if (testInfo.project.name === 'desktop') {
    await page.screenshot({ path: testInfo.outputPath('notes-desktop.png'), fullPage: true })
  }

  await page.getByRole('button', { name: /Search/ }).click()
  await page.getByRole('searchbox', { name: 'Search everything' }).fill('formatted ideas')
  const searchDialog = page.getByRole('dialog', { name: 'Search Balance' })
  await expect(searchDialog.getByRole('heading', { name: /Notes/ })).toBeVisible()
  await searchDialog.getByRole('button', { name: /Project Brain/ }).click()
  await expect(page.getByLabel('Note title')).toHaveValue('Project Brain')
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

    input.innerHTML = 'Draft note<span></span>'
    const range = document.createRange()
    range.setStart(input.firstChild as Node, 5)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    input.blur()
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
    .toBe(5)
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
