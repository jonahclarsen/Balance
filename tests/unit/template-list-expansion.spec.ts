import { expect, test } from '@playwright/test'
import { createListTemplate, createListTemplateItem, createTemplateItem, createTemplateOption, detectedTemplateLists, generatePlanFromTemplate } from '../../src/lib/planner'
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
