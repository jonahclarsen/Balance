import { expect, test } from '@playwright/test'
import { dueResurfacedNote, jitteredDays, resurfaceLabel, scheduleResurfacing } from '../../src/lib/noteResurfacing'
import type { Note } from '../../src/lib/types'

const note = (id: string, deletedAt: string | null = null): Note =>
  ({ id, title: id, items: [], createdAt: '', updatedAt: '', deletedAt })

test('labels read as approximate weeks, months and years', () => {
  expect([14, 30, 60, 91, 182, 365].map(resurfaceLabel)).toEqual(['≈2 wk', '≈1 mo', '≈2 mo', '≈3 mo', '≈6 mo', '≈1 yr'])
})

test('next dates move by at most 15% either way', () => {
  expect(jitteredDays(100, () => 0)).toBe(85)
  expect(jitteredDays(100, () => 0.5)).toBe(100)
  expect(jitteredDays(100, () => 0.9999)).toBe(115)
  expect(jitteredDays(1, () => 0)).toBe(1)
  expect(scheduleResurfacing('n', 100, '2026-11-05', () => 0.5)).toEqual({ id: 'n', days: 100, last: '2026-11-05', next: '2027-02-13' })
})

test('shows the most overdue note still in Notes, one a day', () => {
  const records = [
    { id: 'soon', days: 30, last: '2026-10-01', next: '2026-11-01' },
    { id: 'old', days: 30, last: '2026-09-01', next: '2026-10-01' },
    { id: 'binned', days: 30, last: '2026-08-01', next: '2026-09-01' },
    { id: 'later', days: 30, last: '2026-11-01', next: '2026-12-01' },
  ]
  const notes = ['soon', 'old', 'later'].map((id) => note(id)).concat(note('binned', '2026-11-01T00:00:00Z'))
  expect(dueResurfacedNote(records, notes, '2026-11-05')?.note.id).toBe('old')
  expect(dueResurfacedNote(records, notes, '2026-09-15')).toBeNull()
  const shownToday = records.map((record) => record.id === 'old' ? { ...record, last: '2026-11-05', next: '2026-12-05' } : record)
  expect(dueResurfacedNote(shownToday, notes, '2026-11-05')).toBeNull()
  expect(dueResurfacedNote(shownToday, notes, '2026-11-06')?.note.id).toBe('soon')
})
