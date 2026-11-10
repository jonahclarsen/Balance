import type { Id } from './types'

// Notes last left scrolled to their bottom reopen there. A per-device view
// preference, like collapsed blocks, so it lives in localStorage.
const STORAGE_KEY = 'balance.notesLeftAtBottom'
// Deleted notes are never cleared individually; keep only the most recent.
const MAX_STORED_IDS = 500

function load(): Set<Id> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is Id => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

let ids = load()

export function noteWasLeftAtBottom(noteId: Id) {
  return ids.has(noteId)
}

export function rememberNoteLeftAtBottom(noteId: Id, atBottom: boolean) {
  if (ids.has(noteId) === atBottom) return
  ids = new Set(ids)
  if (atBottom) ids.add(noteId)
  else ids.delete(noteId)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids].slice(-MAX_STORED_IDS)))
  } catch {
    // Keep the session value.
  }
}
