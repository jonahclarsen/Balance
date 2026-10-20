import { expect, test } from '@playwright/test'
import { buildGoalStats } from '../../src/lib/goalStats'
import { goalDaysUntilLapse, shiftISODate, sortGoalsByUrgency } from '../../src/lib/goals'
import type { Goal, GoalCompletion } from '../../src/lib/types'

function fixture() {
  const start = '2024-01-01'
  const goals: Goal[] = Array.from({ length: 24 }, (_, index) => {
    const cadenceDays = 1 + index % 9
    return {
      id: `goal-${index}`, name: `Goal ${index}`, nameHtml: `Goal ${index}`, cadenceDays,
      matchTerms: [], matchTermsHtml: '', hue: 100, lightness: 50,
      activityPeriods: index % 3 === 0
        ? [
            { startDate: start, endDate: '2024-02-28' },
            { startDate: '2024-03-10', endDate: index % 2 === 0 ? '2024-05-20' : null },
          ]
        : [{ startDate: index % 3 === 1 ? '2024-02-01' : '2024-04-01', endDate: null }],
      // Include legacy goals without cadenceHistory and unsorted, duplicate
      // cadence dates, all of which the existing deadline helper supports.
      cadenceHistory: index % 4 === 0 ? undefined : [
        { startDate: '2024-04-05', cadenceDays },
        { startDate: start, cadenceDays: 7 },
        { startDate: '2024-03-15', cadenceDays: 2 },
        { startDate: '2024-04-05', cadenceDays },
      ],
      createdAt: `${start}T12:00:00Z`, updatedAt: `${start}T12:00:00Z`,
    }
  })
  const completions: GoalCompletion[] = []
  for (let day = -30; day < 220; day += 1) {
    for (let index = 0; index < goals.length + 1; index += 1) {
      if (index === 0 || (day + index) % (3 + index % 11) !== 0) continue
      const entry = {
        goalId: `goal-${index}`, date: shiftISODate(start, day),
        itemIds: [`item-${day}-${index}`], matchedTerms: [], computedAt: `${start}T12:00:00Z`,
      }
      completions.push(entry)
      if (day % 7 === 0) completions.push({ ...entry, itemIds: ['duplicate-date'] })
    }
  }
  // Deterministic interleaving exercises unsorted histories without randomness.
  return { goals, completions: [...completions.filter((_, i) => i % 2), ...completions.filter((_, i) => !(i % 2)).reverse()] }
}

function referenceOrder(goals: Goal[], completions: GoalCompletion[], date: string): Goal[] {
  const urgency = new Map(goals.map(goal => [goal.id, goalDaysUntilLapse(goal, completions, date)]))
  return [...goals].sort((left, right) => {
    const daily = Number(right.cadenceDays === 1) - Number(left.cadenceDays === 1)
    if (daily) return daily
    const leftDays = urgency.get(left.id) ?? null
    const rightDays = urgency.get(right.id) ?? null
    if (leftDays === null && rightDays === null) return left.cadenceDays - right.cadenceDays
    if (leftDays === null) return 1
    if (rightDays === null) return -1
    return leftDays - rightDays || left.cadenceDays - right.cadenceDays
  })
}

test('goal summaries and urgency retain full-history semantics across activity and cadence boundaries', () => {
  const { goals, completions } = fixture()
  const originalGoals = structuredClone(goals)
  const originalCompletions = structuredClone(completions)
  const known = new Set(goals.map(goal => goal.id))
  for (const date of ['2024-01-01', '2024-02-29', '2024-03-10', '2024-03-15', '2024-04-05', '2024-05-20', '2024-06-01']) {
    expect(sortGoalsByUrgency(goals, completions, date)).toEqual(referenceOrder(goals, completions, date))
    for (const range of [1, 30, 90]) {
      const stats = buildGoalStats(goals, completions, date, range)
      const expectedDaily = Array.from({ length: range }, (_, index) => {
        const day = shiftISODate(date, index - range + 1)
        return {
          date: day,
          overdueGoals: goals.filter(goal => (goalDaysUntilLapse(goal, completions, day) ?? 0) < 0).length,
          completedGoals: new Set(completions.filter(entry => known.has(entry.goalId) && entry.date === day).map(entry => entry.goalId)).size,
        }
      })
      expect(stats.daily).toEqual(expectedDaily)
      expect(stats.overdueGoals).toBe(expectedDaily.at(-1)?.overdueGoals)
      expect(stats.averageOverdueGoals).toBe(expectedDaily.reduce((sum, day) => sum + day.overdueGoals, 0) / range)
      const inRange = completions.filter(entry => known.has(entry.goalId) && entry.date >= stats.rangeStart && entry.date <= date)
      expect(stats.completionsInRange).toBe(inRange.length)
      expect(stats.completionDays).toBe(new Set(inRange.map(entry => entry.date)).size)
    }
  }
  expect(goals).toEqual(originalGoals)
  expect(completions).toEqual(originalCompletions)
})

test('goal history indexes are rebuilt after completion edits, undo and replacement', () => {
  const { goals, completions } = fixture()
  const date = '2024-06-01'
  const before = buildGoalStats(goals, completions, date, 30)
  const added: GoalCompletion = {
    goalId: 'goal-1', date, itemIds: ['new-item'], matchedTerms: [], computedAt: `${date}T12:00:00Z`,
  }
  completions.push(added)
  expect(sortGoalsByUrgency(goals, completions, date)).toEqual(referenceOrder(goals, completions, date))
  expect(buildGoalStats(goals, completions, date, 30).completionsInRange).toBe(before.completionsInRange + 1)
  completions.pop()
  expect(buildGoalStats(goals, completions, date, 30)).toEqual(before)
  const replacement = completions.filter(entry => entry.goalId !== 'goal-1')
  expect(sortGoalsByUrgency(goals, replacement, date)).toEqual(referenceOrder(goals, replacement, date))
})

test('empty and single-goal sorting still returns an independent array', () => {
  const { goals, completions } = fixture()
  for (const input of [[], goals.slice(0, 1)]) {
    const sorted = sortGoalsByUrgency(input, completions, '2024-06-01')
    expect(sorted).toEqual(input)
    expect(sorted).not.toBe(input)
  }
})
