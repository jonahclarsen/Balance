import { expect, test } from '@playwright/test'
import { createInitialState, createPlanItem } from '../../src/lib/planner'
import { historyDestination } from '../../src/lib/historyNavigation'
import type { AppState } from '../../src/lib/types'

function fixture(): AppState {
  return {
    ...createInitialState(),
    plans: [{ id: 'plan', date: '2026-08-20', title: 'Thursday', dailyReminder: '', generatedFromTemplateId: null, createdAt: '',
      items: [{ ...createPlanItem(), id: 'parent', text: 'Parent', children: [{ ...createPlanItem(), id: 'child', text: 'Child' }] }] }],
  }
}

test('finds a nested completion on its actual date without highlighting its parent', () => {
  const before = fixture()
  const after = structuredClone(before)
  after.plans[0].items[0].children[0].done = true
  expect(historyDestination(before, after)).toMatchObject({ view: 'today', date: '2026-08-20', itemId: 'child', label: 'completion · 2026-08-20' })
})

test('reveals a surviving parent when undo removes a nested item', () => {
  const before = fixture()
  const after = structuredClone(before)
  after.plans[0].items[0].children = []
  expect(historyDestination(before, after)).toMatchObject({ itemId: 'parent', removed: true })
})

test('navigation, timestamps, and derived goal completions do not select a destination', () => {
  const before = fixture()
  const after = structuredClone(before)
  after.activePlanDate = '2026-09-05'
  after.goalCompletions = [{ goalId: 'g', date: '2026-08-20', itemIds: [], matchedTerms: [], computedAt: '' }]
  expect(historyDestination(before, after)).toBeNull()
})

test('follows a moved task to the destination day instead of its old location', () => {
  const before = fixture()
  const after = structuredClone(before)
  const moved = after.plans[0].items[0].children.pop()!
  after.plans.push({ ...after.plans[0], id: 'destination', date: '2026-08-21', items: [moved] })
  expect(historyDestination(before, after)).toMatchObject({ entityId: 'destination', date: '2026-08-21', itemId: 'child', removed: false })
})

test('finds the exact metric and question for an answer on another day', () => {
  const before = fixture()
  const after = structuredClone(before)
  after.metricEntries = [{ id: 'entry', metricId: 'metric', date: '2026-08-19', answers: [{ questionId: 'q2', value: 'y' }], createdAt: '', updatedAt: '' }]
  expect(historyDestination(before, after)).toMatchObject({ view: 'metrics', entityId: 'metric', itemId: 'q2', date: '2026-08-19' })
})

test('reordering documents reveals their page even when their contents are unchanged', () => {
  const before = fixture()
  before.notes = [
    { id: 'a', title: 'A', items: [], createdAt: '', updatedAt: '' },
    { id: 'b', title: 'B', items: [], createdAt: '', updatedAt: '' },
  ]
  const after = { ...before, notes: [...before.notes].reverse() }
  expect(historyDestination(before, after)).toMatchObject({ view: 'notes', entityId: 'b' })
})
