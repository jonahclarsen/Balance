import { goalDaysUntilLapse, isGoalActiveOnDate, shiftISODate } from './goals'
import type { Goal, GoalCompletion, Id } from './types'

export const GOAL_STATS_RANGES = [30, 90, 180] as const

export type GoalStatsRangeDays = (typeof GOAL_STATS_RANGES)[number]

export type GoalStatsDay = {
  date: string
  overdueGoals: number
  completedGoals: number
}

export type GoalStatsCategory = {
  label: string
  count: number
}

export type GoalStats = {
  rangeDays: number
  rangeStart: string
  rangeEnd: string
  overdueGoals: number
  completionsInRange: number
  completionDays: number
  averageOverdueGoals: number
  daily: GoalStatsDay[]
  deadlineOutlook: GoalStatsCategory[]
  weekdayCompletions: GoalStatsCategory[]
}

/**
 * Builds a read-only snapshot of goal health. Historical overdue counts use
 * the same rolling cadence calculation as Goal Rhythm and only consider
 * completions that had happened by each chart date.
 */
export function buildGoalStats(
  goals: Goal[],
  completions: GoalCompletion[],
  currentDate: string,
  rangeDays: number,
): GoalStats {
  const normalizedRangeDays = Math.max(1, Math.round(rangeDays))
  const rangeStart = shiftISODate(currentDate, -(normalizedRangeDays - 1))
  const knownGoalIds = new Set(goals.map((goal) => goal.id))
  const relevantCompletions = completions.filter(
    (completion) => knownGoalIds.has(completion.goalId) && completion.date <= currentDate,
  )
  const completionsByGoal = new Map<Id, GoalCompletion[]>()
  for (const completion of relevantCompletions) {
    const goalCompletions = completionsByGoal.get(completion.goalId) ?? []
    goalCompletions.push(completion)
    completionsByGoal.set(completion.goalId, goalCompletions)
  }
  const dates = Array.from(
    { length: normalizedRangeDays },
    (_, index) => shiftISODate(rangeStart, index),
  )
  const completionsByDate = countUniqueGoalCompletionsByDate(relevantCompletions)
  const rangeCompletions = relevantCompletions.filter((completion) => completion.date >= rangeStart)
  const daily = dates.map((date) => ({
    date,
    overdueGoals: goals.filter(
      (goal) => (goalDaysUntilLapse(goal, completionsByGoal.get(goal.id) ?? [], date) ?? 0) < 0,
    ).length,
    completedGoals: completionsByDate.get(date)?.size ?? 0,
  }))
  const activeDeadlines = goals
    .filter((goal) => isGoalActiveOnDate(goal, currentDate))
    .map((goal) => goalDaysUntilLapse(goal, completionsByGoal.get(goal.id) ?? [], currentDate))
  const overdueGoals = activeDeadlines.filter((daysUntilLapse) => (daysUntilLapse ?? 0) < 0).length
  const deadlineOutlook: GoalStatsCategory[] = [
    { label: 'Overdue', count: overdueGoals },
    ...Array.from({ length: 8 }, (_, daysFromToday) => ({
      label: shiftISODate(currentDate, daysFromToday),
      count: activeDeadlines.filter((daysUntilLapse) => daysUntilLapse === daysFromToday).length,
    })),
    {
      label: 'Later',
      count: activeDeadlines.filter((daysUntilLapse) => daysUntilLapse === null || daysUntilLapse > 7).length,
    },
  ]
  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const weekdayCompletions = weekdayLabels.map<GoalStatsCategory>((label) => ({ label, count: 0 }))
  for (const completion of rangeCompletions) {
    weekdayCompletions[weekdayIndex(completion.date)].count += 1
  }

  return {
    rangeDays: normalizedRangeDays,
    rangeStart,
    rangeEnd: currentDate,
    overdueGoals,
    completionsInRange: rangeCompletions.length,
    completionDays: new Set(rangeCompletions.map((completion) => completion.date)).size,
    averageOverdueGoals:
      daily.reduce((total, day) => total + day.overdueGoals, 0) / normalizedRangeDays,
    daily,
    deadlineOutlook,
    weekdayCompletions,
  }
}

function weekdayIndex(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return 0
  const sundayFirst = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
  return (sundayFirst + 6) % 7
}

function countUniqueGoalCompletionsByDate(
  completions: GoalCompletion[],
): Map<string, Set<Id>> {
  const byDate = new Map<string, Set<Id>>()
  for (const completion of completions) {
    const goalIds = byDate.get(completion.date) ?? new Set<Id>()
    goalIds.add(completion.goalId)
    byDate.set(completion.date, goalIds)
  }
  return byDate
}
