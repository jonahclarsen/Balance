import { expect, test } from '@playwright/test'
import {
  backspaceListTemplateItemAtStart,
  backspacePlanItemAtStart,
  backspaceTemplateOptionAtStart,
  copyListTemplateItems,
  copyPlanItems,
  copyTemplateItems,
  indentListTemplateItems,
  indentPlanItems,
  indentTemplateItems,
} from '../../src/lib/planner'
import type { TemplateOption } from '../../src/lib/types'

type Item = {
  id: string
  text: string
  html: string
  done: boolean
  probability: number
  startMinutes: number | null
  endMinutes: number | null
  options: TemplateOption[]
  children: Item[]
  futureField: { value: string }
}

function item(id: string, children: Item[] = []): Item {
  return {
    id, text: id, html: id, done: false, probability: 100,
    startMinutes: null, endMinutes: null,
    options: [{ id: `${id}-option`, text: id, html: id, probability: 100 }],
    children, futureField: { value: id },
  }
}

function freezeTree(items: Item[]): Item[] {
  for (const node of items) {
    freezeTree(node.children)
    Object.freeze(node)
  }
  Object.freeze(items)
  return items
}

for (const [kind, indent, copy] of [
  ['plan', indentPlanItems, copyPlanItems],
  ['day template', indentTemplateItems, copyTemplateItems],
  ['list template', indentListTemplateItems, copyListTemplateItems],
] as const) {
  test(`${kind}: indentation preserves selected runs, existing children, and untouched references`, () => {
    const items = freezeTree([
      item('first-selected'),
      item('parent', [item('existing')]),
      item('a', [item('a-child')]), item('b'),
      item('second-parent'), item('c'), item('d'),
      item('untouched'),
    ])
    const result = indent(items, ['first-selected', 'a', 'b', 'c', 'd'])

    expect(result.map(({ id }) => id)).toEqual(['first-selected', 'parent', 'second-parent', 'untouched'])
    expect(result[1].children.map(({ id }) => id)).toEqual(['existing', 'a', 'b'])
    expect(result[2].children.map(({ id }) => id)).toEqual(['c', 'd'])
    expect(result[0]).toBe(items[0])
    expect(result[3]).toBe(items[7])
    expect(result[1].children[0]).toBe(items[1].children[0])
    expect(result[1].children[1]).toBe(items[2])
    expect(result[1].children[2]).toBe(items[3])
    expect((result[1] as Item).futureField).toBe(items[1].futureField)
  })

  test(`${kind}: nested selected runs indent before their parent moves`, () => {
    const items = freezeTree([
      item('destination'),
      item('moving', [item('child-parent'), item('child-a'), item('child-b')]),
      item('sibling'),
    ])
    const result = indent(items, ['moving', 'child-a', 'child-b', 'sibling'])
    expect(result.map(({ id }) => id)).toEqual(['destination'])
    expect(result[0].children.map(({ id }) => id)).toEqual(['moving', 'sibling'])
    const moved = result[0].children[0]
    expect(moved.children.map(({ id }) => id)).toEqual(['child-parent'])
    expect(moved.children[0].children.map(({ id }) => id)).toEqual(['child-a', 'child-b'])
    expect(moved.children[0].children[0]).toBe(items[1].children[1])
    expect(result[0].children[1]).toBe(items[2])
  })

  test(`${kind}: ineffective indentation preserves the original tree`, () => {
    const items = freezeTree([item('first', [item('first-child')]), item('last')])
    for (const ids of [[], ['missing'], ['first'], ['first', 'last'], ['first-child']]) {
      expect(indent(items, ids)).toBe(items)
    }
  })

  test(`${kind}: copying returns selected subtree roots once in visible order`, () => {
    const items = freezeTree([
      item('outer', [
        item('selected-parent', [item('selected-child')]),
        item('wrapper', [item('deep-selected')]),
      ]),
      item('last-selected'),
    ])
    const result = copy(items, [
      'last-selected', 'selected-child', 'deep-selected', 'selected-parent', 'missing', 'deep-selected',
    ])
    expect(result.map(({ id }) => id)).toEqual(['selected-parent', 'deep-selected', 'last-selected'])
    expect(result[0]).toBe(items[0].children[0])
    expect(result[1]).toBe(items[0].children[1].children[0])
    expect(result[2]).toBe(items[1])
    expect(copy(items, [])).toEqual([])
    expect(copy(items, ['missing'])).toEqual([])
  })
}

test('plan and list backspace use the last nested descendant as the previous visible row', () => {
  const items = freezeTree([item('parent', [item('child', [item('deep')])]), item('next')])
  for (const backspace of [backspacePlanItemAtStart, backspaceListTemplateItemAtStart]) {
    const result = backspace(items, 'next')
    expect(result?.focusItemId).toBe('deep')
    expect(result?.focusOffset).toBe(4)
    expect(result?.items[0].children[0].children[0].text).toBe('deepnext')
    expect(result?.items).toHaveLength(1)
    expect(result?.items[0]).not.toBe(items[0])
    expect(result?.items[0].children[0].children[0]).not.toBe(items[0].children[0].children[0])
    expect((result?.items[0] as Item).futureField).toBe(items[0].futureField)
    expect(items[0].children[0].children[0].text).toBe('deep')
    expect(backspace(items, 'parent')).toBeNull()
    expect(backspace(items, 'missing')).toBeNull()
  }
})

test('template backspace visits options before descendants and returns to the next root', () => {
  const items = [item('parent', [item('child')]), item('empty'), item('next')]
  items[0].options.push({ id: 'second-option', text: 'second', html: 'second', probability: 100 })
  items[1].options = []
  freezeTree(items)

  const withinParent = backspaceTemplateOptionAtStart(items, 'parent', 'second-option')
  expect(withinParent?.focusOptionId).toBe('parent-option')
  expect(withinParent?.items[0].options[0].text).toBe('parentsecond')

  const toChild = backspaceTemplateOptionAtStart(items, 'child', 'child-option')
  expect(toChild?.focusOptionId).toBe('second-option')
  expect(toChild?.items[0].options[1].text).toBe('secondchild')

  const afterChild = backspaceTemplateOptionAtStart(items, 'next', 'next-option')
  expect(afterChild?.focusOptionId).toBe('child-option')
  expect(afterChild?.items[0].children[0].options[0].text).toBe('childnext')
  expect(backspaceTemplateOptionAtStart(items, 'parent', 'parent-option')).toBeNull()
  expect(backspaceTemplateOptionAtStart(items, 'missing', 'missing')).toBeNull()
})
