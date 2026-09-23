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
  // The previous day's bedtime, relative to this day's midnight (usually negative).
  priorBedMinutes: number | null
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
 * timed task as going to bed.
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
    const sleepMinutes = bounds && previousBounds
      ? bounds.wakeMinutes + 1440 - previousBounds.bedMinutes
      : null
    const priorBounds = previousBounds
    previousBounds = bounds
    return {
      date,
      wakeMinutes: bounds?.wakeMinutes ?? null,
      bedMinutes: bounds?.bedMinutes ?? null,
      priorBedMinutes: priorBounds ? priorBounds.bedMinutes - 1440 : null,
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

function timedBounds(items: PlanItem[]): { wakeMinutes: number; bedMinutes: number } | null {
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
  return Number.isFinite(wakeMinutes) ? { wakeMinutes, bedMinutes } : null
}

function average(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0) / present.length
}
