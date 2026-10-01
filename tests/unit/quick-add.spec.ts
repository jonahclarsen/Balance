import { expect, test } from '@playwright/test'
import { createPlanItem, insertQuickTask, insertSiriReminder } from '../../src/lib/planner'
import type { PlanItem } from '../../src/lib/types'

function item(id: string, done = false, children: PlanItem[] = []): PlanItem {
  return { ...createPlanItem(id), id, done, children }
}

test('quick add lands where a new Siri heading would, as a plain task', () => {
  const items = [item('done', true), item('parent', false, [item('child-done', true), item('child')])]
  const quick = insertQuickTask(items, 'Synthetic quick task')
  const siri = insertSiriReminder(items, 'Synthetic quick task')

  expect([quick.parentId, quick.position]).toEqual([siri.parentId, siri.position])
  expect(quick.heading).toBe(quick.item)
  expect(quick.headingId).toBe(quick.item.id)
  expect(quick.items[1].children.map(({ text }) => text)).toEqual(['child-done', 'Synthetic quick task', 'child'])
})

test('quick add never creates a Siri heading', () => {
  const quick = insertQuickTask([item('next')], 'Synthetic quick task')
  expect(quick.items.map(({ text }) => text)).toEqual(['Synthetic quick task', 'next'])
})
