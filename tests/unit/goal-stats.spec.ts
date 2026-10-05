import { expect, test } from '@playwright/test'
import { buildGoalStats } from '../../src/lib/goalStats'
import type { Goal, GoalCompletion } from '../../src/lib/types'

const TIMESTAMP = '2026-09-03T12:00:00.000Z'

function goal(
  id: string,
  name: string,
  cadenceDays: number,
  startDate: string,
  endDate: string | null = null,
): Goal {
  return {
    id,
    name,
    nameHtml: name,
    cadenceDays,
    matchTerms: [name.toLocaleLowerCase()],
    matchTermsHtml: name.toLocaleLowerCase(),
    hue: 200,
    lightness: 50,
    activityPeriods: [{ startDate, endDate }],
    cadenceHistory: [{ startDate, cadenceDays }],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  }
}

function completion(goalId: string, date: string): GoalCompletion {
  return {
    goalId,
    date,
    itemIds: [`item_${goalId}_${date}`],
    matchedTerms: [goalId],
    computedAt: `${date}T12:00:00.000Z`,
  }
}

test('goal stats summarize current health and historical overdue counts', () => {
  const goals = [
    goal('daily', 'Daily', 1, '2026-08-31'),
    goal('weekly', 'Weekly', 7, '2026-08-20'),
    goal('archived', 'Archived', 1, '2026-08-28', '2026-08-31'),
  ]
  const completions = [
    completion('daily', '2026-09-01'),
    completion('weekly', '2026-08-28'),
    completion('weekly', '2026-09-02'),
    completion('daily', '2026-09-04'),
    completion('unknown', '2026-09-03'),
  ]

  const stats = buildGoalStats(goals, completions, '2026-09-03', 5)

  expect(stats.rangeStart).toBe('2026-08-30')
  expect(stats.rangeEnd).toBe('2026-09-03')
  expect(stats.overdueGoals).toBe(1)
  expect(stats.completionsInRange).toBe(2)
  expect(stats.completionDays).toBe(2)
  expect(stats.averageOverdueGoals).toBeCloseTo(0.6)
  expect(stats.daily.map((day) => day.overdueGoals)).toEqual([1, 1, 0, 0, 1])
  expect(stats.daily.map((day) => day.completedGoals)).toEqual([0, 0, 1, 1, 0])
  expect(stats.deadlineOutlook).toEqual([
    { label: 'Overdue', count: 1 },
    { label: 'Today', count: 1 },
    { label: '1 day', count: 1 },
    { label: '2 days', count: 1 },
    { label: '3 days', count: 1 },
    { label: '4 days', count: 1 },
    { label: '5 days', count: 1 },
    { label: '6 days', count: 2 },
    { label: '7 days', count: 2 },
    { label: 'All goals', count: 2 },
  ])
  expect(stats.weekdayCompletions).toEqual([
    { label: 'Mon', count: 0 },
    { label: 'Tue', count: 1 },
    { label: 'Wed', count: 1 },
    { label: 'Thu', count: 0 },
    { label: 'Fri', count: 0 },
    { label: 'Sat', count: 0 },
    { label: 'Sun', count: 0 },
  ])
})

test('deadline outlook accumulates goals through each due date and ends with all active goals', () => {
  const goals = [
    goal('overdue', 'Overdue', 1, '2026-09-01'),
    goal('today', 'Today', 1, '2026-09-03'),
    goal('tomorrow', 'Tomorrow', 2, '2026-09-03'),
    goal('week', 'Week', 8, '2026-09-03'),
    goal('later', 'Later', 9, '2026-09-03'),
    goal('ending', 'Ending before due', 9, '2026-09-03', '2026-09-04'),
    goal('archived', 'Archived', 1, '2026-09-01', '2026-09-02'),
    goal('future', 'Future', 1, '2026-09-04'),
  ]

  const stats = buildGoalStats(goals, [], '2026-09-03', 5)

  expect(stats.deadlineOutlook.map((category) => category.count)).toEqual([1, 2, 3, 3, 3, 3, 3, 3, 4, 6])
})

test('goal stats handle an empty collection without invalid percentages', () => {
  const stats = buildGoalStats([], [], '2026-09-03', 30)

  expect(stats.averageOverdueGoals).toBe(0)
  expect(stats.daily).toHaveLength(30)
  expect(stats.daily.every((day) => day.overdueGoals === 0 && day.completedGoals === 0)).toBe(true)
  expect(stats.deadlineOutlook.every((category) => category.count === 0)).toBe(true)
  expect(stats.weekdayCompletions.every((category) => category.count === 0)).toBe(true)
})
