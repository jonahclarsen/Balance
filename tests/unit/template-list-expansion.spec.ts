import { expect, test } from '@playwright/test'
import { createListTemplate, createListTemplateItem, createListTemplateItemAlternative, createTemplateItem, createTemplateOption, detectedTemplateLists, generateListFromTemplate, generatePlanFromTemplate, isTemplateQuizStepAsked, listTemplateQuizSteps, templateQuizSteps } from '../../src/lib/planner'
import type { TemplateQuizAnswers } from '../../src/lib/types'
import { listTemplateItemsToTemplateItems, templateItemsToListTemplateItems } from '../../src/lib/taskClipboard'

function fixture() {
  const list = createListTemplate('Routine')
  list.items = [{ ...createListTemplateItem('First'), html: '<b>First</b>', children: [createListTemplateItem('Nested')] }, createListTemplateItem('Second')]
  const row = createTemplateItem('Routine')
  row.children = [createTemplateItem('After list')]
  const template = { id: 'template', name: 'Synthetic', createdAt: '', updatedAt: '', items: [createTemplateItem('Before'), row, createTemplateItem('After')] }
  const expansions = [{ id: row.options[0].id, listTemplateIds: [list.id] }]
  return { list, row, template, expansions }
}

test('expanded lists replace the linked row in place, preserve rich text and hierarchy, and generate independent tasks', () => {
  const { list, template, expansions } = fixture()
  const generate = () => generatePlanFromTemplate(template, '2026-10-02', '', [], [], {}, [list], expansions)
  const plan = generate()
  expect(plan.items.map(({ text }) => text)).toEqual(['Before', 'First', 'Second', 'After list', 'After'])
  expect(plan.items[1].html).toBe('<b>First</b>')
  expect(plan.items[1].children[0].text).toBe('Nested')
  expect(plan.items.every(({ done }) => !done)).toBe(true)
  expect(generate().items[1].id).not.toBe(plan.items[1].id)
  expect(list.items[0].text).toBe('First')
})

test('disabled, missing and no-longer-linked lists keep the ordinary template task', () => {
  const { list, row, template, expansions } = fixture()
  for (const [lists, choices] of [[[list], []], [[], expansions]] as const) {
    expect(generatePlanFromTemplate(template, '2026-10-02', '', [], [], {}, [...lists], [...choices]).items[1].text).toBe('Routine')
  }
  row.options[0].text = 'Renamed task'
  expect(generatePlanFromTemplate(template, '2026-10-02', '', [], [], {}, [list], expansions).items[1].text).toBe('Renamed task')
})

test('list probabilities and quiz selection apply to expansion, including empty lists', () => {
  const { list, row, template, expansions } = fixture()
  list.items[0].probability = 10
  row.options[0].probability = 0
  const random = Math.random
  Math.random = () => 0.5
  try {
    expect(generatePlanFromTemplate(template, '2026-10-02', '', [], [], {}, [list], expansions).items.map(({ text }) => text)).toEqual(['Before', 'After'])
    const answers = { [row.id]: row.options[0].id }
    expect(generatePlanFromTemplate(template, '2026-10-02', '', [], [], answers, [list], expansions).items.map(({ text }) => text)).toEqual(['Before', 'Second', 'After list', 'After'])
    list.items = []
    expect(generatePlanFromTemplate(template, '2026-10-02', '', [], [], answers, [list], expansions).items.map(({ text }) => text)).toEqual(['Before', 'After list', 'After'])
  } finally { Math.random = random }
})

test('list detection uses the underlined matches and removes repeated names', () => {
  const short = createListTemplate('Routine')
  const long = createListTemplate('Morning Routine')
  expect(detectedTemplateLists('Morning Routine then Routine then routine', [short, long]).map(({ id }) => id)).toEqual([long.id, short.id])
})

