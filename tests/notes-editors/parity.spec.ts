// Parity conformance: every user-facing behavior of the Notes body editor from
// docs/notes-contract.md (P-xx ids) that a rebuilt editor must reproduce.
// Runs identically against every editor project.

import { expect, flatten, mod, test, type Harness } from './harness'
import type { NoteItem } from '../../src/lib/types'

const isMac = process.platform === 'darwin'

async function kindClassOf(harness: Harness, itemId: string) {
  return harness.block(itemId).evaluate((element) => {
    const row = (element.closest('.note-item') ?? element) as HTMLElement
    return {
      classes: row.className,
      kind: row.dataset.kind ?? element.getAttribute('data-kind'),
      number: row.dataset.noteItemNumber ?? null,
      depth: row.dataset.noteItemDepth ?? null,
    }
  })
}

function textOf(items: NoteItem[], id: string) {
  return flatten(items).find((item) => item.id === id)?.text
}

async function pasteInto(harness: Harness, itemId: string, offset: number, data: { text?: string; html?: string }, end = offset) {
  await harness.placeCaret(itemId, offset, end)
  await harness.page.evaluate(([plain, html]) => {
    const target = document.activeElement as HTMLElement
    const clipboardData = new DataTransfer()
    if (plain != null) clipboardData.setData('text/plain', plain)
    if (html != null) clipboardData.setData('text/html', html)
    target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  }, [data.text ?? null, data.html ?? null] as const)
}

async function copySelection(harness: Harness): Promise<{ text: string; html: string; handled: boolean }> {
  return harness.page.evaluate(() => {
    const target = document.activeElement as HTMLElement
    const clipboardData = new DataTransfer()
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData })
    target.dispatchEvent(event)
    return { text: clipboardData.getData('text/plain'), html: clipboardData.getData('text/html'), handled: event.defaultPrevented }
  })
}

// ---------------------------------------------------------------------------
// B. Blocks and rendering
// ---------------------------------------------------------------------------

test.describe('P-12/13/14 rendering', () => {
  test('every kind renders with its parity classes, depth and numbering', async ({ harness }) => {
    await harness.boot({ select: 'Nested lists' })
    const note = harness.noteByTitle('Nested lists')
    const [groceries, apples, bread, sourdough, rye, errands, stepOne, subA, subB, stepTwo, stepThree, para, restart] = flatten(note.items)
    expect((await kindClassOf(harness, groceries.id)).classes).toMatch(/note-bullet/)
    expect((await kindClassOf(harness, sourdough.id)).depth).toBe('2')
    expect((await kindClassOf(harness, apples.id)).depth).toBe('1')
    expect((await kindClassOf(harness, stepOne.id)).number).toBe('1')
    expect((await kindClassOf(harness, subA.id)).number).toBe('1')
    expect((await kindClassOf(harness, subB.id)).number).toBe('2')
    expect((await kindClassOf(harness, stepTwo.id)).number).toBe('2')
    expect((await kindClassOf(harness, stepThree.id)).number).toBe('3')
    // A non-numbered sibling restarts the count.
    expect((await kindClassOf(harness, restart.id)).number).toBe('1')
    expect((await kindClassOf(harness, para.id)).classes).not.toMatch(/note-list-item/)
    void bread; void rye; void errands
  })

  test('headings, quotes and checklists carry their classes and done state', async ({ harness }) => {
    await harness.boot({ select: 'Checklist' })
    const note = harness.noteByTitle('Checklist')
    expect((await kindClassOf(harness, note.items[0].id)).classes).toMatch(/note-done/)
    expect((await kindClassOf(harness, note.items[1].id)).classes).not.toMatch(/note-done/)
    await expect(harness.block(note.items[0].id).locator('..').getByRole('checkbox', { name: 'Mark unchecked' }).or(harness.block(note.items[0].id).getByRole('checkbox', { name: 'Mark unchecked' })).first()).toBeVisible()
    await harness.selectNote('Headings and quotes')
    const hq = harness.noteByTitle('Headings and quotes')
    expect((await kindClassOf(harness, hq.items[0].id)).classes).toMatch(/note-heading/)
    expect((await kindClassOf(harness, hq.items[2].id)).classes).toMatch(/note-quote/)
    const fontSize = await harness.block(hq.items[0].id).evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
    const bodySize = await harness.block(hq.items[1].id).evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
    expect(fontSize).toBeGreaterThan(bodySize)
  })

  test('inline formatting and links render and survive a no-op focus', async ({ harness }) => {
    await harness.boot({ select: 'Links' })
    const note = harness.noteByTitle('Links')
    await expect(harness.block(note.items[0].id).locator('a[href="https://example.com/path?q=1&r=2"]')).toHaveText('example.com')
    await expect(harness.block(note.items[1].id).locator('a strong')).toHaveText('Bold link')
    await harness.selectNote('Simple paragraphs')
    const simple = harness.noteByTitle('Simple paragraphs')
    await expect(harness.block(simple.items[1].id).locator('strong')).toHaveText('bold')
    await expect(harness.block(simple.items[1].id).locator('em')).toHaveText('italic')
    await expect(harness.block(simple.items[1].id).locator('u')).toHaveText('underlined')
    await expect(harness.block(simple.items[2].id).locator('br')).toHaveCount(1)
  })

  test('P-15 empty block shows a placeholder when focused', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const empty = note.items[3]
    await harness.placeCaret(empty.id, 0)
    const placeholder = await harness.block(empty.id).evaluate((element) => {
      const candidates = [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))]
      for (const candidate of candidates) {
        const own = candidate.getAttribute('data-placeholder')
        if (own) return own
        const before = getComputedStyle(candidate, '::before').content
        if (before && before !== 'none' && before !== '""') return before
      }
      return null
    })
    expect(placeholder).toMatch(/Type \/ for styles/)
  })

  test('P-16 an empty note offers "Start writing…" and creates the first block', async ({ harness }) => {
    await harness.boot({ select: 'Empty note' })
    const note = harness.noteByTitle('Empty note')
    await harness.page.getByRole('button', { name: 'Start writing…' }).click()
    await harness.waitForNote(note.id, (stored) => stored.items.length === 1 && stored.items[0].kind === 'paragraph')
    const stored = (await harness.storedNote(note.id))!
    await expect(harness.block(stored.items[0].id)).toBeVisible()
    await harness.page.keyboard.type('Hello')
    await harness.waitForNote(note.id, (current) => current.items[0].text === 'Hello')
  })
})

