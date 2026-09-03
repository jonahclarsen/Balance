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
  expect(stats.activeGoals).toBe(2)
  expect(stats.archivedGoals).toBe(1)
  expect(stats.overdueGoals).toBe(1)
  expect(stats.onTrackGoals).toBe(1)
  expect(stats.completionsInRange).toBe(2)
  expect(stats.completionDays).toBe(2)
  expect(stats.completedGoalsInRange).toBe(2)
  expect(stats.averageOverdueGoals).toBeCloseTo(0.6)
  expect(stats.daily.map((day) => day.overdueGoals)).toEqual([1, 1, 0, 0, 1])
  expect(stats.daily.map((day) => day.completedGoals)).toEqual([0, 0, 1, 1, 0])
  expect(stats.needsAttention.map((row) => row.goal.id)).toEqual(['daily'])
  expect(stats.mostCompleted.map((row) => row.goal.id)).toEqual(['weekly', 'daily'])
  expect(stats.cadence).toEqual({ daily: 1, weekly: 1, longer: 0 })
})

test('goal stats handle an empty collection without invalid percentages', () => {
  const stats = buildGoalStats([], [], '2026-09-03', 30)

  expect(stats.activeGoals).toBe(0)
  expect(stats.averageOverdueGoals).toBe(0)
  expect(stats.daily).toHaveLength(30)
  expect(stats.daily.every((day) => day.overdueGoals === 0 && day.completedGoals === 0)).toBe(true)
})
