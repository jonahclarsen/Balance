import { expect, test } from '@playwright/test'
import { createDailyTemplate, createInitialState, createTemplateItem } from '../../src/lib/planner'
import { generateDay, openView } from '../helpers/navigation'

test('generated sunset notification snapshots persist, regenerate, delete and undo with the day', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-01T12:00:00'))
  const state = createInitialState()
  const template = createDailyTemplate('Synthetic sunset')
  template.items = [createTemplateItem('Walk {sunset+6h}')]
  state.templates = [template]
  state.plans = []
  state.activePlanDate = '2026-10-01'
  await page.addInitScript(state => {
    if (!localStorage.getItem('balance.appState.v1')) localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, state)
  await page.goto('/')
  await openView(page, 'Today')
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await generateDay(page)
  const snapshot = () => page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore: store } = await import(/* @vite-ignore */ path)
    await store.ready
    let state: any
    const stop = store.subscribe((value: any) => { state = value })
    stop()
    return { plan: state.plans.find((plan: any) => plan.date === '2026-10-01'), records: state.taskNotifications }
  })
  const first = await snapshot()
  expect(first.records).toHaveLength(1)
  expect(first.records[0]).toMatchObject({ sourceId: first.plan.id, itemId: first.plan.items[0].id, text: 'Walk 12:51 AM', at: Date.parse('2026-10-02T07:51:00Z') })
  await page.reload()
  await openView(page, 'Today')
  expect((await snapshot()).records).toEqual(first.records)
  page.once('dialog', dialog => dialog.accept())
  await generateDay(page)
  const regenerated = await snapshot()
  expect(regenerated.records).toHaveLength(1)
  expect(regenerated.records[0].id).not.toBe(first.records[0].id)
  expect(regenerated.records[0].sourceId).toBe(regenerated.plan.id)
  await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore: store } = await import(/* @vite-ignore */ path)
    let state: any
    const stop = store.subscribe((value: any) => { state = value })
    const plan = state.plans.find((plan: any) => plan.date === '2026-10-01')
    store.deletePlanItem(plan.id, plan.items[0].id)
    stop()
  })
  expect((await snapshot()).records).toEqual([])
  await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore: store } = await import(/* @vite-ignore */ path)
    await store.undo()
  })
  expect((await snapshot()).records).toEqual(regenerated.records)
})
