import { expect, test } from '@playwright/test'
import { createGoal, sortGoalsForRhythm } from '../../src/lib/goals'
import type { GoalCompletion } from '../../src/lib/types'

test('today completions outrank daily and overdue sorting while preserving secondary order', () => {
  const today = '2026-09-10'
  const goals = [
    createGoal('Weekly done', 7, [], 0, 50, today, 'weekly'),
    createGoal('Daily pending', 1, [], 0, 50, today, 'daily'),
    createGoal('Overdue pending', 3, [], 0, 50, '2026-09-01', 'overdue'),
    createGoal('Daily done', 1, [], 0, 50, today, 'done'),
    createGoal('Yesterday done', 7, [], 0, 50, '2026-09-01', 'yesterday'),
  ]
  const completions: GoalCompletion[] = ['weekly', 'done', 'yesterday'].map((goalId) => ({
    goalId,
    date: goalId === 'yesterday' ? '2026-09-09' : today,
    itemIds: [],
    matchedTerms: [],
    computedAt: `${today}T12:00:00Z`,
  }))

  expect(sortGoalsForRhythm(goals, completions, today, today).map((goal) => goal.id))
    .toEqual(['done', 'weekly', 'daily', 'yesterday', 'overdue'])
  // Browsing a different day must still prioritize actual today's completions.
  expect(sortGoalsForRhythm(goals, completions, '2026-09-09', today).slice(0, 2).map((goal) => goal.id))
    .toEqual(['done', 'weekly'])
  expect(goals.map((goal) => goal.id)).toEqual(['weekly', 'daily', 'overdue', 'done', 'yesterday'])
})
