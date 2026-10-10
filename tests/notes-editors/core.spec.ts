// Core adapter conformance: persistence, ids, remote updates, undo, switching.
// These tests run identically against desktop Notes.

import { comparable, expect, flatten, ids, test } from './harness'

test.describe('round trip', () => {
  test('loading every corpus note emits no operations and leaves items byte-identical', async ({ harness }) => {
    await harness.boot()
    const before = await harness.page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1') || '{}').operations?.length ?? 0)
    for (const note of harness.corpus.filter((candidate) => !candidate.deletedAt)) {
      await harness.selectNote(note.title || 'Untitled note')
      if (note.items.length > 0) await expect(harness.block(note.items[0].id)).toBeVisible()
      // Clicking into the note must not count as an edit either.
      if (note.items.length > 0) await harness.placeCaret(note.items[0].id, 0)
      await harness.page.waitForTimeout(150)
    }
    await harness.page.waitForTimeout(700)
    const stored = await harness.storedNotes()
    for (const note of harness.corpus) {
      const persisted = stored.find((candidate) => candidate.id === note.id)
      expect(persisted, `note ${note.title} persisted`).toBeTruthy()
      expect(comparable(persisted!.items), `items of ${note.title}`).toEqual(comparable(note.items))
      expect(persisted!.updatedAt, `updatedAt of ${note.title}`).toBe(note.updatedAt)
    }
    const after = await harness.page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1') || '{}').operations?.length ?? 0)
    expect(after).toBe(before)
  })

  test('every block in the document exposes its item id exactly once', async ({ harness }) => {
    await harness.boot({ select: 'Mixed kinds nesting' })
    const note = harness.noteByTitle('Mixed kinds nesting')
    const rendered = await harness.blocks().evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.itemId))
    expect([...rendered].sort()).toEqual([...ids(note.items)].sort())
  })
})

test.describe('editing maps to item operations', () => {
  test('typing patches only the edited item and keeps every id and unknown field', async ({ harness }) => {
    await harness.boot({ select: 'Unknown fields from a newer client' })
    const note = harness.noteByTitle('Unknown fields from a newer client')
    const target = note.items[0]
    await harness.placeCaret(target.id, target.text.length)
    await harness.page.keyboard.type(' plus more')
    await harness.waitForNote(note.id, (stored) => stored.items[0].text === `${target.text} plus more`)
    const stored = (await harness.storedNote(note.id))!
    expect(ids(stored.items)).toEqual(ids(note.items))
    const edited = stored.items[0] as unknown as Record<string, unknown>
    expect(edited.futureFlag).toBe(true)
    expect(edited.futureMeta).toEqual({ a: 1, b: [1, 2] })
    expect(edited.html).toBe(`${target.html} plus more`)
    // Untouched items are unchanged, including their extra fields.
    expect(comparable(stored.items.slice(1))).toEqual(comparable(note.items.slice(1)))
    expect((stored.items[2] as unknown as Record<string, unknown>).generatedGoalId).toBe('goal_0001')
  })

  test('Enter splits a block into two items with a fresh unique id for the new one', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const target = note.items[0]
    const splitAt = 'First paragraph'.length
    await harness.placeCaret(target.id, splitAt)
    await harness.page.keyboard.press('Enter')
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length + 1)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items[0].id).toBe(target.id)
    expect(stored.items[0].text).toBe('First paragraph')
    expect(stored.items[1].text).toBe(' with plain text.')
    expect(stored.items[1].id).not.toBe(target.id)
    const all = ids(stored.items)
    expect(new Set(all).size).toBe(all.length)
    // The rest of the note is untouched.
    expect(comparable(stored.items.slice(2))).toEqual(comparable(note.items.slice(1)))
    // The new block is rendered with its stored id and holds the caret.
    await expect(harness.block(stored.items[1].id)).toBeVisible()
    expect(await harness.caretItemId()).toBe(stored.items[1].id)
  })

  test('many splits never produce duplicate ids', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    await harness.placeCaret(note.items[0].id, 5)
    for (let index = 0; index < 8; index += 1) {
      await harness.page.keyboard.press('Enter')
      await harness.page.keyboard.type(`line ${index}`)
    }
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length + 8)
    const stored = (await harness.storedNote(note.id))!
    const all = ids(stored.items)
    expect(new Set(all).size).toBe(all.length)
    expect(all.every((id) => id.startsWith('note_item'))).toBe(true)
  })

  test('Backspace at the start of a block merges it into the previous one', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const second = note.items[1]
    await harness.placeCaret(second.id, 0)
    await harness.page.keyboard.press('Backspace')
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length - 1)
    const stored = (await harness.storedNote(note.id))!
    expect(stored.items[0].id).toBe(note.items[0].id)
    expect(stored.items[0].text).toBe(`${note.items[0].text}${second.text}`)
    expect(stored.items[0].html).toBe(`${note.items[0].html}${second.html}`)
    expect(await harness.caretItemId()).toBe(note.items[0].id)
    expect(await harness.caretOffset()).toBe(note.items[0].text.length)
  })
})

