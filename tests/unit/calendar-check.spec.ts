import { expect, test } from '@playwright/test'
import { CALENDAR_CHECK_TASK, calendarTaskAddedYesterday } from '../../src/lib/calendarCheck'
import { createPlanItem } from '../../src/lib/planner'
import type { DailyPlan } from '../../src/lib/types'

const plan = (date: string, texts: string[]) => ({ id: date, date, items: texts.map((text) => createPlanItem(text)) }) as unknown as DailyPlan

test('the calendar task can be added unless it was on the day before', () => {
  expect(calendarTaskAddedYesterday([plan('2026-09-16', [CALENDAR_CHECK_TASK])], '2026-09-17')).toBe(true)
  expect(calendarTaskAddedYesterday([plan('2026-09-15', [CALENDAR_CHECK_TASK])], '2026-09-17')).toBe(false)
  expect(calendarTaskAddedYesterday([plan('2026-09-16', ['Wake up'])], '2026-09-17')).toBe(false)
  const nested = plan('2026-09-16', ['Morning'])
  nested.items[0].children = [createPlanItem(CALENDAR_CHECK_TASK)]
  expect(calendarTaskAddedYesterday([nested], '2026-09-17')).toBe(true)
})