// ---------------------------------------------------------------------------
// C. Keyboard inside a block
// ---------------------------------------------------------------------------

test.describe('P-21 Enter', () => {
  test('Enter in an empty list block converts it to a paragraph in place', async ({ harness }) => {
    await harness.boot({ select: 'Nested lists' })
    const note = harness.noteByTitle('Nested lists')
    const errands = note.items[1]
    await harness.placeCaret(errands.id, errands.text.length)
    await harness.page.keyboard.press('Enter')
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length + 1)
    let stored = (await harness.storedNote(note.id))!
    const created = stored.items[2]
    expect(created.kind).toBe('bullet')
    expect(created.text).toBe('')
    await harness.page.keyboard.press('Enter')
    await harness.waitForNote(note.id, (current) => current.items[2].kind === 'paragraph')
    stored = (await harness.storedNote(note.id))!
    expect(stored.items[2].id).toBe(created.id)
    expect(stored.items.length).toBe(note.items.length + 1)
    expect(await harness.caretItemId()).toBe(created.id)
  })

  test('Enter at the end of a heading continues as a paragraph; a bullet continues as a bullet keeping children', async ({ harness }) => {
    await harness.boot({ select: 'Headings and quotes' })
    const note = harness.noteByTitle('Headings and quotes')
    await harness.placeCaret(note.items[0].id, note.items[0].text.length)
    await harness.page.keyboard.press('Enter')
    await harness.page.keyboard.type('body')
    await harness.waitForNote(note.id, (stored) => stored.items[1]?.text === 'body' && stored.items[1].kind === 'paragraph')

    await harness.selectNote('Nested lists')
    const lists = harness.noteByTitle('Nested lists')
    const groceries = lists.items[0]
    await harness.placeCaret(groceries.id, groceries.text.length)
    await harness.page.keyboard.press('Enter')
    await harness.page.keyboard.type('Snacks')
    await harness.waitForNote(lists.id, (stored) => stored.items[1]?.text === 'Snacks')
    const stored = (await harness.storedNote(lists.id))!
    expect(stored.items[1].kind).toBe('bullet')
    // Children stayed with the original block; the new block comes after the subtree.
    expect(stored.items[0].children.map((child) => child.id)).toEqual(groceries.children.map((child) => child.id))
    expect(stored.items[1].children).toEqual([])
  })

  test('Enter with a selection inside a block deletes it and splits; formatting survives on both halves', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const target = note.items[1] // Second paragraph with <strong>bold</strong>, <em>italic</em>...
    // Select "with " (offsets 17..22) then Enter.
    await harness.placeCaret(target.id, 17, 22)
    await harness.page.keyboard.press('Enter')
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length + 1)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items[1].text).toBe('Second paragraph ')
    expect(stored.items[2].text).toBe('bold, italic, and underlined runs.')
    expect(stored.items[2].html).toContain('<strong>bold</strong>')
    expect(stored.items[2].html).toContain('<em>italic</em>')
  })

  test('P-22 Shift+Enter inserts a soft line break inside the block', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const target = note.items[0]
    await harness.placeCaret(target.id, 5)
    await harness.page.keyboard.press('Shift+Enter')
    await harness.page.keyboard.type('X')
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length && /First(<br>|\n)X paragraph/.test(stored.items[0].html))
  })
})

