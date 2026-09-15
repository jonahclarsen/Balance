import { expect, test } from '@playwright/test'
import { createMetric, expectedWordCount, listItemWordCount, totalWordCount } from '../../src/lib/planner'
import type { ListTemplateItem } from '../../src/lib/types'

test('quiz questions follow the linking item and ancestor appearance probabilities', () => {
  const metric = createMetric('Check-in')
  metric.questions = [
    { id: 'one', prompt: 'stale prompt', html: '<b>How are you today?</b>', type: 'text' },
    { id: 'two', prompt: 'Did you sleep well?', html: '', type: 'boolean' },
  ]
  const items: ListTemplateItem[] = [{
    id: 'parent', text: 'Daily routine', html: '', probability: 50,
    children: [{ id: 'quiz', text: 'Check-in', html: '', probability: 50, children: [] }],
  }]
  expect(expectedWordCount(items, 1, [metric])).toBe(3.25)
  expect(totalWordCount(items, [metric])).toBe(11)
  expect(expectedWordCount(items)).toBe(1.25)

  metric.questions[0].html = '<b>How are you?</b>'
  expect(expectedWordCount(items, 1, [metric])).toBe(3)
  expect(listItemWordCount('CHECK-IN Check-in', [metric])).toBe(9)
  expect(listItemWordCount('Unlinked task', [metric])).toBe(2)
})
