import { expect, test } from '@playwright/test'
import { buildGoalStats } from '../../src/lib/goalStats'
import { goalDaysUntilLapse, shiftISODate, sortGoalsByUrgency } from '../../src/lib/goals'
import type { Goal, GoalCompletion } from '../../src/lib/types'

// This same harness runs against both revisions in CI. All history is
// synthetic, and measured calls do not include fixture creation or assertions.
function fixture(goalCount: number, days: number) {
  const date = '2026-10-20'
  const startDate = shiftISODate(date, -days)
  const goals: Goal[] = Array.from({ length: goalCount }, (_, index) => ({
    id: `goal-${index}`, name: `Goal ${index}`, nameHtml: `Goal ${index}`, cadenceDays: 1 + index % 14,
    matchTerms: [], matchTermsHtml: '', hue: 100, lightness: 50,
    activityPeriods: [{ startDate, endDate: null }],
    cadenceHistory: [{ startDate, cadenceDays: 1 + index % 14 }],
    createdAt: `${startDate}T12:00:00Z`, updatedAt: `${startDate}T12:00:00Z`,
  }))
  const completions: GoalCompletion[] = []
  for (let day = 0; day < days; day += 1) {
    for (let index = 0; index < goals.length; index += 1) {
      if ((day + index) % (1 + index % 7) !== 0) continue
      completions.push({
        goalId: goals[index].id, date: shiftISODate(startDate, day),
        itemIds: [], matchedTerms: [], computedAt: `${date}T12:00:00Z`,
      })
    }
  }
  return { goals, completions: completions.reverse(), date }
}

function measure(scenario: string, run: () => unknown) {
  for (let index = 0; index < 5; index += 1) run()
  const samples: number[] = []
  for (let sample = 0; sample < 9; sample += 1) {
    let iterations = 0
    const started = performance.now()
    do {
      run()
      iterations += 1
    } while (performance.now() - started < 80)
    samples.push((performance.now() - started) / iterations)
  }
  samples.sort((left, right) => left - right)
  console.log(`PERF ${JSON.stringify({ scenario, medianMs: samples[Math.floor(samples.length / 2)] })}`)
}

for (const { size, goals: count, days } of [
  { size: 'small', goals: 10, days: 30 },
  { size: 'large', goals: 120, days: 3650 },
]) {
  test(`goal computations with ${size} synthetic history`, () => {
    test.setTimeout(120_000)
    const { goals, completions, date } = fixture(count, days)
    const sorted = sortGoalsByUrgency(goals, completions, date)
    expect(sorted).toHaveLength(goals.length)
    expect(new Set(sorted.map(goal => goal.id))).toEqual(new Set(goals.map(goal => goal.id)))
    const byGoal = new Map(goals.map(goal => [goal.id, completions.filter(entry => entry.goalId === goal.id)]))
    measure(`goals-urgency-${size}`, () => sortGoalsByUrgency(goals, completions, date))
    for (const range of [180, 30, 1]) {
      const stats = buildGoalStats(goals, completions, date, range)
      expect(stats.daily).toHaveLength(range)
      expect(stats.rangeStart).toBe(shiftISODate(date, 1 - range))
      expect(stats.daily.map(day => day.overdueGoals)).toEqual(stats.daily.map(day =>
        goals.filter(goal => (goalDaysUntilLapse(goal, byGoal.get(goal.id) ?? [], day.date) ?? 0) < 0).length,
      ))
      const inRange = completions.filter(entry => entry.date >= stats.rangeStart && entry.date <= date)
      expect(stats.completionsInRange).toBe(inRange.length)
      expect(stats.completionDays).toBe(new Set(inRange.map(entry => entry.date)).size)
      measure(range === 180 ? `goals-stats-${size}` : `goals-stats-${size}-range${range}`,
        () => buildGoalStats(goals, completions, date, range))
    }
    if (size === 'small') {
      // This fixture starts every goal together in increasing cadence order.
      expect(sortGoalsByUrgency(goals, [], date)).toEqual(goals)
      measure('goals-urgency-empty-small', () => sortGoalsByUrgency(goals, [], date))
    }
  })
}