test.describe('P-23/24/25 Backspace and Delete', () => {
  test('Backspace at the start of a list block first converts it to a paragraph, then merges', async ({ harness }) => {
    await harness.boot({ select: 'Nested lists' })
    const note = harness.noteByTitle('Nested lists')
    const errands = note.items[1]
    await harness.placeCaret(errands.id, 0)
    await harness.page.keyboard.press('Backspace')
    await harness.waitForNote(note.id, (stored) => stored.items[1].kind === 'paragraph' && stored.items[1].id === errands.id)
    await harness.page.keyboard.press('Backspace')
    // Previous in visual order is "Rye" (deepest last descendant of Groceries).
    await harness.waitForNote(note.id, (stored) => flatten(stored.items).some((item) => item.text === 'RyeErrands'))
    const stored = (await harness.storedNote(note.id))!
    const rye = flatten(stored.items).find((item) => item.text === 'RyeErrands')!
    expect(rye.kind).toBe('bullet')
    expect(flatten(stored.items).some((item) => item.id === errands.id)).toBe(false)
    expect(await harness.caretItemId()).toBe(rye.id)
    expect(await harness.caretOffset()).toBe('Rye'.length)
  })

  test('Backspace at the start of a paragraph after an empty block deletes the empty block', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const after = note.items[4]
    await harness.placeCaret(after.id, 0)
    await harness.page.keyboard.press('Backspace')
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length - 1)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items.map((item) => item.id)).toEqual([note.items[0].id, note.items[1].id, note.items[2].id, after.id])
    expect(stored.items[3].text).toBe(after.text)
    expect(await harness.caretItemId()).toBe(after.id)
    expect(await harness.caretOffset()).toBe(0)
  })

  test('Backspace on the first, empty block with others present removes it and focuses the next block', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    await harness.placeCaret(note.items[0].id, 0)
    await harness.page.keyboard.press('Enter') // insert an empty paragraph above (P-21 case 3)
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length + 1 && stored.items[0].text === '')
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items[1].id).toBe(note.items[0].id)
    await harness.placeCaret(stored.items[0].id, 0)
    await harness.page.keyboard.press('Backspace')
    await harness.waitForNote(note.id, (current) => current.items.length === note.items.length)
    expect(await harness.caretItemId()).toBe(note.items[0].id)
  })

  test('Backspace on the only, empty block keeps a single empty paragraph', async ({ harness }) => {
    await harness.boot({ select: 'Untitled note' })
    const note = harness.corpus.find((candidate) => candidate.title === '')!
    await harness.placeCaret(note.items[0].id, 0, note.items[0].text.length)
    await harness.page.keyboard.press('Backspace')
    await harness.waitForNote(note.id, (stored) => stored.items.length === 1 && stored.items[0].text === '')
    await harness.page.keyboard.press('Backspace')
    await harness.page.waitForTimeout(200)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items.length).toBe(1)
    expect(stored.items[0].kind).toBe('paragraph')
    await harness.page.keyboard.type('still here')
    await harness.waitForNote(note.id, (current) => current.items[0].text === 'still here')
  })

  test('Delete at the end of a block merges the next block into it', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const first = note.items[0]
    await harness.placeCaret(first.id, first.text.length)
    await harness.page.keyboard.press('Delete')
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length - 1)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items[0].id).toBe(first.id)
    expect(stored.items[0].text).toBe(`${first.text}${note.items[1].text}`)
    expect(stored.items[0].html).toContain('<strong>bold</strong>')
    expect(await harness.caretOffset()).toBe(first.text.length)
  })

  test('Delete at the end of the last block does nothing', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const last = note.items[note.items.length - 1]
    await harness.placeCaret(last.id, last.text.length)
    await harness.page.keyboard.press('Delete')
    await harness.page.waitForTimeout(300)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items.length).toBe(note.items.length)
    expect(stored.items[note.items.length - 1].text).toBe(last.text)
  })
})

test.describe('P-26/27 indent, outdent, move', () => {
  test('Tab nests a block as the last child of the previous same-depth row; Shift+Tab outdents and adopts following siblings', async ({ harness }) => {
    await harness.boot({ select: 'Nested lists' })
    const note = harness.noteByTitle('Nested lists')
    const stepTwo = note.items[3]
    await harness.placeCaret(stepTwo.id, 4)
    await harness.page.keyboard.press('Tab')
    await harness.waitForNote(note.id, (stored) => stored.items[2].children.at(-1)?.id === stepTwo.id)
    expect(await harness.caretItemId()).toBe(stepTwo.id)
    expect(await harness.caretOffset()).toBe(4)
    // Focus must not have left the editor.
    expect(await harness.page.evaluate(() => document.activeElement?.closest('[data-rich-text-input]') !== null)).toBe(true)

    // Outdent "Sub-step a": it moves after its parent and adopts following siblings (Sub-step b, Step two).
    const subA = note.items[2].children[0]
    await harness.placeCaret(subA.id, 2)
    await harness.page.keyboard.press('Shift+Tab')
    await harness.waitForNote(note.id, (stored) => stored.items[3]?.id === subA.id)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items[3].children.map((child) => child.id)).toEqual([note.items[2].children[1].id, stepTwo.id])
    expect(stored.items[2].children).toEqual([])
    expect(await harness.caretItemId()).toBe(subA.id)
    expect(await harness.caretOffset()).toBe(2)
  })

  test('Tab on the first block does nothing; Shift+Tab on a top-level list converts it to a paragraph, on a top-level paragraph nothing', async ({ harness }) => {
    await harness.boot({ select: 'Nested lists' })
    const note = harness.noteByTitle('Nested lists')
    await harness.placeCaret(note.items[0].id, 1)
    await harness.page.keyboard.press('Tab')
    await harness.page.waitForTimeout(250)
    expect(flatten((await harness.storedNote(note.id))!.items).map((item) => item.id)).toEqual(flatten(note.items).map((item) => item.id))
    await harness.page.keyboard.press('Shift+Tab')
    await harness.waitForNote(note.id, (stored) => stored.items[0].kind === 'paragraph' && stored.items[0].id === note.items[0].id)
    expect(await harness.caretOffset()).toBe(1)
    await harness.page.keyboard.press('Shift+Tab')
    await harness.page.waitForTimeout(250)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items[0].kind).toBe('paragraph')
    expect(stored.items.length).toBe(note.items.length)
  })

  test('Alt+Up / Alt+Down swap a block with its sibling within the level and land the caret at its end', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const second = note.items[1]
    await harness.placeCaret(second.id, 3)
    await harness.page.keyboard.press('Alt+ArrowUp')
    await harness.waitForNote(note.id, (stored) => stored.items[0].id === second.id)
    expect(await harness.caretItemId()).toBe(second.id)
    expect(await harness.caretOffset()).toBe(second.text.length)
    await harness.page.keyboard.press('Alt+ArrowUp')
    await harness.page.waitForTimeout(250)
    expect((await harness.storedNote(note.id))!.items[0].id).toBe(second.id)
    await harness.page.keyboard.press('Alt+ArrowDown')
    await harness.waitForNote(note.id, (stored) => stored.items[1].id === second.id && stored.items[0].id === note.items[0].id)
  })
})

