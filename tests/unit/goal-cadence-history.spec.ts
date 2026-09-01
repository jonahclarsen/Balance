import { expect, test } from '@playwright/test'
import {
  buildGoalDayCells,
  cadenceDaysOnDate,
  createGoal,
  goalDaysUntilLapse,
  normalizeGoal,
  setGoalCadence,
} from '../../src/lib/goals'
import type { Goal, GoalCompletion } from '../../src/lib/types'

const TIMESTAMP = '2026-08-01T12:00:00.000Z'

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal_read',
    name: 'Read',
    nameHtml: 'Read',
    cadenceDays: 1,
    matchTerms: ['read'],
    matchTermsHtml: 'read',
    hue: 200,
    lightness: 50,
    activityPeriods: [{ startDate: '2026-08-29', endDate: null }],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  }
}

function completion(date: string): GoalCompletion {
  return {
    goalId: 'goal_read',
    date,
    itemIds: [`item_${date}`],
    matchedTerms: ['read'],
    computedAt: `${date}T12:00:00.000Z`,
  }
}

test('new and legacy goals receive an initial cadence history period', () => {
  const created = createGoal('Read', 3, ['read'], 200, 50, '2026-08-29', 'goal_read')
  expect(created.cadenceHistory).toEqual([{ startDate: '2026-08-29', cadenceDays: 3 }])

  const legacy = normalizeGoal(goal({ cadenceDays: 4 }))
  expect(legacy.cadenceHistory).toEqual([{ startDate: '2026-08-29', cadenceDays: 4 }])
})

test('changing cadence starts a dated regime without rewriting earlier dates', () => {
  const original = normalizeGoal(goal())
  const changed = setGoalCadence(original, 2, '2026-08-31')

  expect(changed.cadenceDays).toBe(2)
  expect(changed.cadenceHistory).toEqual([
    { startDate: '2026-08-29', cadenceDays: 1 },
    { startDate: '2026-08-31', cadenceDays: 2 },
  ])
  expect(cadenceDaysOnDate(changed, '2026-08-30')).toBe(1)
  expect(cadenceDaysOnDate(changed, '2026-08-31')).toBe(2)
})

test('Goal Rhythm preserves old cadence cells and starts a fresh window at the change', () => {
  const changed = setGoalCadence(normalizeGoal(goal()), 2, '2026-08-31')
  const dates = ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']
  const cells = buildGoalDayCells(changed, [completion('2026-08-30')], dates, '2026-09-02')
  const byDate = new Map(cells.map((cell) => [cell.date, cell]))

  expect(byDate.get('2026-08-29')).toEqual(expect.objectContaining({ missed: true, segmentEnd: true }))
  expect(byDate.get('2026-08-30')).toEqual(expect.objectContaining({ completed: true, segmentStart: true, segmentEnd: true }))
  expect(byDate.get('2026-08-31')).toEqual(expect.objectContaining({ missed: true, segmentStart: true }))
  expect(byDate.get('2026-09-01')).toEqual(expect.objectContaining({ missed: true }))
  expect(byDate.get('2026-09-02')).toEqual(expect.objectContaining({ overdue: true, segmentEnd: true }))
})

test('current urgency is measured from the latest cadence boundary', () => {
  const changed = setGoalCadence(normalizeGoal(goal()), 2, '2026-08-31')

  expect(goalDaysUntilLapse(changed, [completion('2026-08-30')], '2026-09-01')).toBe(0)
  expect(goalDaysUntilLapse(changed, [completion('2026-08-30')], '2026-09-02')).toBe(-1)
})

test('multiple edits on one day keep only the final cadence', () => {
  const original = normalizeGoal(goal())
  const twiceChanged = setGoalCadence(setGoalCadence(original, 3, '2026-08-31'), 2, '2026-08-31')

  expect(twiceChanged.cadenceHistory).toEqual([
    { startDate: '2026-08-29', cadenceDays: 1 },
    { startDate: '2026-08-31', cadenceDays: 2 },
  ])
})
