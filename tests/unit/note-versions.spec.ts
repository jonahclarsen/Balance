import { expect, test } from '@playwright/test'
import { copyNoteItemsWithNewIds, noteVersionGroupId, noteVersionLabel, noteVersionsOf } from '../../src/lib/noteVersions'
import type { Note, NoteItem } from '../../src/lib/types'

function note(id: string, createdAt: string, extra: Partial<Note> = {}): Note {
  return { id, title: 'Script', items: [], createdAt, updatedAt: createdAt, ...extra }
}

function item(id: string, children: NoteItem[] = []): NoteItem {
  return { id, kind: 'bullet', text: id, html: `<b>${id}</b>`, done: false, startMinutes: null, endMinutes: null, children }
}

test('versions group under the first version and keep creation order', () => {
  const first = note('a', '2026-10-01T00:00:00.000Z')
  const second = note('b', '2026-10-03T00:00:00.000Z', { versionOf: 'a', versionName: 'Tight cut' })
  const third = note('c', '2026-10-02T00:00:00.000Z', { versionOf: 'a' })
  const other = note('d', '2026-10-01T00:00:00.000Z')
  const notes = [second, other, third, first]

  expect(noteVersionGroupId(first)).toBe('a')
  expect(noteVersionGroupId(second)).toBe('a')
  const versions = noteVersionsOf(notes, 'a')
  expect(versions.map((version) => version.id)).toEqual(['a', 'c', 'b'])
  expect(versions.map((version) => noteVersionLabel(version, versions))).toEqual(['V1', 'V2', 'Tight cut'])
  // A binned first version leaves the remaining versions together.
  expect(noteVersionsOf([second, third], 'a').map((version) => version.id)).toEqual(['c', 'b'])
})

test('copying a version gives every nested item a fresh ID without touching the source', () => {
  const source = [item('parent', [item('child')]), item('sibling')]
  const copy = copyNoteItemsWithNewIds(source)

  expect(copy.map((entry) => entry.text)).toEqual(['parent', 'sibling'])
  expect(copy[0].children[0].html).toBe('<b>child</b>')
  const ids = (items: NoteItem[]): string[] => items.flatMap((entry) => [entry.id, ...ids(entry.children)])
  expect(ids(copy).some((id) => ids(source).includes(id))).toBe(false)
  expect(new Set(ids(copy)).size).toBe(3)
  copy[0].children[0].text = 'edited'
  expect(source[0].children[0].text).toBe('child')
})
