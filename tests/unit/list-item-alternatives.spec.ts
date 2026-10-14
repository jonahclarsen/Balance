import { expect, test } from '@playwright/test'
import { expectedWordCount, generateListFromTemplate, listItemAppearanceChance, listItemPrimaryShare, listRowSourceItemId, totalWordCount } from '../../src/lib/planner'
import type { ListTemplate, ListTemplateItem } from '../../src/lib/types'

const tidy: ListTemplateItem = {
  id: 'tidy',
  text: 'Tidy 5 min',
  html: 'Tidy 5 min',
  probability: 100,
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

test('alternatives split the appearances, and children follow either wording', () => {
  const short = generateWithRoll([tidy], 0.2)
  expect(short.map((item) => item.text)).toEqual(['Tidy 5 min'])
  expect(short[0].children.map((item) => item.text)).toEqual(['Empty bin'])

  const long = generateWithRoll([tidy], 0.7)
  expect(long.map((item) => item.text)).toEqual(['Tidy 10 min'])
  expect(long[0].children.map((item) => item.text)).toEqual(['Empty bin'])
  // Timing is tracked per wording, so the row keeps the alternative's id.
  expect(listRowSourceItemId(long[0].id)).toBe('tidy-long')
})

test('the item probability alone decides how often it appears', () => {
  const sometimes = { ...tidy, probability: 60 }
  expect(generateWithRoll([sometimes], 0.2)[0].text).toBe('Tidy 5 min')
  expect(generateWithRoll([sometimes], 0.5)[0].text).toBe('Tidy 10 min')
  expect(generateWithRoll([sometimes], 0.7)).toEqual([])
  expect(listItemAppearanceChance(sometimes)).toBeCloseTo(0.6)
})

test('the item wording keeps the share alternatives leave, and overfull shares scale down', () => {
  expect(listItemPrimaryShare(tidy)).toBe(50)
  const crowded = { ...tidy, alternatives: [{ ...tidy.alternatives![0], probability: 100 }, { id: 'tidy-mid', text: 'Tidy 7 min', html: 'Tidy 7 min', probability: 100 }] }
  expect(listItemPrimaryShare(crowded)).toBe(0)
  expect(generateWithRoll([crowded], 0.4)[0].text).toBe('Tidy 10 min')
  expect(generateWithRoll([crowded], 0.6)[0].text).toBe('Tidy 7 min')
})

test('expected words weigh each wording by its share of the appearances', () => {
  // 3 words for either wording, plus 2 child words, at 100% appearance.
  expect(expectedWordCount([tidy])).toBe(5)
  expect(expectedWordCount([{ ...tidy, probability: 50 }])).toBe(2.5)
  const shortAlternative = { ...tidy, alternatives: [{ ...tidy.alternatives![0], text: 'Skip', html: 'Skip' }] }
  expect(expectedWordCount([shortAlternative])).toBe(4)
  expect(totalWordCount([tidy])).toBe(8)
})
