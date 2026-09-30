import { expect, test } from '@playwright/test'
import { listRunTiming, shouldSuggestTrim, summarizeListTiming } from '../../src/lib/listTiming'
import type { ListInstance, PlanItem } from '../../src/lib/types'

const minute = 60_000
const start = Date.parse('2026-09-01T08:00:00.000Z')

function row(sourceItemId: string, completedAtMinute: number | null, children: PlanItem[] = []): PlanItem {
  return {
    id: `row-${sourceItemId}-${Math.random()}`,
    text: sourceItemId,
    html: sourceItemId,
    done: completedAtMinute !== null,
    sourceItemId,
    ...(completedAtMinute === null ? {} : { completedAt: new Date(start + completedAtMinute * minute).toISOString() }),
    startMinutes: null,
    endMinutes: null,
    children,
  }
}

function run(day: number, items: PlanItem[]): ListInstance {
  return { id: `list-${day}`, date: `2026-09-${String(day).padStart(2, '0')}`, listTemplateId: 'template', createdAt: '', items }
}

test('a run is timed from the first check-off to the last and each task from the one before it', () => {
  const timing = listRunTiming(run(1, [row('a', 0), row('b', 3), row('c', 8)]))
  expect(timing.finishedAt! - timing.startedAt!).toBe(8 * minute)
  expect(timing.itemDurations).toEqual([
    { sourceItemId: 'b', durationMs: 3 * minute },
    { sourceItemId: 'c', durationMs: 5 * minute },
  ])
})

test('an unfinished run keeps running and parent rows are not timed as tasks', () => {
  const unfinished = listRunTiming(run(1, [row('a', 0), row('b', null)]))
  expect(unfinished.startedAt).not.toBeNull()
  expect(unfinished.finishedAt).toBeNull()

  const nested = listRunTiming(run(1, [row('a', 0), row('parent', 4, [row('child', 4)])]))
  expect(nested.itemDurations.map((entry) => entry.sourceItemId)).toEqual(['child'])
})

test('an interrupted task is ignored for its typical time and for the run length', () => {
  const lists = [1, 2, 3, 4, 5].map((day) => run(day, [row('a', 0), row('b', day === 3 ? 60 : 2), row('c', (day === 3 ? 60 : 2) + 4)]))
  const summary = summarizeListTiming(lists, 'template')
  expect(summary.runCount).toBe(5)
  expect(summary.typicalItemMs.get('b')).toBe(2 * minute)
  expect(summary.typicalItemMs.get('c')).toBe(4 * minute)
  expect(summary.typicalRunMs).toBe(6 * minute)
})

test('trimming is suggested once recent runs consistently exceed the ideal', () => {
  const lists = [1, 2, 3].map((day) => run(day, [row('a', 0), row('b', 20)]))
  const summary = summarizeListTiming(lists, 'template')
  expect(shouldSuggestTrim(summary, 15)).toBe(true)
  expect(shouldSuggestTrim(summary, 25)).toBe(false)
  expect(shouldSuggestTrim(summary, 0)).toBe(false)
  expect(shouldSuggestTrim(summarizeListTiming(lists.slice(0, 2), 'template'), 15)).toBe(false)
})
