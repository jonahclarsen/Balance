import { expect, test } from '@playwright/test'
import { formatDuration, listRunTiming, shouldSuggestTrim, summarizeListTiming } from '../../src/lib/listTiming'
import type { ListInstance, ListTemplateItem, PlanItem } from '../../src/lib/types'

const minute = 60_000
const start = Date.parse('2026-09-01T08:00:00.000Z')

function row(sourceItemId: string, completedAtMinute: number | null, children: PlanItem[] = []): PlanItem {
  return {
    id: `${sourceItemId}.${Math.random().toString(36).slice(2, 10)}`,
    text: sourceItemId,
    html: sourceItemId,
    done: completedAtMinute !== null,
    // Lists are generated an hour before the first check-off.
    ...(completedAtMinute === null ? {} : { doneAt: 3600 + completedAtMinute * 60 }),
    startMinutes: null,
    endMinutes: null,
    children,
  }
}

function templateItem(
  id: string,
  probability = 100,
  children: ListTemplateItem[] = [],
  alternatives: ListTemplateItem['alternatives'] = [],
): ListTemplateItem {
  return { id, text: id, html: id, probability, alternatives, children }
}

const abc = [templateItem('a'), templateItem('b'), templateItem('c')]

function run(day: number, items: PlanItem[]): ListInstance {
  return { id: `list-${day}`, date: `2026-09-${String(day).padStart(2, '0')}`, listTemplateId: 'template', createdAt: new Date(start - 60 * minute).toISOString(), items }
}

test('a run is timed from the first check-off to the last and each task from the one before it', () => {
  const timing = listRunTiming(run(1, [row('a', 0), row('b', 3), row('c', 8)]))
  expect(timing.startedAt).toBe(start)
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

test('an interrupted task is ignored for its typical time and for the expected time', () => {
  const lists = [1, 2, 3, 4, 5].map((day) => run(day, [row('a', 0), row('b', day === 3 ? 60 : 2), row('c', (day === 3 ? 60 : 2) + 4)]))
  const summary = summarizeListTiming(lists, 'template', abc)
  expect(summary.runCount).toBe(5)
  expect(summary.typicalItemMs.get('b')).toBe(2 * minute)
  expect(summary.typicalItemMs.get('c')).toBe(4 * minute)
  expect(summary.expectedRunMs).toBe(6 * minute)
})

test('the expected time follows the current template, weighted by each task and its ancestors appearing', () => {
  const lists = [1, 2, 3].map((day) => run(day, [row('a', 0), row('b', 2), row('c', 6), row('d', 16), row('e', 17)]))
  const typical = summarizeListTiming(lists, 'template', abc).typicalItemMs
  expect(summarizeListTiming(lists, 'template', abc).expectedRunMs).toBe(6 * minute)

  // Removing a task drops it from the estimate straight away.
  expect(summarizeListTiming(lists, 'template', [templateItem('a'), templateItem('b')]).expectedRunMs).toBe(2 * minute)

  // c (4 min) sits under a 50% parent with a 50% chance itself; d is an
  // alternative wording costing 10 min that takes 30% of b's appearances.
  const weighted = [
    templateItem('b', 100, [], [{ id: 'd', text: 'd', html: 'd', probability: 30 }]),
    templateItem('parent', 50, [templateItem('c', 50)]),
  ]
  expect(typical.get('d')).toBe(10 * minute)
  expect(summarizeListTiming(lists, 'template', weighted).expectedRunMs).toBe(
    0.7 * 2 * minute + 0.3 * 10 * minute + 0.5 * 0.5 * 4 * minute,
  )

  // A template with no timed tasks has no estimate.
  expect(summarizeListTiming(lists, 'template', [templateItem('new')]).expectedRunMs).toBeNull()
})

test('trimming is suggested once recent runs consistently exceed the ideal', () => {
  const lists = [1, 2, 3].map((day) => run(day, [row('a', 0), row('b', 20)]))
  const summary = summarizeListTiming(lists, 'template', [templateItem('a'), templateItem('b')])
  expect(shouldSuggestTrim(summary, 15)).toBe(true)
  expect(shouldSuggestTrim(summary, 25)).toBe(false)
  expect(shouldSuggestTrim(summary, 0)).toBe(false)
  expect(shouldSuggestTrim(summarizeListTiming(lists.slice(0, 2), 'template', [templateItem('a'), templateItem('b')]), 15)).toBe(false)
})

test('a list left unattended for over an hour is not timed', () => {
  const timing = listRunTiming(run(1, [row('a', 0), row('b', 2), row('c', 90)]))
  expect(timing.unattended).toBe(true)
  expect(timing.itemDurations).toEqual([{ sourceItemId: 'b', durationMs: 2 * minute }])

  const lists = [1, 2, 3].map((day) => run(day, [row('a', 0), row('b', 2), row('c', 90)]))
  expect(summarizeListTiming(lists, 'template', abc).runCount).toBe(0)
})

test('an expected time that rounds to the ideal minute is not treated as over it', () => {
  const summary = { runCount: 3, expectedRunMs: 8 * minute + 20_000, typicalItemMs: new Map() }
  expect(formatDuration(summary.expectedRunMs)).toBe('8 min')
  expect(shouldSuggestTrim(summary, 8)).toBe(false)
  expect(shouldSuggestTrim({ ...summary, expectedRunMs: 8 * minute + 40_000 }, 8)).toBe(true)
})

test('template edits reuse historical timings and new run data refreshes them', () => {
  const lists = [run(1, [row('a', 0), row('b', 2), row('c', 6)])]
  const original = summarizeListTiming(lists, 'template', abc)
  const edited = summarizeListTiming(lists, 'template', [templateItem('b', 50)])
  expect(edited.typicalItemMs).toBe(original.typicalItemMs)
  expect(edited.expectedRunMs).toBe(minute)

  const updated = [run(1, [row('a', 0), row('b', 4), row('c', 10)])]
  expect(summarizeListTiming(updated, 'template', abc).expectedRunMs).toBe(10 * minute)
  // Restoring an earlier immutable snapshot (undo) restores its timings too.
  expect(summarizeListTiming(lists, 'template', abc).expectedRunMs).toBe(6 * minute)
  expect(summarizeListTiming(lists, 'another-template', abc).runCount).toBe(0)
})
