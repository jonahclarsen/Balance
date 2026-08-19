import type { Note } from './types'

export const NOTE_TRASH_RETENTION_DAYS = 30
export const NOTE_TRASH_RETENTION_MS = NOTE_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000

export function isNoteTrashed(note: Note): boolean {
  return Boolean(note.deletedAt)
}

export function noteTrashExpiresAt(note: Note): number | null {
  if (!note.deletedAt) return null
  const deletedAt = Date.parse(note.deletedAt)
  return Number.isFinite(deletedAt) ? deletedAt + NOTE_TRASH_RETENTION_MS : null
}

export function isNoteTrashExpired(note: Note, now = Date.now()): boolean {
  const expiresAt = noteTrashExpiresAt(note)
  return expiresAt !== null && expiresAt <= now
}

export function noteTrashDaysRemaining(note: Note, now = Date.now()): number {
  const expiresAt = noteTrashExpiresAt(note)
  if (expiresAt === null) return NOTE_TRASH_RETENTION_DAYS
  return Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)))
}
