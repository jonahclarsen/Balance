import { expect, test } from '@playwright/test'
import { createInitialState, createPlanItem } from '../../src/lib/planner'
import { generatedItemMarkers, preservedPlanItems, reconcileUneditedPlanItems } from '../../src/lib/planGeneration'
import type { AppState, DailyPlan, PlanItem } from '../../src/lib/types'

function fixture(): AppState {
  const state = createInitialState()
  const items = ['a', 'b', 'c'].map((id) => ({ ...createPlanItem(id), id }))
  state.plans = [{ id: 'plan', date: '2026-09-08', title: 'Synthetic day', dailyReminder: '', generatedFromTemplateId: 'template', createdAt: '', items }]
  state.uneditedPlanItems = generatedItemMarkers(items)
  return state
}
function edit(state: AppState, items: PlanItem[]) {
  return reconcileUneditedPlanItems(state, { ...state, plans: [{ ...state.plans[0], items }] })
}
function ids(state: AppState) { return state.uneditedPlanItems.map(({ id }) => id) }

for (const [name, patch] of Object.entries({
  text: { text: 'Changed' }, formatting: { html: '<b>a</b>' }, checking: { done: true },
  time: { startMinutes: 540 }, hidingTime: { timeHidden: true },
})) {
  test(`${name} removes just that task's marker`, () => {
    const before = fixture()
    const [a, b, c] = before.plans[0].items
    expect(ids(edit(before, [{ ...a, ...patch }, b, c]))).toEqual(['b', 'c'])
  })
}

test('insertion and deletion do not mark following siblings as edited', () => {
  const before = fixture()
  expect(ids(edit(before, [createPlanItem('Manual'), ...before.plans[0].items]))).toEqual(['a', 'b', 'c'])
  expect(ids(edit(before, before.plans[0].items.slice(1)))).toEqual(['b', 'c'])
})

test('reordering, indentation and moving to another date remove markers', () => {
  const before = fixture()
  const [a, b, c] = before.plans[0].items
  expect(ids(edit(before, [b, a, c]))).toEqual(['c'])
  expect(ids(edit(before, [{ ...a, children: [b] }, c]))).toEqual(['c'])
  const moved = { ...before, plans: [{ ...before.plans[0], id: 'other', date: '2026-09-09' }] }
  expect(ids(reconcileUneditedPlanItems(before, moved))).toEqual([])
})

test('manual reversal does not restore the marker; no-op edits retain it', () => {
  const before = fixture()
  const [a, b, c] = before.plans[0].items
  const edited = edit(before, [{ ...a, done: true }, b, c])
  expect(ids(edit(edited, [a, b, c]))).toEqual(['b', 'c'])
  expect(ids(edit(before, [{ ...a }, b, c]))).toEqual(['a', 'b', 'c'])
})

test('preserves changed child groups and legacy days with no markers', () => {
  const before = fixture()
  const [a, b, c] = before.plans[0].items
  const child = { ...createPlanItem('Nested'), id: 'child' }
  const plan: DailyPlan = { ...before.plans[0], items: [{ ...a, children: [child] }, b, c] }
  const markers = generatedItemMarkers(plan.items)
  expect(preservedPlanItems(plan, markers)).toEqual([])
  expect(preservedPlanItems(plan, markers.filter(({ id }) => id !== 'child'))).toEqual([plan.items[0]])
  expect(preservedPlanItems(plan, [])).toEqual(plan.items)
})

test('unrelated actions and days retain marker references; deleted plans leave no markers', () => {
  const before = fixture()
  expect(reconcileUneditedPlanItems(before, { ...before, activePlanDate: '2026-09-09' }).uneditedPlanItems).toBe(before.uneditedPlanItems)
  expect(reconcileUneditedPlanItems(before, { ...before, plans: [{ ...before.plans[0], dailyReminder: 'Changed' }] }).uneditedPlanItems).toBe(before.uneditedPlanItems)
  expect(ids(reconcileUneditedPlanItems(before, { ...before, plans: [] }))).toEqual([])
})
