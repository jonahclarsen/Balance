import { goalDaysUntilLapse, isGoalActiveOnDate, shiftISODate } from './goals'
import type { Goal, GoalCompletion, Id } from './types'

export const GOAL_STATS_RANGES = [30, 90, 180] as const

export type GoalStatsRangeDays = (typeof GOAL_STATS_RANGES)[number]

export type GoalStatsDay = {
  date: string
  overdueGoals: number
  completedGoals: number
}

export type GoalStatsGoal = {
  goal: Goal
  completionsInRange: number
  latestCompletionDate: string | null
  daysUntilLapse: number | null
}

export type GoalStats = {
  rangeDays: number
  rangeStart: string
  rangeEnd: string
  activeGoals: number
  archivedGoals: number
  overdueGoals: number
  onTrackGoals: number
  completionsInRange: number
  completionDays: number
  completedGoalsInRange: number
  averageOverdueGoals: number
  daily: GoalStatsDay[]
  needsAttention: GoalStatsGoal[]
  mostCompleted: GoalStatsGoal[]
  cadence: {
    daily: number
    weekly: number
    longer: number
  }
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
  const completionDatesByGoal = new Map<Id, string[]>()

  for (const completion of relevantCompletions) {
    const datesForGoal = completionDatesByGoal.get(completion.goalId) ?? []
    datesForGoal.push(completion.date)
    completionDatesByGoal.set(completion.goalId, datesForGoal)
  }

  const daily = dates.map((date) => ({
    date,
    overdueGoals: goals.filter(
      (goal) => (goalDaysUntilLapse(goal, completionsByGoal.get(goal.id) ?? [], date) ?? 0) < 0,
    ).length,
    completedGoals: completionsByDate.get(date)?.size ?? 0,
  }))
  const active = goals.filter((goal) => isGoalActiveOnDate(goal, currentDate))
  const goalRows = goals.map<GoalStatsGoal>((goal) => {
    const completionDates = completionDatesByGoal.get(goal.id) ?? []
    return {
      goal,
      completionsInRange: new Set(
        completionDates.filter((date) => date >= rangeStart && date <= currentDate),
      ).size,
      latestCompletionDate: [...completionDates].sort().at(-1) ?? null,
      daysUntilLapse: goalDaysUntilLapse(goal, completionsByGoal.get(goal.id) ?? [], currentDate),
    }
  })
  const needsAttention = goalRows
    .filter((row) => row.daysUntilLapse !== null && row.daysUntilLapse < 0)
    .sort(
      (left, right) =>
        (left.daysUntilLapse ?? 0) - (right.daysUntilLapse ?? 0) ||
        left.goal.name.localeCompare(right.goal.name),
    )
  const mostCompleted = goalRows
    .filter((row) => row.completionsInRange > 0)
    .sort(
      (left, right) =>
        right.completionsInRange - left.completionsInRange ||
        (right.latestCompletionDate ?? '').localeCompare(left.latestCompletionDate ?? '') ||
        left.goal.name.localeCompare(right.goal.name),
    )
  const cadence = active.reduce(
    (summary, goal) => {
      if (goal.cadenceDays === 1) summary.daily += 1
      else if (goal.cadenceDays <= 7) summary.weekly += 1
      else summary.longer += 1
      return summary
    },
    { daily: 0, weekly: 0, longer: 0 },
  )
  const overdueGoals = needsAttention.length

  return {
    rangeDays: normalizedRangeDays,
    rangeStart,
    rangeEnd: currentDate,
    activeGoals: active.length,
    archivedGoals: goals.length - active.length,
    overdueGoals,
    onTrackGoals: active.length - overdueGoals,
    completionsInRange: rangeCompletions.length,
    completionDays: new Set(rangeCompletions.map((completion) => completion.date)).size,
    completedGoalsInRange: new Set(rangeCompletions.map((completion) => completion.goalId)).size,
    averageOverdueGoals:
      daily.reduce((total, day) => total + day.overdueGoals, 0) / normalizedRangeDays,
    daily,
    needsAttention,
    mostCompleted,
    cadence,
  }
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
