// Inline time pills in notes, persisted as
// `<time data-balance-time="540-600">9am–10am</time>`. The label is plain text,
// so search, previews and older clients still read the time.
import { formatMinutes, MAX_TIMELINE_MINUTES } from './planner'

export const NOTE_TIME_SELECTOR = 'time[data-balance-time]'

export type NoteTimeRange = { startMinutes: number; endMinutes: number }

export function validNoteTime(startMinutes: number, endMinutes: number): boolean {
  return Number.isInteger(startMinutes) && Number.isInteger(endMinutes) &&
    startMinutes >= 0 && endMinutes <= MAX_TIMELINE_MINUTES && startMinutes < endMinutes
}

export function noteTimeLabel(startMinutes: number, endMinutes: number): string {
  return `${formatMinutes(startMinutes)}–${formatMinutes(endMinutes)}`
}

export function noteTimeHTML(startMinutes: number, endMinutes: number): string {
  if (!validNoteTime(startMinutes, endMinutes)) return ''
  return `<time data-balance-time="${startMinutes}-${endMinutes}">${noteTimeLabel(startMinutes, endMinutes)}</time>`
}

export function parseNoteTime(element: Element): NoteTimeRange | null {
  const match = /^(\d{1,4})-(\d{1,4})$/.exec(element.getAttribute('data-balance-time') ?? '')
  if (!match) return null
  const startMinutes = Number(match[1])
  const endMinutes = Number(match[2])
  return validNoteTime(startMinutes, endMinutes) ? { startMinutes, endMinutes } : null
}

// A fresh pill starts where the previous one in the note ends, else at the
// current quarter hour, and lasts an hour.
export function freshNoteTime(previous: NoteTimeRange | null, now = new Date()): NoteTimeRange {
  const start = previous
    ? previous.endMinutes
    : Math.floor((now.getHours() * 60 + now.getMinutes()) / 15) * 15
  const startMinutes = Math.min(start, MAX_TIMELINE_MINUTES - 60)
  return { startMinutes, endMinutes: startMinutes + 60 }
}
