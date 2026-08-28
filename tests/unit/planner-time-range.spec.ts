import { expect, test } from '@playwright/test'
import { defaultPlanItemTimeRange } from '../../src/lib/planner'
import type { PlanItem } from '../../src/lib/types'

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
