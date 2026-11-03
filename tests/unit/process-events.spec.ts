import { expect, test } from '@playwright/test'
import { createPlanItem, processEventsDate, processEventsItems } from '../../src/lib/planner'
import type { DailyPlan, PlanItem } from '../../src/lib/types'

function plan(date: string, items: PlanItem[]): DailyPlan {
  return { id: `plan_${date}`, date, title: date, dailyReminder: '', generatedFromTemplateId: null, generatedGoalIds: [], createdAt: '', items }
}

const open = () => createPlanItem('Open')
const done = () => ({ ...createPlanItem('Done'), done: true })
const noon = new Date('2026-11-03T12:00:00')

test('one linked row per earlier day with open tasks, oldest first', () => {
  const rows = processEventsItems([
    plan('2026-11-02', [done(), open()]),
    plan('2026-11-01', [done()]),
    plan('2026-10-31', [{ ...done(), children: [open()] }]),
    plan('2026-11-03', [open()]),
  ], '2026-11-03', noon)

  expect(rows.map(({ text }) => text)).toEqual(['Process events from October 31', 'Process events from November 2'])
  expect(rows[1].html).toBe('Process events from <a href="balance://day/2026-11-02">November 2</a>')
  expect(rows.map(processEventsDate)).toEqual(['2026-10-31', '2026-11-02'])
  expect(rows.every(({ done }) => !done)).toBe(true)
})

test('the previous calendar day counts as current until 7 a.m.', () => {
  const plans = [plan('2026-11-02', [open()])]
  expect(processEventsItems(plans, '2026-11-03', new Date('2026-11-03T06:59:00'))).toEqual([])
  expect(processEventsItems(plans, '2026-11-03', new Date('2026-11-03T07:00:00'))).toHaveLength(1)
})

test('blank rows are not open tasks', () => {
  expect(processEventsItems([plan('2026-11-02', [createPlanItem('')])], '2026-11-03', noon)).toEqual([])
})

test('future days get rows and backfilled past days do not', () => {
  const plans = [plan('2026-10-30', [open()])]
  expect(processEventsItems(plans, '2026-11-05', noon)).toHaveLength(1)
  expect(processEventsItems(plans, '2026-11-02', noon)).toEqual([])
})