test.describe('P-28 arrow navigation', () => {
  test('Down/Up move between blocks at boundaries; Left/Right cross block edges', async ({ harness }) => {
    await harness.boot({ select: 'Headings and quotes' })
    const note = harness.noteByTitle('Headings and quotes')
    await harness.placeCaret(note.items[0].id, 2)
    await harness.page.keyboard.press('ArrowDown')
    await expect.poll(() => harness.caretItemId()).toBe(note.items[1].id)
    await harness.page.keyboard.press('ArrowUp')
    await expect.poll(() => harness.caretItemId()).toBe(note.items[0].id)
    await harness.placeCaret(note.items[1].id, 0)
    await harness.page.keyboard.press('ArrowLeft')
    await expect.poll(() => harness.caretItemId()).toBe(note.items[0].id)
    expect(await harness.caretOffset()).toBe(note.items[0].text.length)
    await harness.page.keyboard.press('ArrowRight')
    await expect.poll(() => harness.caretItemId()).toBe(note.items[1].id)
    expect(await harness.caretOffset()).toBe(0)
  })

  test('Down from the last block and Up from the first block stay put without errors', async ({ harness }) => {
    await harness.boot({ select: 'Headings and quotes' })
    const note = harness.noteByTitle('Headings and quotes')
    const last = note.items[note.items.length - 1]
    await harness.placeCaret(last.id, 2)
    await harness.page.keyboard.press('ArrowDown')
    await harness.page.waitForTimeout(100)
    expect(await harness.caretItemId()).toBe(last.id)
    await harness.placeCaret(note.items[0].id, 2)
    await harness.page.keyboard.press('ArrowUp')
    await harness.page.waitForTimeout(100)
    expect(await harness.caretItemId()).toBe(note.items[0].id)
  })
})

