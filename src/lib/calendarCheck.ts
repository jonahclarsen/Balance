import { shiftISODate } from './goals'
import { createPlanItem } from './planner'
import type { DailyPlan, PlanItem } from './types'

// Asked before each day is planned. Add to day puts this task at the top,
// at most every other day.
export const CALENDAR_CHECK_TASK = 'Empty out your calendar'

function containsCalendarTask(items: PlanItem[]): boolean {
  return items.some((item) => item.text.trim() === CALENDAR_CHECK_TASK || containsCalendarTask(item.children))
}

export function calendarTaskAddedYesterday(plans: DailyPlan[], date: string): boolean {
  const yesterday = shiftISODate(date, -1)
  const plan = plans.find((candidate) => candidate.date === yesterday)
  return Boolean(plan && containsCalendarTask(plan.items))
}

export function createCalendarTask(): PlanItem {
  return createPlanItem(CALENDAR_CHECK_TASK)
}
