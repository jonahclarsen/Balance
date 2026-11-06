import { shiftISODate } from './goals'
import type { Id, Note, NoteResurfacing } from './types'

export const NOTE_RESURFACE_CHOICES = [14, 30, 60, 91, 182, 365] as const
const JITTER = 0.15

// Labels lead with ≈ because every next date shifts by up to ±15%, so notes
// set up together drift apart instead of returning on the same day.
export function resurfaceLabel(days: number): string {
  if (days < 28) return `≈${Math.round(days / 7)} wk`
  if (days < 360) return `≈${Math.round(days / 30.4)} mo`
  return `≈${Math.round(days / 365)} yr`
}

export function jitteredDays(days: number, random = Math.random): number {
  return Math.max(1, Math.round(days * (1 + (random() * 2 - 1) * JITTER)))
}

export function scheduleResurfacing(id: Id, days: number, last: string, random = Math.random): NoteResurfacing {
  return { id, days, last, next: shiftISODate(last, jitteredDays(days, random)) }
}

// The most overdue note still in the notes list, or none when a note already
// resurfaced on this date: one a day keeps a long absence from piling them up.
export function dueResurfacedNote(records: NoteResurfacing[], notes: Note[], date: string): { record: NoteResurfacing; note: Note } | null {
  if (records.some((record) => record.last === date)) return null
  let due: { record: NoteResurfacing; note: Note } | null = null
  for (const record of records) {
    if (record.next > date || (due && due.record.next <= record.next)) continue
    const note = notes.find((candidate) => candidate.id === record.id && !candidate.deletedAt)
    if (note) due = { record, note }
  }
  return due
}
