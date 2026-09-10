import { expect, test } from '@playwright/test'
import {
  buildGoalDayCells,
  cadenceDaysOnDate,
  createGoal,
  goalDaysUntilLapse,
  normalizeGoal,
  setGoalCadence,
  shiftISODate,
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

test('Goal Rhythm preserves old cadence cells and carries completion coverage across the change', () => {
  const changed = setGoalCadence(normalizeGoal(goal()), 2, '2026-08-31')
  const dates = ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']
  const cells = buildGoalDayCells(changed, [completion('2026-08-30')], dates, '2026-09-02')
  const byDate = new Map(cells.map((cell) => [cell.date, cell]))

  expect(byDate.get('2026-08-29')).toEqual(expect.objectContaining({ overdue: true, segmentEnd: true }))
  expect(byDate.get('2026-08-30')).toEqual(expect.objectContaining({ completed: true, segmentStart: true, segmentEnd: true }))
  expect(byDate.get('2026-08-31')).toEqual(expect.objectContaining({ relieved: true, missed: false, segmentStart: true }))
  expect(byDate.get('2026-09-01')).toEqual(expect.objectContaining({ overdue: true }))
  expect(byDate.get('2026-09-02')).toEqual(expect.objectContaining({ missed: false, overdue: false, segmentEnd: true }))
})

test('a daily goal marks the closed missed day rather than the actionable current day', () => {
  const daily = normalizeGoal(goal({
    cadenceDays: 1,
    activityPeriods: [{ startDate: '2026-08-31', endDate: null }],
  }))
  const cells = buildGoalDayCells(daily, [], ['2026-08-31', '2026-09-01'], '2026-09-01')
  const byDate = new Map(cells.map((cell) => [cell.date, cell]))

  expect(byDate.get('2026-08-31')).toEqual(expect.objectContaining({ overdue: true, segmentStart: true }))
  expect(byDate.get('2026-09-01')).toEqual(expect.objectContaining({
    active: true,
    missed: false,
    overdue: false,
    segmentEnd: true,
  }))
  expect(goalDaysUntilLapse(daily, [], '2026-09-01')).toBe(-1)

  const stillDueToday = buildGoalDayCells(daily, [], ['2026-08-31'], '2026-08-31')[0]
  expect(stillDueToday).toEqual(expect.objectContaining({ missed: false, overdue: false }))
})

test('current urgency carries the latest completion across the cadence boundary', () => {
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

for (const futureDays of [0, 6]) {
  test(`cadence edits preserve history and completion coverage with ${futureDays} future days`, () => {
    const today = '2026-09-10'
    const dates = Array.from({ length: 14 + futureDays }, (_, i) => shiftISODate(today, i - 13))
    const completions = [completion('2026-09-06')]
    const original = normalizeGoal(goal({ cadenceDays: 7 }))
    const tenDays = setGoalCadence(original, 10, '2026-09-07')
    const eightDays = setGoalCadence(tenDays, 8, today)
    const statuses = (source: Goal, asOf = today) => buildGoalDayCells(source, completions, dates, asOf)
      .filter(cell => cell.date < today)
      .map(({ date, completed, relieved, missed, overdue }) => ({ date, completed, relieved, missed, overdue }))

    expect(statuses(eightDays)).toEqual(statuses(tenDays))
    expect(statuses(eightDays, '2026-09-20')).toEqual(statuses(tenDays))
    expect(buildGoalDayCells(eightDays, completions, dates, today)
      .filter(cell => cell.date >= '2026-09-07' && cell.date <= today))
      .toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ relieved: true, missed: false, overdue: false })))
    expect(goalDaysUntilLapse(eightDays, completions, today)).toBe(4)
    expect(goalDaysUntilLapse(eightDays, completions, '2026-09-14')).toBe(0)
    expect(goalDaysUntilLapse(eightDays, completions, '2026-09-15')).toBe(-1)
  })
}

test('shortening below elapsed time becomes due on the edit day without past failures', () => {
  const original = normalizeGoal(goal({ cadenceDays: 10 }))
  const changed = setGoalCadence(original, 2, '2026-09-10')
  const completions = [completion('2026-09-06')]
  const dates = Array.from({ length: 7 }, (_, i) => shiftISODate('2026-09-06', i))
  const cells = buildGoalDayCells(changed, completions, dates, '2026-09-11')
  expect(cells.slice(0, 4).every(cell => !cell.missed && !cell.overdue)).toBe(true)
  expect(cells[4]).toEqual(expect.objectContaining({ overdue: true }))
  expect(cells[5]).toEqual(expect.objectContaining({ overdue: false, missed: false }))
  expect(goalDaysUntilLapse(changed, completions, '2026-09-10')).toBe(0)
  expect(goalDaysUntilLapse(changed, completions, '2026-09-11')).toBe(-1)
})

test('lengthening cadence preserves real historical failures and later completions reset the deadline', () => {
  const original = normalizeGoal(goal({ cadenceDays: 2 }))
  const changed = setGoalCadence(original, 8, '2026-09-10')
  const completions = [completion('2026-09-06'), completion('2026-09-12')]
  const dates = Array.from({ length: 15 }, (_, i) => shiftISODate('2026-09-06', i))
  const cells = buildGoalDayCells(changed, completions, dates, '2026-09-13')
  expect(cells[2]).toEqual(expect.objectContaining({ overdue: true }))
  expect(cells[3]).toEqual(expect.objectContaining({ overdue: true }))
  expect(cells[4]).toEqual(expect.objectContaining({ relieved: true, overdue: false }))
  expect(cells[6]).toEqual(expect.objectContaining({ completed: true }))
  expect(goalDaysUntilLapse(changed, completions, '2026-09-13')).toBe(7)
})

test('an unfinished initial window is not failed just because cadence changes', () => {
  const original = normalizeGoal(goal({ cadenceDays: 10, activityPeriods: [{ startDate: '2026-09-07', endDate: null }] }))
  const changed = setGoalCadence(original, 8, '2026-09-10')
  const dates = ['2026-09-07', '2026-09-08', '2026-09-09']
  expect(buildGoalDayCells(changed, [], dates, '2026-09-20').every(cell => !cell.missed && !cell.overdue)).toBe(true)
})

test('completion coverage does not carry across a pause in activity', () => {
  const changed = setGoalCadence(normalizeGoal(goal({ cadenceDays: 10, activityPeriods: [
    { startDate: '2026-08-29', endDate: '2026-09-07' },
    { startDate: '2026-09-10', endDate: null },
  ] })), 8, '2026-09-10')
  const completions = [completion('2026-09-06')]
  expect(goalDaysUntilLapse(changed, completions, '2026-09-10')).toBe(7)
  expect(buildGoalDayCells(changed, completions, ['2026-09-10'], '2026-09-10')[0].relieved).toBe(false)
})