test.describe('P-29 inline formatting', () => {
  test('Mod+B/I/U toggle marks on a selection and are true toggles', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const target = note.items[0]
    await harness.placeCaret(target.id, 0, 5)
    await harness.page.keyboard.press(`${mod}+b`)
    await harness.waitForNote(note.id, (stored) => stored.items[0].html === '<strong>First</strong> paragraph with plain text.')
    await harness.page.keyboard.press(`${mod}+i`)
    await harness.waitForNote(note.id, (stored) => /<(strong|em)><(strong|em)>First<\/(strong|em)><\/(strong|em)> paragraph/.test(stored.items[0].html))
    await harness.page.keyboard.press(`${mod}+u`)
    await harness.waitForNote(note.id, (stored) => stored.items[0].html.includes('<u>'))
    await harness.page.keyboard.press(`${mod}+b`)
    await harness.page.keyboard.press(`${mod}+i`)
    await harness.page.keyboard.press(`${mod}+u`)
    await harness.waitForNote(note.id, (stored) => stored.items[0].html === target.html)
    // Toolbar state reflects the selection.
    await harness.placeCaret(note.items[1].id, 'Second paragraph with '.length + 1, 'Second paragraph with '.length + 2)
    await expect(harness.page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
    await expect(harness.page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('toolbar Bold applies to the remembered selection', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    await harness.placeCaret(note.items[0].id, 6, 15)
    await harness.page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Bold' }).click()
    await harness.waitForNote(note.id, (stored) => stored.items[0].html === 'First <strong>paragraph</strong> with plain text.')
    await harness.page.getByRole('toolbar', { name: 'Note formatting' }).getByRole('button', { name: 'Bold' }).click()
    await harness.waitForNote(note.id, (stored) => stored.items[0].html === note.items[0].html)
  })
})

test.describe('P-30 markdown autoformat', () => {
  for (const [marker, kind] of [['# ', 'heading'], ['> ', 'quote'], ['- ', 'bullet'], ['* ', 'bullet'], ['1. ', 'numbered'], ['[] ', 'checklist'], ['[ ] ', 'checklist']] as const) {
    test(`typing "${marker}" at the start of an empty paragraph makes a ${kind}`, async ({ harness }) => {
      await harness.boot({ select: 'Simple paragraphs' })
      const note = harness.noteByTitle('Simple paragraphs')
      const empty = note.items[3]
      await harness.placeCaret(empty.id, 0)
      await harness.page.keyboard.type(marker)
      await harness.waitForNote(note.id, (stored) => stored.items[3].kind === kind && stored.items[3].text === '' && stored.items[3].id === empty.id)
      await harness.page.keyboard.type('after')
      await harness.waitForNote(note.id, (stored) => stored.items[3].text === 'after' && stored.items[3].kind === kind)
      expect(await harness.caretItemId()).toBe(empty.id)
    })
  }

  test('a marker typed before existing text converts the block and keeps the text', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const target = note.items[0]
    await harness.placeCaret(target.id, 0)
    await harness.page.keyboard.type('- ')
    await harness.waitForNote(note.id, (stored) => stored.items[0].kind === 'bullet' && stored.items[0].text === target.text)
    expect(await harness.caretOffset()).toBe(0)
  })

  test('"1. " inside a heading stays literal text', async ({ harness }) => {
    await harness.boot({ select: 'Headings and quotes' })
    const note = harness.noteByTitle('Headings and quotes')
    await harness.placeCaret(note.items[0].id, 0, note.items[0].text.length)
    await harness.page.keyboard.type('1. ')
    await harness.waitForNote(note.id, (stored) => stored.items[0].text.startsWith('1. '))
    expect((await harness.storedNote(note.id))!.items[0].kind).toBe('heading')
  })
})

test.describe('P-31 slash menu', () => {
  test('typing / opens the styles menu, filters, and applies with Enter', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const empty = note.items[3]
    await harness.placeCaret(empty.id, 0)
    await harness.page.keyboard.type('/')
    const menu = harness.page.getByRole('listbox', { name: 'Note styles' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('option')).toHaveCount(6)
    await harness.page.keyboard.type('li')
    await expect(menu.getByRole('option')).toHaveCount(3)
    await harness.page.keyboard.press('ArrowDown')
    await harness.page.keyboard.press('Enter')
    await harness.waitForNote(note.id, (stored) => stored.items[3].kind === 'numbered' && stored.items[3].text === '')
    await expect(menu).toBeHidden()
    expect(await harness.caretItemId()).toBe(empty.id)
    // Escape leaves the query as literal text.
    await harness.page.keyboard.type('/h')
    await expect(menu).toBeVisible()
    await harness.page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await harness.waitForNote(note.id, (stored) => stored.items[3].text === '/h')
  })

  test('the slash menu stays inside the viewport', async ({ harness }) => {
    await harness.boot({ select: 'Long note' })
    const note = harness.noteByTitle('Long note')
    const last = flatten(note.items).at(-1)!
    await harness.block(last.id).scrollIntoViewIfNeeded()
    await harness.placeCaret(last.id, last.text.length)
    await harness.page.keyboard.press('Enter')
    await harness.page.keyboard.type('/')
    const menu = harness.page.getByRole('listbox', { name: 'Note styles' })
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!
    const viewport = harness.page.viewportSize()!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    await harness.page.keyboard.press('Escape')
  })
})

test.describe('P-32 toolbar kind buttons', () => {
  test('kind buttons set the focused block kind and are not toggles; the checklist keeps done only when staying a checklist', async ({ harness }) => {
    await harness.boot({ select: 'Checklist' })
    const note = harness.noteByTitle('Checklist')
    const toolbar = harness.page.getByRole('toolbar', { name: 'Note formatting' })
    const done = note.items[0]
    await harness.placeCaret(done.id, 2)
    await expect(toolbar.getByRole('button', { name: 'Checklist' })).toHaveClass(/active/)
    await toolbar.getByRole('button', { name: 'Bulleted list' }).click()
    await harness.waitForNote(note.id, (stored) => stored.items[0].kind === 'bullet' && stored.items[0].done === false)
    await toolbar.getByRole('button', { name: 'Bulleted list' }).click()
    await harness.page.waitForTimeout(200)
    expect((await harness.storedNote(note.id))!.items[0].kind).toBe('bullet')
    await toolbar.getByRole('button', { name: 'Checklist' }).click()
    await harness.waitForNote(note.id, (stored) => stored.items[0].kind === 'checklist' && stored.items[0].done === false)
    await toolbar.getByRole('button', { name: 'Heading' }).click()
    await harness.waitForNote(note.id, (stored) => stored.items[0].kind === 'heading')
    await toolbar.getByRole('button', { name: 'Quote' }).click()
    await harness.waitForNote(note.id, (stored) => stored.items[0].kind === 'quote')
    await toolbar.getByRole('button', { name: 'Numbered list' }).click()
    await harness.waitForNote(note.id, (stored) => stored.items[0].kind === 'numbered')
    await toolbar.getByRole('button', { name: 'Text' }).click()
    await harness.waitForNote(note.id, (stored) => stored.items[0].kind === 'paragraph')
    expect(await harness.caretItemId()).toBe(done.id)
    // A kind change is its own undo step.
    await harness.undo()
    await harness.waitForNote(note.id, (stored) => stored.items[0].kind === 'numbered')
  })
})

test.describe('P-17 checklist toggling', () => {
  test('clicking a checkbox toggles it and cascades to descendants and ancestors', async ({ harness }) => {
    await harness.boot({ select: 'Checklist' })
    const note = harness.noteByTitle('Checklist')
    const parent = note.items[2]
    const [childOne, childTwo] = parent.children
    const row = (id: string) => harness.page.locator(`[data-note-item-id="${id}"]`).first()
    await row(parent.id).getByRole('checkbox').first().click()
    await harness.waitForNote(note.id, (stored) => stored.items[2].done && stored.items[2].children.every((child) => child.kind !== 'checklist' || child.done))
    await row(childTwo.id).getByRole('checkbox').first().click()
    await harness.waitForNote(note.id, (stored) => !stored.items[2].done && !stored.items[2].children[1].done && stored.items[2].children[0].done)
    await row(childTwo.id).getByRole('checkbox').first().click()
    await harness.waitForNote(note.id, (stored) => stored.items[2].done)
    void childOne
    // Space on a focused checkbox toggles natively.
    await row(note.items[1].id).getByRole('checkbox').first().focus()
    await harness.page.keyboard.press('Space')
    await harness.waitForNote(note.id, (stored) => stored.items[1].done)
    // Done items are not reordered.
    expect((await harness.storedNote(note.id))!.items.map((item) => item.id)).toEqual(note.items.map((item) => item.id))
    // Mod+D does nothing in Notes.
    await harness.placeCaret(note.items[1].id, 0)
    await harness.page.keyboard.press(`${mod}+d`)
    await harness.page.waitForTimeout(200)
    expect((await harness.storedNote(note.id))!.items[1].done).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// D. Multi-block selection
// ---------------------------------------------------------------------------

test.describe('P-33/34/38/39 selection across blocks', () => {
  test('Mod+A selects the block, Mod+A again selects every block; Backspace then empties the note', async ({ harness }) => {
    await harness.boot({ select: 'Headings and quotes' })
    const note = harness.noteByTitle('Headings and quotes')
    await harness.placeCaret(note.items[1].id, 3)
    await harness.page.keyboard.press(`${mod}+a`)
    const selected = await harness.page.evaluate(() => document.getSelection()?.toString() ?? '')
    expect(selected).toBe(note.items[1].text)
    await harness.page.keyboard.press(`${mod}+a`)
    await harness.page.keyboard.press('Backspace')
    await harness.waitForNote(note.id, (stored) => stored.items.length <= 1 && (stored.items[0]?.text ?? '') === '')
  })

  test('Shift+Down extends across blocks and typing replaces the range into the start block', async ({ harness }) => {
    await harness.boot({ select: 'Headings and quotes' })
    const note = harness.noteByTitle('Headings and quotes')
    const para = note.items[1] // "A paragraph under the heading."
    await harness.placeCaret(para.id, 2)
    await harness.page.keyboard.press('Shift+ArrowDown')
    await harness.page.keyboard.press('Shift+ArrowDown')
    await harness.page.keyboard.type('X')
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length - 2)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items[1].id).toBe(para.id)
    expect(stored.items[1].text.startsWith('A X')).toBe(true)
    expect(stored.items[2].kind).toBe('heading')
  })

  test('Escape collapses a cross-block selection; a mouse drag across list rows selects whole rows and Backspace deletes their subtrees', async ({ harness }) => {
    await harness.boot({ select: 'Nested lists' })
    const note = harness.noteByTitle('Nested lists')
    const groceries = note.items[0]
    const errands = note.items[1]
    // Measure each row's own text line: a row element also contains its
    // nested children, so its box center can land on a child.
    const ownLine = (id: string) => harness.block(id).evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const node = walker.nextNode()
      if (!node) throw new Error('row has no text')
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = range.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
    const from = await ownLine(groceries.id)
    const to = await ownLine(errands.id)
    await harness.page.mouse.move(from.x + 12, from.y + from.height / 2)
    await harness.page.mouse.down()
    await harness.page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 8 })
    await harness.page.mouse.up()
    await harness.page.waitForTimeout(150)
    await harness.page.keyboard.press('Escape')
    await harness.page.waitForTimeout(100)
    expect(await harness.page.evaluate(() => document.getSelection()?.isCollapsed ?? true)).toBe(true)
    // Select again and delete.
    await harness.page.mouse.move(from.x + 12, from.y + from.height / 2)
    await harness.page.mouse.down()
    await harness.page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 8 })
    await harness.page.mouse.up()
    await harness.page.waitForTimeout(1200)
    await harness.page.keyboard.press('Backspace')
    await harness.waitForNote(note.id, (stored) => !flatten(stored.items).some((item) => item.id === groceries.children[0].id))
    const stored = (await harness.storedNote(note.id))!
    expect(flatten(stored.items).some((item) => item.id === errands.id)).toBe(false)
    expect(stored.items.some((item) => item.id === note.items[2].id)).toBe(true)
  })

  test('undo restores a range replacement in one step', async ({ harness }) => {
    await harness.boot({ select: 'Headings and quotes' })
    const note = harness.noteByTitle('Headings and quotes')
    await harness.placeCaret(note.items[1].id, 2)
    await harness.page.keyboard.press('Shift+ArrowDown')
    await harness.page.keyboard.press('Backspace')
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length - 1)
    await harness.page.waitForTimeout(1300)
    await harness.undo()
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length && stored.items[1].text === note.items[1].text && stored.items[2].text === note.items[2].text)
    expect(flatten((await harness.storedNote(note.id))!.items).map((item) => item.id)).toEqual(flatten(note.items).map((item) => item.id))
  })
})

