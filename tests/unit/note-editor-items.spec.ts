import { expect, test } from '@playwright/test'
import { classifyNoteItemsDiff, noteItemsEqual } from '../../src/lib/noteEditor/noteItems'
import type { NoteItem, NoteItemKind } from '../../src/lib/types'

function item(id: string, text: string, kind: NoteItemKind = 'paragraph', children: NoteItem[] = [], done = false): NoteItem {
  return { id, kind, text, html: text, done, startMinutes: null, endMinutes: null, children }
}

test('identical trees compare equal even when the arrays are different objects', () => {
  const a = [item('a', 'one', 'bullet', [item('b', 'two')])]
  const b = [item('a', 'one', 'bullet', [item('b', 'two')])]
  expect(noteItemsEqual(a, b)).toBe(true)
  expect(classifyNoteItemsDiff(a, b)).toEqual({ kind: 'none' })
})

test('a single text change is classified as a text patch for that item', () => {
  const before = [item('a', 'one'), item('b', 'two', 'bullet', [item('c', 'three')])]
  const after = [item('a', 'one'), item('b', 'two', 'bullet', [item('c', 'three!')])]
  expect(classifyNoteItemsDiff(before, after)).toEqual({ kind: 'text', itemId: 'c' })
})

test('done-only changes across several checklist items are a done patch', () => {
  const before = [item('a', 'x', 'checklist', [item('b', 'y', 'checklist')])]
  const after = [item('a', 'x', 'checklist', [item('b', 'y', 'checklist', [], true)], true)]
  expect(classifyNoteItemsDiff(before, after)).toEqual({ kind: 'done', itemIds: ['a', 'b'], done: true })
})

test('kind changes, inserts, removals, moves and mixed edits are structural', () => {
  const base = [item('a', 'one'), item('b', 'two')]
  expect(classifyNoteItemsDiff(base, [item('a', 'one', 'heading'), item('b', 'two')])).toEqual({ kind: 'structure' })
  expect(classifyNoteItemsDiff(base, [item('a', 'one'), item('b', 'two'), item('c', '')])).toEqual({ kind: 'structure' })
  expect(classifyNoteItemsDiff(base, [item('a', 'one')])).toEqual({ kind: 'structure' })
  expect(classifyNoteItemsDiff(base, [item('b', 'two'), item('a', 'one')])).toEqual({ kind: 'structure' })
  expect(classifyNoteItemsDiff(base, [item('a', 'one', 'paragraph', [item('b', 'two')])])).toEqual({ kind: 'structure' })
  expect(classifyNoteItemsDiff(base, [item('a', 'one!'), item('b', 'two!')])).toEqual({ kind: 'structure' })
  expect(classifyNoteItemsDiff(
    [item('a', 'x', 'checklist'), item('b', 'y', 'checklist')],
    [item('a', 'x', 'checklist', [], true), item('b', 'y', 'checklist', [], false)],
  )).toEqual({ kind: 'done', itemIds: ['a'], done: true })
})
