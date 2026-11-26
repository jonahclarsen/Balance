import { expect, test } from '@playwright/test'
import { generateListFromTemplate } from '../../src/lib/planner'
import type { ListTemplate, ListTemplateItem } from '../../src/lib/types'

function item(id: string, children: ListTemplateItem[] = []): ListTemplateItem {
  return { id, text: id, html: id, probability: 100, children }
}

const items = [item('a', [item('a1'), item('a2')]), item('b'), item('c'), item('d')]

function template(shuffle?: boolean): ListTemplate {
  return { id: 'list', name: 'Morning', maxExpectedWords: 0, shuffle, items, archivedItems: [], createdAt: '', updatedAt: '' }
}

const texts = (list: ListTemplate) => generateListFromTemplate(list, '2026-11-25').items.map((row) => row.text)

test('lists keep template order unless shuffled', () => {
  expect(texts(template())).toEqual(['a', 'b', 'c', 'd'])
  expect(texts(template(false))).toEqual(['a', 'b', 'c', 'd'])
})

test('shuffled lists vary their top-level order and keep children in place', () => {
  const orders = new Set<string>()
  for (let run = 0; run < 50; run += 1) {
    const rows = generateListFromTemplate(template(true), '2026-11-25').items
    expect(rows.map((row) => row.text).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(rows.find((row) => row.text === 'a')?.children.map((row) => row.text)).toEqual(['a1', 'a2'])
    orders.add(rows.map((row) => row.text).join())
  }
  expect(orders.size).toBeGreaterThan(1)
})
