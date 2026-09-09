import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

test('feature actions emit generic patches that replay in the native database', async ({ page }, info) => {
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  const fixture = await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore: store } = await import(/* @vite-ignore */ path)
    let live: any
    const unsubscribe = store.subscribe((state: any) => { live = state })
    const initial = structuredClone(live)
    const start = live.operations.length
    const note = store.addNote()
    store.renameNote(note, 'Synthetic note')
    store.renameNote(note, 'Synthetic renamed note')
    const item = store.addRootNoteItem(note, 'checklist')
    store.patchNoteItem(note, item, { text: 'Synthetic checklist', html: 'Synthetic checklist', done: true })
    store.patchNoteItem(note, item, { text: 'Synthetic edited checklist', html: 'Synthetic edited checklist' })
    store.trashNote(note)
    store.restoreNote(note)
    const listTemplate = store.addListTemplate()
    store.renameListTemplate(listTemplate, 'Synthetic list')
    const listItem = store.addRootListTemplateItem(listTemplate)
    store.patchListTemplateItem(listTemplate, listItem, { text: 'Synthetic list task', html: 'Synthetic list task' })
    const list = store.ensureListForDate(listTemplate, live.activePlanDate)
    const generatedItem = live.lists.find((value: any) => value.id === list).items[0]
    store.patchListItem(list, generatedItem.id, { done: true })
    const metric = store.addMetric()
    store.renameMetric(metric, 'Synthetic metric')
    const question = store.addMetricQuestion(metric)
    store.upsertMetricAnswer(metric, live.activePlanDate, question, '3')
    store.upsertMetricAnswer(metric, live.activePlanDate, question, '5')
    const goal = store.addGoal('Synthetic goal', 7, ['synthetic'], 120)
    store.patchGoal(goal, { name: 'Synthetic renamed goal' })
    const project = store.addProject('Synthetic project')
    store.checkInProject(project, 35, 80)
    store.moveImage(() => {
      store.renameNote(note, 'Synthetic compound note edit')
      store.renameMetric(metric, 'Synthetic compound metric edit')
    })
    const result = { initial, operations: structuredClone(live.operations.slice(start)), expected: structuredClone(live) }
    unsubscribe()
    return result
  })
  expect(fixture.operations.length).toBeGreaterThan(15)
  for (const operation of fixture.operations) {
    expect(operation.payload.entityChanges.version).toBe(2)
    if (operation.type === 'move_image') {
      expect(operation.payload.operations.every((nested: any) => nested.type === 'apply_entity_changes')).toBe(true)
    } else {
      expect(operation.type).toBe('apply_entity_changes')
      expect(operation.payload.action).toEqual(expect.any(String))
    }
  }
  for (const collection of ['notes', 'listTemplates', 'lists', 'metrics', 'metricEntries', 'goals', 'projects', 'projectCheckIns']) {
    expect(fixture.operations.some((operation: any) => operation.payload.entityChanges.upserts.some((upsert: any) => upsert.collection === collection))).toBe(true)
  }
  mkdirSync('artifacts/entity-fixtures', { recursive: true })
  writeFileSync(`artifacts/entity-fixtures/${info.project.name}.json`, JSON.stringify(fixture))
})