test('copy conversion preserves formatting, nesting and probabilities in both directions', () => {
  const { row } = fixture()
  row.options[0].html = '<b>Routine</b>'
  row.options[0].probability = 70
  const listRows = templateItemsToListTemplateItems([row])
  expect(listRows[0]).toMatchObject({ text: 'Routine', html: '<b>Routine</b>', probability: 70 })
  expect(listRows[0].children[0].text).toBe('After list')
  const dayRows = listTemplateItemsToTemplateItems(listRows)
  expect(dayRows[0].options[0]).toMatchObject({ text: 'Routine', html: '<b>Routine</b>', probability: 70 })
  expect(dayRows[0].children[0].options[0].text).toBe('After list')
  expect(dayRows[0].id).not.toBe(row.id)
  row.options.push(createTemplateOption('Alternative', 30))
  expect(templateItemsToListTemplateItems([row]).map(({ text, probability }) => [text, probability])).toEqual([['Routine', 70], ['Alternative', 30]])
})

function questionFixture() {
  const { list, row, template, expansions } = fixture()
  list.items[1].alternatives = [{ ...createListTemplateItemAlternative('Third', 50), id: 'third' }]
  const questions = [{ id: list.items[1].id, question: 'Which?' }]
  return { list, row, template, expansions, questions }
}

test('list questions offer each wording and decide it regardless of odds', () => {
  const { list, questions } = questionFixture()
  const [second] = list.items.slice(1)
  expect(listTemplateQuizSteps(list, questions).map(({ itemId, options }) => [itemId, options.map(({ text }) => text)])).toEqual([[second.id, ['Second', 'Third']]])
  second.probability = 10
  const texts = (answers: TemplateQuizAnswers) => generateListFromTemplate(list, '2026-10-02', [], answers).items.map(({ text }) => text).slice(1)
  expect(texts({ [second.id]: 'third' })).toEqual(['Third'])
  expect(texts({ [second.id]: second.id })).toEqual(['Second'])
  expect(texts({ [second.id]: null })).toEqual([])
})

test('a list question with a blank item takes a typed answer', () => {
  const list = createListTemplate('Routine')
  list.items = [createListTemplateItem('')]
  const [step] = listTemplateQuizSteps(list, [{ id: list.items[0].id, question: 'Focus:' }])
  expect(step.typedAnswerPrefix).toBe('Focus: ')
  expect(generateListFromTemplate(list, '2026-10-02', [], { [list.items[0].id]: { text: 'Focus: taxes' } }).items.map(({ text }) => text)).toEqual(['Focus: taxes'])
})

test('a day asks the questions of lists it places, gated by the placing answer', () => {
  const { list, row, template, expansions, questions } = questionFixture()
  const listItemId = list.items[1].id
  expect(templateQuizSteps(template, questions, [list], expansions).map(({ itemId, placedBy }) => [itemId, placedBy])).toEqual([[listItemId, null]])

  row.options.push(createTemplateOption('Rest', 0))
  const steps = templateQuizSteps(template, [...questions, { id: row.id, question: 'Routine?' }], [list], expansions)
  expect(steps.map(({ itemId, questionAncestorIds }) => [itemId, questionAncestorIds])).toEqual([[row.id, []], [listItemId, [row.id]]])
  const listStep = steps[1]
  expect(isTemplateQuizStepAsked(listStep, {})).toBe(true)
  expect(isTemplateQuizStepAsked(listStep, { [row.id]: row.options[0].id })).toBe(true)
  expect(isTemplateQuizStepAsked(listStep, { [row.id]: row.options[1].id })).toBe(false)
  expect(isTemplateQuizStepAsked(listStep, { [row.id]: null })).toBe(false)

  const answers = { [row.id]: row.options[0].id, [listItemId]: 'third' }
  expect(generatePlanFromTemplate(template, '2026-10-02', '', [], [], answers, [list], expansions).items.map(({ text }) => text)).toContain('Third')
})

test('questions follow rows copied between day and list templates', () => {
  const day = createTemplateItem('Swim')
  day.options.push(createTemplateOption('Lift', 0))
  day.children = [createTemplateItem('Stretch')]
  const [listItem] = templateItemsToListTemplateItems([day], new Set([day.id]))
  expect(listItem).toMatchObject({ id: day.id, text: 'Swim', alternatives: [{ text: 'Lift' }] })
  expect(listItem.children.map(({ text }) => text)).toEqual(['Stretch'])
  const [back] = listTemplateItemsToTemplateItems([listItem], new Set([day.id]))
  expect(back.id).toBe(day.id)
  expect(back.options.map(({ text }) => text)).toEqual(['Swim', 'Lift'])
})
