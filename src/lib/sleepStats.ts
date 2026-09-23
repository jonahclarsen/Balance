import { shiftISODate } from './goals'
import { hasActiveTimeRange } from './planner'
import type { DailyPlan, PlanItem } from './types'

export const SLEEP_STATS_RANGES = [30, 90, 180] as const

export type SleepStatsRangeDays = (typeof SLEEP_STATS_RANGES)[number]

export type SleepStatsDay = {
  date: string
  // Minutes from the plan date's midnight; bedtimes after midnight exceed 1440.
  wakeMinutes: number | null
  bedMinutes: number | null
  // The sleep that ended on this day's wake time, measured from the previous
  // day's bedtime.
  sleepMinutes: number | null
}

export type SleepStats = {
  rangeStart: string
  rangeEnd: string
  daily: SleepStatsDay[]
  averageWakeMinutes: number | null
  averageBedMinutes: number | null
  averageSleepMinutes: number | null
}

/**
 * Treats the first timed task on a day as waking up and the end of the last
 * timed task as going to bed, when the day's schedule covers those edges.
 */
export function buildSleepStats(plans: DailyPlan[], currentDate: string, rangeDays: number): SleepStats {
  const normalizedRangeDays = Math.max(1, Math.round(rangeDays))
  const rangeStart = shiftISODate(currentDate, -(normalizedRangeDays - 1))
  const plansByDate = new Map(plans.map((plan) => [plan.date, plan]))
  const dayBounds = (date: string) => timedBounds(plansByDate.get(date)?.items ?? [])
  let previousBounds = dayBounds(shiftISODate(rangeStart, -1))
  const daily = Array.from({ length: normalizedRangeDays }, (_, index) => {
    const date = shiftISODate(rangeStart, index)
    const bounds = dayBounds(date)
    const sleepMinutes = bounds.wakeMinutes !== null && previousBounds.bedMinutes !== null
      ? bounds.wakeMinutes + 1440 - previousBounds.bedMinutes
      : null
    previousBounds = bounds
    return {
      date,
      wakeMinutes: bounds.wakeMinutes,
      bedMinutes: bounds.bedMinutes,
      sleepMinutes: sleepMinutes !== null && sleepMinutes > 0 ? sleepMinutes : null,
    }
  })

  return {
    rangeStart,
    rangeEnd: currentDate,
    daily,
    averageWakeMinutes: average(daily.map((day) => day.wakeMinutes)),
    averageBedMinutes: average(daily.map((day) => day.bedMinutes)),
    averageSleepMinutes: average(daily.map((day) => day.sleepMinutes)),
  }
}

// A day whose first task is untimed probably started before its schedule
// did, and one whose last top-level task is untimed probably ran past it, so
// those days give no wake time or bedtime rather than an inaccurate one.
function timedBounds(items: PlanItem[]): { wakeMinutes: number | null; bedMinutes: number | null } {
  let wakeMinutes = Infinity
  let bedMinutes = -Infinity
  const visit = (items: PlanItem[]) => {
    for (const item of items) {
      if (hasActiveTimeRange(item)) {
        wakeMinutes = Math.min(wakeMinutes, item.startMinutes)
        bedMinutes = Math.max(bedMinutes, item.endMinutes)
      }
      visit(item.children)
    }
  }
  visit(items)
  const firstItem = items[0]
  const lastItem = items.at(-1)
  return {
    wakeMinutes: firstItem && hasActiveTimeRange(firstItem) && Number.isFinite(wakeMinutes) ? wakeMinutes : null,
    bedMinutes: lastItem && hasActiveTimeRange(lastItem) && Number.isFinite(bedMinutes) ? bedMinutes : null,
  }
}

function average(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0) / present.length
}