// ---------------------------------------------------------------------------
// E. Clipboard
// ---------------------------------------------------------------------------

test.describe('P-40..P-45 clipboard', () => {
  test('pasting two plain lines into the middle of a block splits around them', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const target = note.items[0]
    await pasteInto(harness, target.id, 5, { text: 'One\nTwo' })
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length + 1)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items[0].id).toBe(target.id)
    expect(stored.items[0].text).toBe('FirstOne')
    expect(stored.items[1].text).toBe('Two paragraph with plain text.')
    expect(await harness.caretItemId()).toBe(stored.items[1].id)
    expect(await harness.caretOffset()).toBe(3)
    // Paste is its own undo step.
    await harness.undo()
    await harness.waitForNote(note.id, (current) => current.items.length === note.items.length && current.items[0].text === target.text)
  })

  test('pasting HTML lists, headings and checklists creates the matching blocks', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const empty = note.items[3]
    await pasteInto(harness, empty.id, 0, {
      html: '<h1>Title</h1><ul><li>Alpha</li><li>☑ Done thing</li><li>Beta<ul><li>Nested</li></ul></li></ul><ol><li>One</li></ol><blockquote>Quoted</blockquote>',
      text: 'Title\nAlpha\n☑ Done thing\nBeta\nNested\nOne\nQuoted',
    })
    await harness.waitForNote(note.id, (stored) => stored.items.length >= note.items.length + 5)
    const stored = (await harness.storedNote(note.id))!
    const pasted = stored.items.slice(3, 3 + 6)
    expect(pasted[0].id).toBe(empty.id)
    expect(pasted.map((item) => item.kind)).toEqual(['heading', 'bullet', 'checklist', 'bullet', 'numbered', 'quote'])
    expect(pasted[2].done).toBe(true)
    expect(pasted[2].text).toBe('Done thing')
    expect(pasted[3].children.map((child) => child.text)).toEqual(['Nested'])
  })

  test('pasting checklist plain text creates checklists with states and nesting', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const empty = note.items[3]
    await pasteInto(harness, empty.id, 0, { text: '☐ Alpha\n  ☑ Beta\n☐ Gamma' })
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length + 1)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items[3].kind).toBe('checklist')
    expect(stored.items[3].text).toBe('Alpha')
    expect(stored.items[3].children[0].text).toBe('Beta')
    expect(stored.items[3].children[0].done).toBe(true)
    expect(stored.items[4].text).toBe('Gamma')
  })

  test('single-line paste is inline, links bare URLs, and a URL pasted over a selection creates a link', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const target = note.items[0]
    await pasteInto(harness, target.id, target.text.length, { text: ' see https://example.com/x. ok' })
    await harness.waitForNote(note.id, (stored) => stored.items[0].html.includes('<a href="https://example.com/x" target="_blank" rel="noreferrer">https://example.com/x</a>. ok'))
    expect((await harness.storedNote(note.id))!.items.length).toBe(note.items.length)
    await pasteInto(harness, target.id, 0, { text: 'https://balance.example/link' }, 5)
    await harness.waitForNote(note.id, (stored) => /^<a href="https:\/\/balance.example\/link"[^>]*>First<\/a>/.test(stored.items[0].html))
    // Foreign text formatting survives while unrelated CSS is discarded.
    await pasteInto(harness, note.items[3].id, 0, { html: '<span style="color:red;position:fixed"><b>Bold</b> <s>struck</s> <code>code</code></span>', text: 'Bold struck code' })
    await harness.waitForNote(note.id, (stored) => stored.items[3].text === 'Bold struck code')
    const pastedHtml = (await harness.storedNote(note.id))!.items[3].html
    expect(pastedHtml).toContain('<strong>')
    expect(pastedHtml).toMatch(/color:\s*(?:red|rgb\(255, 0, 0\))/)
    expect(pastedHtml).toContain('line-through')
    expect(pastedHtml).not.toContain('position')
  })

  test('copying a multi-block selection writes list markers and HTML; cut removes the rows', async ({ harness }) => {
    await harness.boot({ select: 'Checklist' })
    const note = harness.noteByTitle('Checklist')
    await harness.placeCaret(note.items[0].id, 0)
    await harness.page.keyboard.press('Shift+ArrowDown')
    await harness.page.keyboard.press('Shift+ArrowDown')
    const copied = await copySelection(harness)
    expect(copied.handled).toBe(true)
    expect(copied.text.split('\n').slice(0, 2)).toEqual(['☑ Done item', '☐ Open item'])
    expect(copied.html).toMatch(/<ul><li>☑ Done item<\/li><li>☐ Open item<\/li>/)
    await harness.page.evaluate(() => {
      const target = document.activeElement as HTMLElement
      target.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }))
    })
    await harness.waitForNote(note.id, (stored) => !stored.items.some((item) => item.id === note.items[0].id || item.id === note.items[1].id))
  })

  test('a partial selection inside one paragraph is copied natively', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    await harness.placeCaret(note.items[0].id, 0, 5)
    const copied = await copySelection(harness)
    expect(copied.handled).toBe(false)
  })

  test('Paste and Match Style inserts plain text inline through balancepaste', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const target = note.items[0]
    await harness.placeCaret(target.id, target.text.length)
    await harness.page.evaluate(() => {
      const editor = document.activeElement?.closest<HTMLElement>('[data-rich-text-input]') ?? (document.activeElement as HTMLElement)
      editor.dispatchEvent(new CustomEvent('balancepaste', { detail: { plainText: ' matched\nstyle', html: null } }))
    })
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length && stored.items[0].text.startsWith(`${target.text} matched`))
  })
})

