import { expect, test } from '@playwright/test'
import { freshNoteTime, noteTimeHTML } from '../../src/lib/noteTimeMarkup'
import { draggedTimeRange, timeDragDelta } from '../../src/lib/timeRangeDrag'
import { MAX_TIMELINE_MINUTES } from '../../src/lib/planner'

test('dragging the start moves the range; Alt keeps the end', () => {
  expect(draggedTimeRange('start', 540, 600, 30, 15, false)).toEqual({ startMinutes: 570, endMinutes: 630 })
  expect(draggedTimeRange('start', 540, 600, 90, 15, true)).toEqual({ startMinutes: 585, endMinutes: 600 })
  expect(draggedTimeRange('start', MAX_TIMELINE_MINUTES - 60, MAX_TIMELINE_MINUTES, 60, 15, false))
    .toEqual({ startMinutes: MAX_TIMELINE_MINUTES - 60, endMinutes: MAX_TIMELINE_MINUTES })
})

test('dragging the end below the start pushes the start down', () => {
  expect(draggedTimeRange('end', 540, 600, 15, 15, false)).toEqual({ startMinutes: 540, endMinutes: 615 })
  expect(draggedTimeRange('end', 540, 600, -120, 15, false)).toEqual({ startMinutes: 465, endMinutes: 480 })
})

test('drag deltas snap to the step grid', () => {
  expect(timeDragDelta(542, 1, 15)).toBe(13)
  expect(timeDragDelta(540, -2, 5)).toBe(-10)
})

test('a fresh note time follows the previous one or starts at the current quarter hour', () => {
  expect(freshNoteTime({ startMinutes: 540, endMinutes: 600 })).toEqual({ startMinutes: 600, endMinutes: 660 })
  expect(freshNoteTime(null, new Date('2026-11-24T14:52:00'))).toEqual({ startMinutes: 885, endMinutes: 945 })
  expect(noteTimeHTML(600, 540)).toBe('')
})
