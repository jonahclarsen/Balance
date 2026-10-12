import { createId } from './planner'
import type { Id, Note, NoteItem } from './types'

export function noteVersionGroupId(note: Note): Id {
  return note.versionOf || note.id
}

// Oldest first, so tabs keep their places as versions are added.
export function noteVersionsOf(notes: readonly Note[], groupId: Id): Note[] {
  return notes
    .filter((note) => noteVersionGroupId(note) === groupId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

export function noteVersionLabel(note: Note, versions: readonly Note[]): string {
  const name = note.versionName?.trim()
  if (name) return name
  const index = versions.findIndex((version) => version.id === note.id)
  return `V${index >= 0 ? index + 1 : versions.length + 1}`
}

export function copyNoteItemsWithNewIds(items: readonly NoteItem[]): NoteItem[] {
  return items.map((item) => ({
    ...structuredClone(item),
    id: createId('note_item'),
    children: copyNoteItemsWithNewIds(item.children),
  }))
}
