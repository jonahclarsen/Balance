import { expect, test } from '@playwright/test'
import { defaultPlanItemTimeRange, defaultTemplateItemTimeRange } from '../../src/lib/planner'
import type { PlanItem, TemplateItem } from '../../src/lib/types'

function item(
  id: string,
  startMinutes: number | null = null,
  endMinutes: number | null = null,
  children: PlanItem[] = [],
): PlanItem {
  return {
    id,
    text: id,
    html: id,
    done: false,
    startMinutes,
    endMinutes,
    children,
  }
}

test('a child starts with its timed parent while a peer starts after it', () => {
  const child = item('child')
  const peer = item('peer')
  const items = [item('parent', 90, 300, [child]), peer]

  expect(defaultPlanItemTimeRange(items, child.id)).toEqual({ startMinutes: 90, endMinutes: 150 })
  expect(defaultPlanItemTimeRange(items, peer.id)).toEqual({ startMinutes: 300, endMinutes: 360 })
})

test('a timed child does not replace its timed parent as the boundary for a later peer', () => {
  const peer = item('peer')
  const items = [item('parent', 90, 300, [item('child', 120, 210)]), peer]

  expect(defaultPlanItemTimeRange(items, peer.id)).toEqual({ startMinutes: 300, endMinutes: 360 })
})

test('a later child still starts after its timed sibling', () => {
  const laterChild = item('later-child')
  const items = [item('parent', 90, 300, [item('timed-child', 120, 210), laterChild])]

  expect(defaultPlanItemTimeRange(items, laterChild.id)).toEqual({ startMinutes: 210, endMinutes: 270 })
})

for (const [hour, minute, startMinutes] of [[8, 59, 540], [9, 0, 540], [9, 14, 540], [9, 15, 555], [14, 38, 870], [23, 59, 1425]]) {
  test(`first time at ${hour}:${minute} uses the latest quarter-hour after 9 a.m.`, () => {
    const task = item('task')
    const now = new Date(2026, 8, 5, hour, minute)
    expect(defaultPlanItemTimeRange([task], task.id, '2026-09-05', now)).toEqual({
      startMinutes, endMinutes: startMinutes + 60,
    })
  })
}

test('other dates and undated plans retain the 9 a.m. default', () => {
  const task = item('task')
  const now = new Date(2026, 8, 5, 14, 38)
  for (const date of ['2026-09-04', '2026-09-06', '']) {
    expect(defaultPlanItemTimeRange([task], task.id, date, now)).toEqual({ startMinutes: 540, endMinutes: 600 })
  }
})

test('existing times supply boundaries before and after untimed tasks', () => {
  const task = item('task')
  const timed = item('timed', 780, 840)
  const now = new Date(2026, 8, 5, 14, 38)
  expect(defaultPlanItemTimeRange([timed, task], task.id, '2026-09-05', now)).toEqual({ startMinutes: 840, endMinutes: 900 })
  expect(defaultPlanItemTimeRange([task, item('parent', null, null, [timed])], task.id, '2026-09-05', now)).toEqual({ startMinutes: 720, endMinutes: 780 })
})

test('hidden times do not prevent the first visible time from using the current quarter-hour', () => {
  const task = item('task')
  const hidden = { ...item('hidden', 600, 660), timeHidden: true }
  expect(defaultPlanItemTimeRange([hidden, task], task.id, '2026-09-05', new Date(2026, 8, 5, 14, 38)))
    .toEqual({ startMinutes: 870, endMinutes: 930 })
})

test('after midnight before rollover, the current quarter-hour belongs to the previous plan day', () => {
  const task = item('task')
  expect(defaultPlanItemTimeRange([task], task.id, '2026-09-05', new Date(2026, 8, 6, 1, 38)))
    .toEqual({ startMinutes: 1530, endMinutes: 1590 })
})

for (const date of ['2026-09-05', '2026-09-06', '']) {
  test(`a task before the first timed task works backward on ${date || 'an undated plan'}`, () => {
    const task = item('task')
    const items = [task, item('untimed'), item('timed', 780, 840), item('later', 900, 960)]
    expect(defaultPlanItemTimeRange(items, task.id, date, new Date(2026, 8, 5, 14, 38)))
      .toEqual({ startMinutes: 720, endMinutes: 780 })
  })
}

test('a task between timed tasks still follows the previous time', () => {
  const task = item('task')
  expect(defaultPlanItemTimeRange([item('previous', 600, 660), task, item('next', 900, 960)], task.id))
    .toEqual({ startMinutes: 660, endMinutes: 720 })
})

test('hidden times are skipped when looking forward', () => {
  const task = item('task')
  const hidden = { ...item('hidden', 600, 660), timeHidden: true }
  expect(defaultPlanItemTimeRange([task, hidden, item('timed', 780, 840)], task.id))
    .toEqual({ startMinutes: 720, endMinutes: 780 })
})

test('an untimed child can work backward from a later task outside its parent', () => {
  const child = item('child')
  expect(defaultPlanItemTimeRange([item('parent', null, null, [child]), item('timed', 780, 840)], child.id))
    .toEqual({ startMinutes: 720, endMinutes: 780 })
})

test('a parent does not work backward from its own timed child', () => {
  const parent = item('parent', null, null, [item('child', 600, 660)])
  expect(defaultPlanItemTimeRange([parent], parent.id)).toEqual({ startMinutes: 540, endMinutes: 600 })
})

for (const [nextStart, startMinutes, endMinutes] of [[480, 420, 480], [30, 0, 30], [0, 0, 60], [1500, 1440, 1500]]) {
  test(`working backward from minute ${nextStart} stays within the timeline`, () => {
    const task = item('task')
    expect(defaultPlanItemTimeRange([task, item('next', nextStart, nextStart + 60)], task.id))
      .toEqual({ startMinutes, endMinutes })
  })
}

test('template tasks also work backward from the first timed task', () => {
  const task: TemplateItem = { id: 'task', startMinutes: null, endMinutes: null, options: [], children: [] }
  const timed: TemplateItem = { id: 'timed', startMinutes: 780, endMinutes: 840, options: [], children: [] }
  expect(defaultTemplateItemTimeRange([task, timed], task.id)).toEqual({ startMinutes: 720, endMinutes: 780 })
})
