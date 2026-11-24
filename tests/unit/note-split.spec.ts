import { expect, test } from '@playwright/test'
import { dropNoteIntoSplit, noteSplitSideAt } from '../../src/lib/noteSplit'

test('drops land on the half of the notes area under the pointer', () => {
  expect(noteSplitSideAt(149, { left: 100, width: 100 })).toBe('left')
  expect(noteSplitSideAt(150, { left: 100, width: 100 })).toBe('right')
})

test('dropping a note opens it beside the current one or replaces that side', () => {
  expect(dropNoteIntoSplit('a', null, 'b', 'right')).toEqual({ primaryId: 'a', split: { noteId: 'b', side: 'right' } })
  expect(dropNoteIntoSplit('a', null, 'a', 'left')).toEqual({ primaryId: 'a', split: null })
  const split = { noteId: 'b', side: 'right' as const }
  expect(dropNoteIntoSplit('a', split, 'c', 'right')).toEqual({ primaryId: 'a', split: { noteId: 'c', side: 'right' } })
  expect(dropNoteIntoSplit('a', split, 'c', 'left')).toEqual({ primaryId: 'c', split })
})

test('dropping a note already open in the other pane swaps the panes', () => {
  const split = { noteId: 'b', side: 'left' as const }
  expect(dropNoteIntoSplit('a', split, 'a', 'left')).toEqual({ primaryId: 'b', split: { noteId: 'a', side: 'left' } })
  expect(dropNoteIntoSplit('a', split, 'b', 'right')).toEqual({ primaryId: 'b', split: { noteId: 'a', side: 'left' } })
})
