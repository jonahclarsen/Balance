import { test, expect, flatten } from './harness'
import { imageHTML } from '../../src/lib/imageMarkup'

const image = imageHTML('a'.repeat(64), 100, 60, 'left')

test('image-only blocks allow typing and Enter after the image', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  note.items[0].html = image
  note.items[0].text = ''
  await harness.boot({ notes: [note] })
  await harness.block(note.items[0].id).locator('img[data-balance-image]').click()
  await harness.page.keyboard.press('ArrowRight')
  await harness.page.keyboard.type('After')
  await harness.waitForNote(note.id, (stored) => stored.items[0].html.endsWith('After'))
  await harness.page.keyboard.press('Enter')
  await harness.page.keyboard.type('Below')
  await harness.waitForNote(note.id, (stored) => stored.items[1].text === 'Below')
  expect((await harness.storedNote(note.id))!.items[0].html.match(/<img/g)).toHaveLength(1)
})

for (const location of ['middle', 'empty', 'end', 'multiple'] as const) {
  test(`pasting image files at ${location} inserts each once and keeps the caret after them`, async ({ harness }) => {
    const note = harness.noteByTitle('Simple paragraphs')
    if (location === 'empty') { note.items[0].html = ''; note.items[0].text = '' }
    const count = location === 'multiple' ? 2 : 1
    await harness.boot({ notes: [note] })
    await harness.placeCaret(note.items[0].id, location === 'empty' ? 0 : location === 'end' ? note.items[0].text.length : 5)
    await harness.editorRoot().evaluate(async (root, count) => {
      const canvas = document.createElement('canvas')
      canvas.width = 100; canvas.height = 60
      canvas.getContext('2d')!.fillRect(0, 0, 100, 60)
      const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
      const data = new DataTransfer()
      for (let i = 0; i < count; i++) data.items.add(new File([png], `synthetic-${i}.png`, { type: 'image/png' }))
      root.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    }, count)
    await expect(harness.editorRoot().locator('img[data-balance-image]')).toHaveCount(count)
    await harness.page.keyboard.type('After')
    await harness.waitForNote(note.id, (stored) => /<img[^>]*>After/.test(stored.items[0].html))
    expect((await harness.storedNote(note.id))!.items[0].html.match(/<img/g)).toHaveLength(count)
    await harness.undo()
    await harness.waitForNote(note.id, (stored) => !stored.items[0].text.includes('After'))
  })
}

test('multiblock paste immediately after an image keeps it in the original block once', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  note.items[0].html = `Before${image}Tail`
  note.items[0].text = 'BeforeTail'
  await harness.boot({ notes: [note] })
  await harness.block(note.items[0].id).locator('img[data-balance-image]').click()
  await harness.page.keyboard.press('ArrowRight')
  await harness.editorRoot().evaluate((root) => {
    const data = new DataTransfer()
    data.setData('text/plain', 'One\nTwo')
    root.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  })
  await harness.waitForNote(note.id, (stored) => stored.items[1].text === 'TwoTail')
  const stored = (await harness.storedNote(note.id))!
  expect(stored.items[0].html).toMatch(/<img[^>]*>One$/)
  expect(flatten(stored.items).flatMap((item) => item.html.match(/<img/g) ?? [])).toHaveLength(1)
})

test('clicking beside a floating image leaves a visible caret and keeps later blocks below it', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  note.items[0].html = image
  note.items[0].text = ''
  await harness.boot({ notes: [note] })
  const text = harness.block(note.items[0].id).locator('.note-text')
  await text.click({ position: { x: 140, y: 12 } })
  await harness.page.keyboard.type('Beside')
  await harness.waitForNote(note.id, (stored) => stored.items[0].html.endsWith('Beside'))
  const imageBox = await text.locator('img[data-balance-image]').boundingBox()
  const nextBox = await harness.block(note.items[1].id).boundingBox()
  expect(nextBox!.y).toBeGreaterThanOrEqual(imageBox!.y + imageBox!.height)
})

