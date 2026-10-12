import { expect, test } from '@playwright/test'
import { expectedWordCount, generateListFromTemplate, listItemAppearanceChance, listRowSourceItemId, totalWordCount } from '../../src/lib/planner'
import type { ListTemplate, ListTemplateItem } from '../../src/lib/types'

const tidy: ListTemplateItem = {
  id: 'tidy',
  text: 'Tidy 5 min',
  html: 'Tidy 5 min',
  probability: 50,
  alternatives: [{ id: 'tidy-long', text: 'Tidy 10 min', html: 'Tidy 10 min', probability: 50 }],
  children: [{ id: 'bin', text: 'Empty bin', html: 'Empty bin', probability: 100, children: [] }],
}

function template(items: ListTemplateItem[]): ListTemplate {
  return { id: 'list', name: 'Evening', maxExpectedWords: 0, items, archivedItems: [], createdAt: '', updatedAt: '' }
}

function generateWithRoll(items: ListTemplateItem[], roll: number) {
  const random = Math.random
  Math.random = () => roll
  try {
    return generateListFromTemplate(template(items), '2026-10-12').items
  } finally {
    Math.random = random
  }
}

test('one roll picks the item or one of its alternatives, and children follow either', () => {
  const short = generateWithRoll([tidy], 0.2)
  expect(short.map((item) => item.text)).toEqual(['Tidy 5 min'])
  expect(short[0].children.map((item) => item.text)).toEqual(['Empty bin'])

  const long = generateWithRoll([tidy], 0.7)
  expect(long.map((item) => item.text)).toEqual(['Tidy 10 min'])
  expect(long[0].children.map((item) => item.text)).toEqual(['Empty bin'])
  // Timing is tracked per wording, so the row keeps the alternative's id.
  expect(listRowSourceItemId(long[0].id)).toBe('tidy-long')
})

test('the share left under 100% and empty alternatives both skip the item', () => {
  const partial = { ...tidy, probability: 30, alternatives: [{ ...tidy.alternatives![0], probability: 30 }] }
  expect(generateWithRoll([partial], 0.5)).toHaveLength(1)
  expect(generateWithRoll([partial], 0.7)).toEqual([])

  const explicitSkip = { ...tidy, alternatives: [{ id: 'skip', text: '', html: '', probability: 50 }] }
  expect(generateWithRoll([explicitSkip], 0.7)).toEqual([])
  expect(listItemAppearanceChance(explicitSkip)).toBe(0.5)
})

test('totals over 100% are scaled down so every wording keeps its share', () => {
  const crowded = { ...tidy, probability: 100, alternatives: [{ ...tidy.alternatives![0], probability: 100 }] }
  expect(generateWithRoll([crowded], 0.4)[0].text).toBe('Tidy 5 min')
  expect(generateWithRoll([crowded], 0.6)[0].text).toBe('Tidy 10 min')
  expect(listItemAppearanceChance(crowded)).toBe(1)
})

test('word counts weigh each wording by its chance and count every wording once in the total', () => {
  // 3 words for either wording at 50% each, plus 2 child words at 100% of the item's appearance.
  expect(expectedWordCount([tidy])).toBe(5)
  expect(totalWordCount([tidy])).toBe(8)
})
