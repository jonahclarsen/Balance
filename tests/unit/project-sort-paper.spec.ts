import { expect, test } from '@playwright/test'
import {
  contains,
  detachWithStroke,
  layoutSheet,
  syncSortProjects,
  type ProjectSort,
  type Point,
} from '../../src/lib/projectSort'
import type { Project } from '../../src/lib/types'

const measure = (value: string) => [...value].length * 13
const make = (titles: string[]): ProjectSort => ({
  id: 'synthetic',
  startedAt: '2026-09-08T12:00:00Z',
  slips: titles.map((title, i) => ({ id: String(i), title })),
  strokes: [],
})

test('freehand loop and connected open strokes preserve their actual vertices and free the last title', () => {
  const initial = make(['Fern', 'Bird', 'Map'])
  const sheet = layoutSheet(initial.slips, measure)
  const p: Point[] = [
    [9, 9],
    [86, 5],
    [109, 20],
    [114, 69],
    [78, 72],
    [19, 71],
    [9, 9],
  ]
  const one = detachWithStroke(initial, sheet, p, 'loop')
  expect(one.slips.map((s) => !!s.outline)).toEqual([true, false, false])
  const outline = one.slips[0].outline!
  expect(
    outline.some(
      ([x, y]) =>
        Math.abs(x + sheet.blocks[0].center[0] - 109) < 0.01 &&
        Math.abs(y + sheet.blocks[0].center[1] - 20) < 0.01,
    ),
  ).toBe(true)
  expect(contains(outline, [0, 0])).toBe(true)
  const partial = detachWithStroke(
    one,
    sheet,
    [
      [280, 0],
      [278, 81],
    ],
    'partial',
  )
  expect(partial.slips.filter((s) => s.outline)).toHaveLength(1)
  const done = detachWithStroke(
    partial,
    sheet,
    [
      [278, 81],
      [570, 79],
    ],
    'joined',
  )
  expect(done.slips.every((s) => s.outline)).toBe(true)
  expect(done.strokes).toHaveLength(0)
})

test('long words and titles wrap, live drafts reconcile, saved snapshots retain original lettering', () => {
  const draft = make(['Very long title '.repeat(8), 'x'.repeat(80), 'Short'])
  const sheet = layoutSheet(draft.slips, measure)
  for (const block of sheet.blocks.slice(0, 2)) {
    expect(block.lines.length).toBeGreaterThan(1)
    expect(block.lines.every((line) => measure(line) <= 217)).toBe(true)
  }
  expect(sheet.blocks[2].center[1]).toBeGreaterThan(sheet.blocks[0].center[1] + sheet.blocks[0].height / 2)
  const projects = [
    { id: '0', name: 'Renamed' },
    { id: '1', name: 'Closed', completedAt: draft.startedAt },
    { id: '3', name: 'New' },
  ] as Project[]
  const next = syncSortProjects(draft, projects, measure)
  expect(next.slips.map((s) => s.title)).toEqual(['Renamed', 'New'])
  const saved = { ...draft, savedAt: draft.startedAt }
  expect(syncSortProjects(saved, projects, measure)).toBe(saved)
})
