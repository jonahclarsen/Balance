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

test('copying deep notes preserves and isolates unknown nested fields at every level', () => {
  type FutureItem = NoteItem & { future: { references: string[]; metadata: { enabled: boolean } } }
  let source: FutureItem[] = []
  for (let depth = 79; depth >= 0; depth--) {
    source = [{
      ...item(`level-${depth}`, source),
      future: { references: [`opaque-${depth}`], metadata: { enabled: true } },
    }]
  }
  const before = structuredClone(source)
  const copy = copyNoteItemsWithNewIds(source) as FutureItem[]
  const ids = new Set<string>()
  let original = source
  let cloned = copy
  for (let depth = 0; depth < 80; depth++) {
    const a = original[0]
    const b = cloned[0]
    expect(b.id).not.toBe(a.id)
    expect(ids.has(b.id)).toBe(false)
    ids.add(b.id)
    expect({ ...b, id: a.id, children: [] }).toEqual({ ...a, children: [] })
    expect(b.future).not.toBe(a.future)
    expect(b.future.references).not.toBe(a.future.references)
    b.future.references.push('copy-only')
    b.future.metadata.enabled = false
    original = a.children as FutureItem[]
    cloned = b.children as FutureItem[]
  }
  expect(cloned).toEqual([])
  expect(source).toEqual(before)
})