test('deleting a selected image preserves formatted surrounding text and supports undo', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  note.items[0].html = `<strong>Before</strong>${image}<em>After</em>`
  note.items[0].text = 'BeforeAfter'
  await harness.boot({ notes: [note] })
  await harness.block(note.items[0].id).locator('img[data-balance-image]').click()
  await harness.page.keyboard.press('Backspace')
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === '<strong>Before</strong><em>After</em>')
  await harness.undo()
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === note.items[0].html)
  await harness.page.reload()
  await harness.openNotesView()
  await expect(harness.editorRoot().locator('img[data-balance-image]')).toHaveCount(1)
})

test('moving an image within a note inserts it once without replacing surrounding text', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  note.items[0].html = `Before${image}After`
  note.items[0].text = 'BeforeAfter'
  await harness.boot({ notes: [note] })
  const source = harness.block(note.items[0].id).locator('img[data-balance-image]')
  const target = harness.block(note.items[1].id).locator('.note-text')
  await source.dragTo(target)
  await harness.waitForNote(note.id, (stored) => !stored.items[0].html.includes('<img') && stored.items[1].html.includes('<img'))
  const stored = (await harness.storedNote(note.id))!
  expect(stored.items[0].text).toBe('BeforeAfter')
  expect(stored.items[1].text).toBe(note.items[1].text)
  expect(flatten(stored.items).flatMap((item) => item.html.match(/<img/g) ?? [])).toHaveLength(1)
})

test('changing image layout preserves formatting and typing after the image', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  note.items[0].html = `<strong>Before</strong>${image}<em>After</em>`
  note.items[0].text = 'BeforeAfter'
  await harness.boot({ notes: [note] })
  await harness.block(note.items[0].id).locator('img[data-balance-image]').click()
  await harness.page.getByRole('button', { name: 'Inline', exact: true }).click()
  await harness.waitForNote(note.id, (stored) => stored.items[0].html.includes('data-image-layout="inline"'))
  await harness.block(note.items[0].id).locator('img[data-balance-image]').click()
  await harness.page.keyboard.press('ArrowRight')
  await harness.page.keyboard.type('Typed')
  await harness.waitForNote(note.id, (stored) => stored.items[0].text === 'BeforeTypedAfter')
  const stored = (await harness.storedNote(note.id))!
  expect(stored.items[0].html).toContain('<strong>Before</strong>')
  expect(stored.items[0].html).toContain('<em>')
  expect(stored.items[0].html.match(/<img/g)).toHaveLength(1)
})

test('cutting text and an image removes the complete selection and undo restores it', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  note.items[0].html = `<strong>Before</strong>${image}<em>After</em>`
  note.items[0].text = 'BeforeAfter'
  await harness.boot({ notes: [note] })
  await harness.block(note.items[0].id).locator('.note-text').evaluate((text) => {
    text.closest<HTMLElement>('[data-rich-text-input]')!.focus()
    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = document.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    text.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }))
  })
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === '')
  await harness.undo()
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === note.items[0].html)
})

test('resizing an image keeps the surrounding formatting and persists the dimensions', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  note.items[0].html = `<strong>Before</strong>${image}<em>After</em>`
  note.items[0].text = 'BeforeAfter'
  await harness.boot({ notes: [note] })
  await harness.block(note.items[0].id).locator('img[data-balance-image]').click()
  const handle = await harness.page.locator('.resize-handle.bottom-right').boundingBox()
  await harness.page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
  await harness.page.mouse.down()
  await harness.page.mouse.move(handle!.x + handle!.width / 2 + 40, handle!.y + handle!.height / 2 + 24)
  await harness.page.mouse.up()
  await harness.waitForNote(note.id, (stored) => !stored.items[0].html.includes('width="100"'))
  const stored = (await harness.storedNote(note.id))!
  const width = Number(stored.items[0].html.match(/width="(\d+)"/)?.[1])
  expect(width).toBeGreaterThan(100)
  expect(stored.items[0].html).toContain('<strong>Before</strong>')
  expect(stored.items[0].html).toContain('<em>After</em>')
  expect(stored.items[0].html.match(/<img/g)).toHaveLength(1)
  await harness.page.reload()
  await harness.openNotesView()
  await expect(harness.editorRoot().locator('img[data-balance-image]')).toHaveAttribute('width', String(width))
})