test('regeneration preserves touched tasks above fresh tasks through reload and undo', async ({ page }, info) => {
  await page.goto('/')
  const fixture = await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore: store } = await import(/* @vite-ignore */ path)
    await store.ready
    let live: any
    const unsubscribe = store.subscribe((state: any) => { live = state })
    const templateId = store.addTemplate()
    const template = live.templates.find((value: any) => value.id === templateId)
    const root = template.items[0]
    store.patchTemplateOption(templateId, root.id, root.options[0].id, { text: 'Synthetic task', html: 'Synthetic task' })
    const initial = structuredClone(live)
    const start = live.operations.length
    const date = '2026-09-08'
    const plan = () => live.plans.find((value: any) => value.date === date)
    store.generatePlan(templateId, date, false)
    const originalId = plan().items[0].id
    const firstMarkerCount = live.uneditedPlanItems.length
    store.patchPlanItem(plan().id, originalId, { done: true })
    const checkOperation = structuredClone(live.operations.at(-1))
    const markerCountAfterCheck = live.uneditedPlanItems.length
    store.generatePlan(templateId, date, true)
    const afterFirst = structuredClone(plan())
    store.addRootPlanItem(plan().id)
    const manualId = plan().items.at(-1).id
    store.patchPlanItem(plan().id, manualId, { text: 'Synthetic manual task', html: 'Synthetic manual task' }, { mergeHistory: false })
    const beforeSecond = structuredClone(live)
    store.generatePlan(templateId, date, true)
    const afterSecond = structuredClone(live)
    const afterSecondPlan = structuredClone(plan())
    await store.undo()
    const undone = structuredClone(live)
    await store.redo()
    const redone = structuredClone(live)
    // Export only the authored operations; native CI independently undoes and
    // redoes every operation against generated encrypted fixture databases.
    const operations = afterSecond.operations.slice(start)
    const result = { initial, operations, expected: afterSecond, originalId, manualId, firstMarkerCount,
      markerCountAfterCheck, checkOperation, afterFirst, afterSecondPlan, beforeSecond, undone, redone }
    unsubscribe()
    return result
  })
  expect(fixture.afterSecondPlan.id).toBe(fixture.afterFirst.id)
  expect(fixture.checkOperation.payload.planDate).toBe('2026-09-08')
  const regeneration = fixture.operations.at(-1)
  expect(regeneration.type).toBe('regenerate_plan')
  expect(regeneration.payload.generatedPlan.items).toHaveLength(1)
  expect(regeneration.payload.replaceItems).toHaveLength(1)
  expect(regeneration.payload.replaceItems[0].id).toBe(fixture.afterFirst.items[1].id)
  expect(fixture.firstMarkerCount).toBe(1)
  expect(fixture.markerCountAfterCheck).toBe(0)
  expect(fixture.checkOperation.payload.entityChanges).toEqual({ version: 2, upserts: [], deletes: [{ collection: 'uneditedPlanItems', key: fixture.originalId }] })
  expect(fixture.afterFirst.items.map((item: any) => item.text)).toEqual(['Synthetic task', 'Synthetic task'])
  expect(fixture.afterFirst.items[0].done).toBe(true)
  expect(fixture.afterFirst.items[1].done).toBe(false)
  expect(fixture.afterSecondPlan.items.map((item: any) => item.text)).toEqual(['Synthetic task', 'Synthetic manual task', 'Synthetic task'])
  expect(fixture.afterSecondPlan.items.slice(0, 2).map((item: any) => item.id)).toEqual([fixture.originalId, fixture.manualId])
  expect(fixture.undone.plans).toEqual(fixture.beforeSecond.plans)
  expect(fixture.undone.uneditedPlanItems).toEqual(fixture.beforeSecond.uneditedPlanItems)
  expect(fixture.redone.plans).toEqual(fixture.expected.plans)
  expect(fixture.redone.uneditedPlanItems).toEqual(fixture.expected.uneditedPlanItems)
  await page.reload()
  const reloaded = await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore: store } = await import(/* @vite-ignore */ path)
    await store.ready
    let live: any
    const unsubscribe = store.subscribe((state: any) => { live = state })
    unsubscribe()
    return { items: live.plans.find((plan: any) => plan.date === '2026-09-08').items, markers: live.uneditedPlanItems }
  })
  expect(reloaded.items.map((item: any) => item.id)).toEqual(fixture.afterSecondPlan.items.map((item: any) => item.id))
  expect(reloaded.markers).toEqual(fixture.expected.uneditedPlanItems)
  mkdirSync('artifacts/entity-fixtures', { recursive: true })
  writeFileSync(`artifacts/entity-fixtures/regeneration-${info.project.name}.json`, JSON.stringify({
    initial: fixture.initial, operations: fixture.operations, expected: fixture.expected,
  }))
})

test('editing one generated task deletes one marker without rewriting the rest', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore: store } = await import(/* @vite-ignore */ path)
    await store.ready
    let live: any
    const unsubscribe = store.subscribe((state: any) => { live = state })
    const templateId = store.addTemplate()
    store.addRootTemplateItem(templateId)
    store.addRootTemplateItem(templateId)
    for (const item of live.templates.find((template: any) => template.id === templateId).items) {
      store.patchTemplateOption(templateId, item.id, item.options[0].id, { text: 'Synthetic task', html: 'Synthetic task' })
    }
    store.generatePlan(templateId, '2026-09-08', true)
    const plan = live.plans.find((plan: any) => plan.date === '2026-09-08')
    const markersBefore = structuredClone(live.uneditedPlanItems)
    store.patchPlanItem(plan.id, plan.items[0].id, { html: '<b>Synthetic task</b>', startMinutes: 540, endMinutes: 600 })
    const changes = structuredClone(live.operations.at(-1).payload.entityChanges)
    const remainingMarkers = structuredClone(live.uneditedPlanItems)
    await store.undo()
    const undoneMarkers = structuredClone(live.uneditedPlanItems)
    await store.redo()
    store.patchPlanItemsDone(plan.id, plan.items.map((item: any) => item.id), true)
    const completedMarkers = structuredClone(live.uneditedPlanItems)
    unsubscribe()
    return { markersBefore, changes, remainingMarkers, undoneMarkers, completedMarkers }
  })
  expect(result.markersBefore).toHaveLength(3)
  expect(result.changes.upserts).toEqual([])
  expect(result.changes.deletes).toHaveLength(1)
  expect(result.remainingMarkers).toHaveLength(2)
  expect(result.undoneMarkers).toEqual(result.markersBefore)
  expect(result.completedMarkers).toEqual([])
})