// ---------------------------------------------------------------------------
// F/H. Integration
// ---------------------------------------------------------------------------

test.describe('host integration', () => {
  test('global shortcuts still work while typing: Mod+N creates a note, Alt+I toggles IMAX, ? is typed', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    await harness.placeCaret(note.items[0].id, 0)
    await harness.page.keyboard.type('?')
    await harness.waitForNote(note.id, (stored) => stored.items[0].text.startsWith('?'))
    await expect(harness.page.getByRole('dialog')).toHaveCount(0)
    const before = (await harness.storedNotes()).length
    await harness.page.keyboard.press(`${mod}+n`)
    await expect.poll(async () => (await harness.storedNotes()).length).toBe(before + 1)
    await expect(harness.page.locator('#note-title')).toBeFocused()
    await harness.selectNote('Simple paragraphs')
    await harness.placeCaret(note.items[0].id, 0)
    await harness.page.keyboard.press('Alt+i')
    await expect(harness.page.getByRole('button', { name: 'Exit IMAX mode' })).toBeVisible()
    await harness.page.keyboard.press('Alt+i')
    await expect(harness.page.getByRole('button', { name: 'Enter IMAX mode' })).toBeVisible()
  })

  test('P-18/19 links: external anchors open in a new window, note links select the note', async ({ harness }) => {
    await harness.boot({ select: 'Links' })
    const note = harness.noteByTitle('Links')
    const target = harness.noteByTitle('Checklist')
    // openExternalURL calls window.open(url, '_blank', 'noopener,noreferrer');
    // headless browsers do not reliably surface that as a popup, so observe
    // the call itself.
    await harness.page.evaluate(() => {
      const record: string[] = []
      ;(window as unknown as { __openedURLs: string[] }).__openedURLs = record
      window.open = ((url: string) => { record.push(String(url)); return null }) as typeof window.open
    })
    await harness.block(note.items[0].id).locator('a').first().click()
    await expect.poll(() => harness.page.evaluate(() => (window as unknown as { __openedURLs: string[] }).__openedURLs)).toEqual(['https://example.com/path?q=1&r=2'])
    expect(harness.page.url()).toContain('127.0.0.1')
    await pasteInto(harness, note.items[2].id, 0, { text: `balance://note/${target.id}` }, 4)
    await harness.waitForNote(note.id, (stored) => stored.items[2].html.includes(`href="balance://note/${target.id}"`))
    await harness.block(note.items[2].id).locator(`a[href="balance://note/${target.id}"]`).click()
    await expect(harness.page.locator('#note-title')).toHaveValue('Checklist')
  })

  test('P-57 search opens a note and highlights the matching block', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Nested lists')
    const sourdough = flatten(note.items).find((item) => item.text === 'Sourdough')!
    await harness.page.keyboard.press(`${mod}+k`)
    await harness.page.getByRole('dialog').getByRole('searchbox').or(harness.page.getByRole('dialog').getByRole('textbox')).first().fill('Sourdough')
    // Search results are buttons named "Open <title>, Note".
    await harness.page.getByRole('dialog').getByRole('button', { name: /^Open Nested lists/ }).first().click()
    await expect(harness.page.locator('#note-title')).toHaveValue('Nested lists')
    await expect(harness.page.locator(`[data-note-item-id="${sourdough.id}"].search-result-target`)).toBeVisible()
  })

  test('P-58 document find matches editor text', async ({ harness }) => {
    await harness.boot({ select: 'Headings and quotes' })
    await harness.page.keyboard.press(`${mod}+f`)
    const find = harness.page.getByRole('searchbox', { name: /find/i }).or(harness.page.getByPlaceholder(/find/i)).first()
    // A phrase beyond the sidebar card preview (first 90 characters), so the
    // only match is the editor text.
    await find.fill('Closing thoughts')
    await expect(harness.page.getByText(/1 of 1|1\/1/)).toBeVisible()
    await harness.page.keyboard.press('Escape')
  })

  test('IME composition is committed once, at the end', async ({ harness }) => {
    await harness.boot({ select: 'Unicode 🌍 日本語' })
    const note = harness.noteByTitle('Unicode 🌍 日本語')
    const target = note.items[1]
    await harness.placeCaret(target.id, target.text.length)
    const session = await harness.page.context().newCDPSession(harness.page)
    await session.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
    await session.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 })
    await session.send('Input.insertText', { text: '日本' })
    await harness.waitForNote(note.id, (stored) => stored.items[1].text === `${target.text}日本`)
    expect((await harness.storedNote(note.id))!.items[1].text).not.toContain('にほ')
    expect(await harness.caretItemId()).toBe(target.id)
  })

  test('the toolbar is sticky and every block exposes data-note-item-id for search', async ({ harness }) => {
    await harness.boot({ select: 'Long note' })
    const note = harness.noteByTitle('Long note')
    const toolbar = harness.page.getByRole('toolbar', { name: 'Note formatting' })
    // P-51: once scrolled, the toolbar stays pinned 8–48 px (CSS, before
    // zoom) below the note scroller's top edge.
    const scroller = harness.page.locator('.note-document').first()
    await harness.block(flatten(note.items)[60].id).scrollIntoViewIfNeeded()
    await harness.page.waitForTimeout(100)
    const pinned = (await toolbar.boundingBox())!.y - (await scroller.boundingBox())!.y
    await harness.block(flatten(note.items)[120].id).scrollIntoViewIfNeeded()
    await harness.page.waitForTimeout(100)
    const later = (await toolbar.boundingBox())!.y - (await scroller.boundingBox())!.y
    expect(pinned).toBeGreaterThanOrEqual(0)
    expect(pinned).toBeLessThanOrEqual(60)
    expect(Math.abs(later - pinned)).toBeLessThanOrEqual(1)
    await expect(toolbar).toBeInViewport()
    const count = await harness.page.locator('[data-note-item-id]').count()
    expect(count).toBe(flatten(note.items).length)
  })

  test('themes: the editor uses theme tokens (text color follows --ink in dark mode)', async ({ harness }) => {
    await harness.page.addInitScript(() => {
      localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, colorScheme: 'dark', themeId: 'graphite' }))
    })
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const { color, ink } = await harness.block(note.items[0].id).evaluate((element) => ({
      color: getComputedStyle(element).color,
      ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
    }))
    const probe = await harness.page.evaluate((value) => {
      const span = document.createElement('span')
      span.style.color = value
      document.body.append(span)
      const resolved = getComputedStyle(span).color
      span.remove()
      return resolved
    }, ink)
    expect(color).toBe(probe)
  })
})

void isMac
void textOf
