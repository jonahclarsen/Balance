import { expect, test } from '@playwright/test'
import { buildSleepStats } from '../../src/lib/sleepStats'
import type { DailyPlan, PlanItem } from '../../src/lib/types'

function item(id: string, startMinutes: number | null, endMinutes: number | null, children: PlanItem[] = []): PlanItem {
  return { id, text: id, html: id, done: false, startMinutes, endMinutes, children }
}

function plan(date: string, items: PlanItem[]): DailyPlan {
  return {
    id: `plan-${date}`,
    date,
    title: '',
    dailyReminder: '',
    generatedFromTemplateId: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    items,
  }
}

test('wake and bedtime come from the first and last timed tasks, including nested and past-midnight tasks', () => {
  const stats = buildSleepStats([
    plan('2026-09-01', [item('late', 22 * 60, 23 * 60 + 30), item('untimed', null, null)]),
    plan('2026-09-02', [
      item('parent', null, null, [item('breakfast', 7 * 60, 7 * 60 + 30)]),
      { ...item('hidden', 5 * 60, 6 * 60), timeHidden: true },
      item('night', 23 * 60, 24 * 60 + 45),
    ]),
    plan('2026-09-03', [item('run', 8 * 60 + 15, 9 * 60)]),
  ], '2026-09-04', 3)

  expect(stats.rangeStart).toBe('2026-09-02')
  expect(stats.daily).toEqual([
    { date: '2026-09-02', wakeMinutes: 420, bedMinutes: 1485, priorBedMinutes: 1410 - 1440, sleepMinutes: 420 + 1440 - 1410 },
    { date: '2026-09-03', wakeMinutes: 495, bedMinutes: 540, priorBedMinutes: 1485 - 1440, sleepMinutes: 495 + 1440 - 1485 },
    { date: '2026-09-04', wakeMinutes: null, bedMinutes: null, priorBedMinutes: 540 - 1440, sleepMinutes: null },
  ])
  expect(stats.averageWakeMinutes).toBe((420 + 495) / 2)
  expect(stats.averageSleepMinutes).toBe((450 + 450) / 2)
})

test('sleep duration needs timed tasks on both days', () => {
  const stats = buildSleepStats([plan('2026-09-02', [item('only', 9 * 60, 17 * 60)])], '2026-09-02', 2)
  expect(stats.daily.map((day) => day.sleepMinutes)).toEqual([null, null])
  expect(stats.averageSleepMinutes).toBeNull()
})
