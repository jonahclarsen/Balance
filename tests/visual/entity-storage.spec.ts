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