test.describe('remote updates and history', () => {
  test('a remote change to another block lands without moving the caret', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const mine = note.items[0]
    const theirs = note.items[4]
    await harness.placeCaret(mine.id, 5)
    await harness.page.keyboard.type('XY')
    await harness.waitForNote(note.id, (stored) => stored.items[0].text.startsWith('FirstXY'))
    await harness.applyRemoteItems(note.id, (items) => {
      const target = items.find((item) => item.text.startsWith('Paragraph after'))!
      target.text = 'Remote edit'
      target.html = 'Remote edit'
      return items
    })
    await expect(harness.block(theirs.id)).toContainText('Remote edit')
    expect(await harness.caretItemId()).toBe(mine.id)
    expect(await harness.caretOffset()).toBe(7)
    await harness.page.keyboard.type('Z')
    await harness.waitForNote(note.id, (stored) => stored.items[0].text.startsWith('FirstXYZ') && stored.items[4].text === 'Remote edit')
  })

  test('a remote change to the block being edited keeps the caret in that block', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const mine = note.items[0]
    await harness.placeCaret(mine.id, mine.text.length)
    await harness.applyRemoteItems(note.id, (items) => {
      items[0].text = 'Rewritten remotely.'
      items[0].html = 'Rewritten remotely.'
      return items
    })
    await expect(harness.block(mine.id)).toContainText('Rewritten remotely.')
    expect(await harness.caretItemId()).toBe(mine.id)
    await harness.page.keyboard.type('!')
    await harness.waitForNote(note.id, (stored) => stored.items[0].text === 'Rewritten remotely.!')
  })

  test('app undo and redo revert and restore typing and the editor follows', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    const target = note.items[0]
    await harness.placeCaret(target.id, target.text.length)
    await harness.page.keyboard.type(' undo me')
    await harness.waitForNote(note.id, (stored) => stored.items[0].text.endsWith(' undo me'))
    // Let the history merge window close so undo reverts the whole run.
    await harness.page.waitForTimeout(1300)
    await harness.undo()
    await harness.waitForNote(note.id, (stored) => stored.items[0].text === target.text)
    await expect(harness.block(target.id)).toHaveText(target.text)
    await harness.redo()
    await harness.waitForNote(note.id, (stored) => stored.items[0].text.endsWith(' undo me'))
    await expect(harness.block(target.id)).toContainText('undo me')
    // Editing continues after history navigation.
    await harness.placeCaret(target.id, 0)
    await harness.page.keyboard.type('>')
    await harness.waitForNote(note.id, (stored) => stored.items[0].text.startsWith('>First'))
  })

  test('undo of a structural edit restores the removed item with its original id', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    await harness.placeCaret(note.items[1].id, 0)
    await harness.page.keyboard.press('Backspace')
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length - 1)
    await harness.undo()
    await harness.waitForNote(note.id, (stored) => stored.items.length === note.items.length)
    const stored = (await harness.storedNote(note.id))!
    expect(ids(stored.items)).toEqual(ids(note.items))
    await expect(harness.block(note.items[1].id)).toBeVisible()
  })
})

test.describe('switching and closing', () => {
  test('rapid note switching loses nothing', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const first = harness.noteByTitle('Simple paragraphs')
    const second = harness.noteByTitle('Headings and quotes')
    await harness.placeCaret(first.items[0].id, first.items[0].text.length)
    await harness.page.keyboard.type(' A1')
    await harness.selectNote(second.title)
    await harness.placeCaret(second.items[1].id, second.items[1].text.length)
    await harness.page.keyboard.type(' B1')
    await harness.selectNote(first.title)
    await harness.placeCaret(first.items[0].id, 0)
    await harness.page.keyboard.type('A0 ')
    await harness.selectNote(second.title)
    await harness.waitForNote(first.id, (stored) => stored.items[0].text === `A0 ${first.items[0].text} A1`)
    await harness.waitForNote(second.id, (stored) => stored.items[1].text === `${second.items[1].text} B1`)
    expect(ids((await harness.storedNote(first.id))!.items)).toEqual(ids(first.items))
    expect(ids((await harness.storedNote(second.id))!.items)).toEqual(ids(second.items))
  })

  test('leaving the Notes view right after typing keeps the text', async ({ harness }) => {
    await harness.boot({ select: 'Simple paragraphs' })
    const note = harness.noteByTitle('Simple paragraphs')
    await harness.placeCaret(note.items[2].id, 0)
    await harness.page.keyboard.type('Quick ')
    await harness.page.getByRole('button', { name: 'Today', exact: true }).first().click({ force: true }).catch(() => {})
    await harness.waitForNote(note.id, (stored) => stored.items[2].text.startsWith('Quick '))
  })

  test('reopening a note restores the caret block and offset', async ({ harness }) => {
    await harness.boot({ select: 'Nested lists' })
    const note = harness.noteByTitle('Nested lists')
    const target = flatten(note.items).find((item) => item.text === 'Sourdough')!
    await harness.placeCaret(target.id, 3)
    await harness.page.waitForTimeout(200)
    await harness.selectNote('Checklist')
    await harness.selectNote('Nested lists')
    await expect.poll(() => harness.caretItemId()).toBe(target.id)
    expect(await harness.caretOffset()).toBe(3)
  })
})

test.describe('performance', () => {
  test('typing into a long note stays responsive', async ({ harness }) => {
    await harness.boot({ select: 'Long note' })
    const note = harness.noteByTitle('Long note')
    const target = flatten(note.items).find((item) => item.text.startsWith('Paragraph 6.3'))!
    await harness.block(target.id).scrollIntoViewIfNeeded()
    await harness.placeCaret(target.id, 0)
    const started = Date.now()
    await harness.page.keyboard.type('abcdefghijklmnopqrst', { delay: 0 })
    const elapsed = Date.now() - started
    await harness.waitForNote(note.id, (stored) => flatten(stored.items).find((item) => item.id === target.id)!.text.startsWith('abcdefghijklmnopqrst'))
    expect(elapsed, 'twenty keystrokes into a 200-block note').toBeLessThan(4_000)
    const stored = (await harness.storedNote(note.id))!
    expect(ids(stored.items)).toEqual(ids(note.items))
  })
})
