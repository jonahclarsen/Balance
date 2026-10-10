import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-08T12:00:00'))
})

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
    const followingItem = store.addRootNoteItem(note)
    store.patchNoteItem(note, followingItem, { text: 'Synthetic suffix', html: 'Synthetic suffix' })
    const sourceNote = live.notes.find((value: any) => value.id === note)
    const replacement = sourceNote.items.find((value: any) => value.id === item)
    const suffix = sourceNote.items.find((value: any) => value.id === followingItem)
    store.replaceNoteItems(note, [
      ...sourceNote.items.filter((value: any) => value.id !== item && value.id !== followingItem),
      { ...replacement, text: 'Synthetic replacement', html: '<b>Synthetic replacement</b>', kind: 'paragraph', done: false },
      { ...suffix, id: 'synthetic-pasted-note-item', text: 'Synthetic pasted suffix', html: 'Synthetic pasted suffix' },
    ], 'paste')
    store.trashNote(note)
    store.restoreNote(note)
    const listTemplate = store.addListTemplate()
    store.renameListTemplate(listTemplate, 'Synthetic list')
    const listItem = store.addRootListTemplateItem(listTemplate)
    store.patchListTemplateItem(listTemplate, listItem, { text: 'Synthetic list task', html: 'Synthetic list task' })
    store.setTemplateListExpansion('synthetic-option', listTemplate, true)
    store.setTemplateListExpansion('synthetic-option', listTemplate, false)
    store.setTemplateListExpansion('synthetic-option', listTemplate, true)
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
    store.checkInProject(project, 45, 75)
    const checkIn = live.projectCheckIns.find((entry: any) => entry.projectId === project)
    store.updateProjectCheckIn(checkIn.id, 55, 70)
    store.deleteProjectCheckIn(checkIn.id)
    store.checkInProject(project, 60, 65)
    const idea = store.addIdea('Synthetic idea')
    const fragment = store.addIdea('Synthetic fragment')
    store.appendIdeaToPrevious(fragment, idea)
    store.moveIdeaToBucket(idea, 'genuine')
    const ideaBucket = live.ideaBuckets.find((bucket: any) => bucket.kind === 'genuine')
    store.patchIdeaItem(ideaBucket.id, idea, { text: 'Synthetic renamed idea', html: 'Synthetic renamed idea' })
    const trashed = store.addIdea('Synthetic trashed idea')
    store.moveIdeaToBucket(trashed, 'trash')
    store.purgeExpiredIdeas(Date.now() + 31 * 24 * 60 * 60 * 1000)
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
  for (const collection of ['templateListExpansions', 'notes', 'listTemplates', 'lists', 'metrics', 'metricEntries', 'goals', 'projects', 'projectCheckIns', 'ideaBuckets']) {
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

test('day template paste remaps nested expansion choices in the same persisted operation', async ({ page }, info) => {
  await page.goto('/')
  const fixture = await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore: store } = await import(/* @vite-ignore */ path)
    let live: any
    const unsubscribe = store.subscribe((state: any) => { live = state })
    const listId = store.addListTemplate()
    store.renameListTemplate(listId, 'Synthetic routine')
    const templateId = store.addTemplate()
    const root = live.templates.find((value: any) => value.id === templateId).items[0]
    store.patchTemplateOption(templateId, root.id, root.options[0].id, { text: 'Synthetic routine', html: 'Synthetic routine' })
    store.addTemplateChild(templateId, root.id)
    const child = live.templates.find((value: any) => value.id === templateId).items[0].children[0]
    store.patchTemplateOption(templateId, child.id, child.options[0].id, { text: 'Synthetic routine child', html: 'Synthetic routine child' })
    store.setTemplateListExpansion(root.options[0].id, listId, true)
    store.setTemplateListExpansion(child.options[0].id, listId, true)
    store.setTemplateListExpansion(child.options[0].id, listId, false)
    const initial = structuredClone(live)
    const start = live.operations.length
    const copied = store.copyTemplateItems(templateId, [root.id])
    const ids = store.pasteTemplateItems(templateId, copied, root.id, 'after', structuredClone(live.templateListExpansions))
    const pasted = live.templates.find((value: any) => value.id === templateId).items.find((value: any) => value.id === ids[0])
    const result = {
      initial, operations: structuredClone(live.operations.slice(start)), expected: structuredClone(live),
      choices: [pasted.options[0].id, pasted.children[0].options[0].id].map((id) => live.templateListExpansions.find((value: any) => value.id === id)?.listTemplateIds),
      listId,
    }
    unsubscribe()
    return result
  })
  expect(fixture.choices).toEqual([[fixture.listId], []])
  expect(fixture.operations).toHaveLength(1)
  expect(fixture.operations[0].type).toBe('paste_template_items')
  expect(fixture.operations[0].payload.entityChanges.upserts).toHaveLength(2)
  mkdirSync('artifacts/entity-fixtures', { recursive: true })
  writeFileSync(`artifacts/entity-fixtures/paste-expansion-${info.project.name}.json`, JSON.stringify(fixture))
})
