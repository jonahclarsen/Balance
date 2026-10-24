import { expect, test } from '@playwright/test'
import {
  ideaUnlockDelay,
  ideaGroupKindForKey,
  ideaReviewGoalHue,
  isIdeaTrashExpired,
  needsIdeaReviewGoal,
  parseIdeaImportText,
  IDEA_GROUPS,
  IDEA_REVIEW_GOAL_ID,
  IDEA_TRASH_RETENTION_MS,
} from '../../src/lib/ideas'
import { createPlanItem } from '../../src/lib/planner'

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

test('the review goal seeds once and picks a hue away from existing goals', () => {
  expect(needsIdeaReviewGoal([])).toBe(true)
  expect(needsIdeaReviewGoal([{ id: IDEA_REVIEW_GOAL_ID }])).toBe(false)
  expect(ideaReviewGoalHue([])).toBe(275)
  const hue = ideaReviewGoalHue([{ hue: 275 }, { hue: 280 }, { hue: 270 }])
  expect(Math.abs(hue - 275)).toBeGreaterThan(30)
})
