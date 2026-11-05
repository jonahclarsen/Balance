import { expect, test } from '@playwright/test'
import {
  ideaUnlockDelay,
  ideaGroupKindForKey,
  dueIdeaReviews,
  parseIdeaReviewDays,
  isIdeaTrashExpired,
  parseIdeaImportText,
  IDEA_GROUPS,
  IDEA_TRASH_RETENTION_MS,
} from '../../src/lib/ideas'
import { createPlanItem } from '../../src/lib/planner'
import type { IdeaGroup, IdeaGroupKind } from '../../src/lib/types'

test('groups have unique move keys and a fixed order', () => {
  expect(IDEA_GROUPS.map((group) => group.kind)).toEqual(['proposition', 'genuine', 'possible', 'afterlife', 'trash'])
  expect(new Set(IDEA_GROUPS.map((group) => group.key)).size).toBe(IDEA_GROUPS.length)
  expect(ideaGroupKindForKey('G')).toBe('genuine')
  expect(ideaGroupKindForKey('x')).toBeNull()
})

test('leaving Proposition Party unlocks each group later the higher it sits', () => {
  expect(ideaUnlockDelay('proposition', 'trash')).toBe(0)
  expect(ideaUnlockDelay('proposition', 'afterlife')).toBeLessThan(ideaUnlockDelay('proposition', 'possible'))
  expect(ideaUnlockDelay('proposition', 'possible')).toBeLessThan(ideaUnlockDelay('proposition', 'genuine'))
  expect(ideaUnlockDelay('proposition', 'genuine')).toBe(3000)
  for (const from of ['genuine', 'possible', 'afterlife', 'trash', null] as const) {
    expect(ideaUnlockDelay(from, 'genuine')).toBe(0)
  }
})

test('trash ideas expire 30 days after they were sorted', () => {
  const bucketedAt = Date.parse('2026-09-01T12:00:00Z')
  const item = { ...createPlanItem('Synthetic trash'), bucketedAt: new Date(bucketedAt).toISOString() }
  expect(isIdeaTrashExpired(item, bucketedAt + IDEA_TRASH_RETENTION_MS - 1)).toBe(false)
  expect(isIdeaTrashExpired(item, bucketedAt + IDEA_TRASH_RETENTION_MS)).toBe(true)
  expect(isIdeaTrashExpired(createPlanItem('Synthetic undated'), Number.MAX_SAFE_INTEGER)).toBe(false)
})

test('plain-text import splits bullets and lines, nesting by indentation', () => {
  const items = parseIdeaImportText([
    '- Synthetic first',
    '  - Synthetic nested',
    '  * Synthetic nested two',
    '',
    '• Synthetic second',
    'Synthetic bare line',
    '1. Synthetic numbered',
    '☐ Synthetic checklist',
  ].join('\n'))
  expect(items.map((item) => item.text)).toEqual(['Synthetic first', 'Synthetic second', 'Synthetic bare line', 'Synthetic numbered', 'Synthetic checklist'])
  expect(items[0]!.children.map((item) => item.text)).toEqual(['Synthetic nested', 'Synthetic nested two'])
  expect(parseIdeaImportText('\n  \n')).toEqual([])
})

function idea(text: string, bucketedAt?: string) {
  return { ...createPlanItem(text), ...(bucketedAt ? { bucketedAt } : {}) }
}

function ideaGroups(items: Partial<Record<IdeaGroupKind, ReturnType<typeof idea>[]>>): IdeaGroup[] {
  return Object.entries(items).map(([kind, groupItems]) => ({ id: kind, kind: kind as IdeaGroupKind, items: groupItems! }))
}

const due = (groups: IdeaGroup[], today: string) =>
  dueIdeaReviews(groups, today).map(({ kind, items }) => [kind, items.map((item) => item.text)])

test('Genuinely reviews come every 10 days and Possibly every 45, covering ideas placed before the due day', () => {
  // Noon local time, clear of the 5 a.m. day boundary.
  const groups = ideaGroups({
    genuine: [idea('Synthetic old', '2026-10-01T12:00:00'), idea('Synthetic newer', '2026-10-10T12:00:00'), idea('Synthetic fresh', '2026-10-11T12:00:00')],
    possible: [idea('Synthetic maybe', '2026-10-01T12:00:00')],
    afterlife: [idea('Synthetic gone', '2026-01-01T12:00:00')],
  })
  expect(due(groups, '2026-10-10')).toEqual([])
  expect(due(groups, '2026-10-11')).toEqual([['genuine', ['Synthetic old', 'Synthetic newer']]])
  expect(due(groups, '2026-11-15')).toEqual([
    ['genuine', ['Synthetic old', 'Synthetic newer']],
    ['possible', ['Synthetic maybe']],
  ])
})

test('a group cadence replaces its default; invalid cadences fall back', () => {
  const genuine = [idea('Synthetic old', '2026-10-01T12:00:00')]
  expect(due([{ id: 'g', kind: 'genuine', items: genuine, reviewDays: 3 }], '2026-10-04')).toEqual([['genuine', ['Synthetic old']]])
  expect(due([{ id: 'g', kind: 'genuine', items: genuine, reviewDays: 3 }], '2026-10-03')).toEqual([])
  expect(due([{ id: 'g', kind: 'genuine', items: genuine, reviewDays: 0 }], '2026-10-10')).toEqual([])
  expect(due([{ id: 'g', kind: 'genuine', items: genuine, reviewDays: 0 }], '2026-10-11')).toEqual([['genuine', ['Synthetic old']]])
  expect([14, 365, 0, 2.5, 366, '7', null].map(parseIdeaReviewDays)).toEqual([14, 365, null, null, null, null, null])
})

test('undated ideas are due for review at once and empty groups never are', () => {
  expect(due(ideaGroups({ genuine: [idea('Synthetic undated'), idea('Synthetic today', '2026-10-11T12:00:00')] }), '2026-10-11'))
    .toEqual([['genuine', ['Synthetic undated']]])
  expect(due(ideaGroups({ genuine: [], possible: [] }), '2027-01-01')).toEqual([])
})
