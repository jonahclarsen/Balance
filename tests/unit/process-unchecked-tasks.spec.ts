import { expect, test } from '@playwright/test'
import { createPlanItem, processUncheckedTasksDate, processUncheckedTasksItems } from '../../src/lib/planner'
import type { DailyPlan, PlanItem } from '../../src/lib/types'

function plan(date: string, items: PlanItem[]): DailyPlan {
  return { id: `plan_${date}`, date, title: date, dailyReminder: '', generatedFromTemplateId: null, generatedGoalIds: [], createdAt: '', items }
}

const open = () => createPlanItem('Open')
const done = () => ({ ...createPlanItem('Done'), done: true })
const noon = new Date('2026-11-03T12:00:00')

test('one linked row per earlier day with open tasks, oldest first', () => {
  const rows = processUncheckedTasksItems([
    plan('2026-11-02', [done(), open()]),
    plan('2026-11-01', [done()]),
    plan('2026-10-31', [{ ...done(), children: [open()] }]),
    plan('2026-11-03', [open()]),
  ], '2026-11-03', noon)

  expect(rows.map(({ text }) => text)).toEqual(['Process unchecked tasks from October 31', 'Process unchecked tasks from November 2'])
  expect(rows[1].html).toBe('Process unchecked tasks from <a href="balance://day/2026-11-02">November 2</a>')
  expect(rows.map(processUncheckedTasksDate)).toEqual(['2026-10-31', '2026-11-02'])
  expect(rows.every(({ done }) => !done)).toBe(true)
})

test('the previous calendar day counts as current until 7 a.m.', () => {
  const plans = [plan('2026-11-02', [open()])]
  expect(processUncheckedTasksItems(plans, '2026-11-03', new Date('2026-11-03T06:59:00'))).toEqual([])
  expect(processUncheckedTasksItems(plans, '2026-11-03', new Date('2026-11-03T07:00:00'))).toHaveLength(1)
})

test('blank rows are not open tasks', () => {
  expect(processUncheckedTasksItems([plan('2026-11-02', [createPlanItem('')])], '2026-11-03', noon)).toEqual([])
})

test('future days get rows and backfilled past days do not', () => {
  const plans = [plan('2026-10-30', [open()])]
  expect(processUncheckedTasksItems(plans, '2026-11-05', noon)).toHaveLength(1)
  expect(processUncheckedTasksItems(plans, '2026-11-02', noon)).toEqual([])
})
