import { expect, test } from '@playwright/test'
import { createTemplateItem, createTemplateOption, generatePlanFromTemplate, templateQuizSteps } from '../../src/lib/planner'
import type { DailyTemplate, TemplateItem } from '../../src/lib/types'

function item(id: string, texts: string[], children: TemplateItem[] = []): TemplateItem {
  return {
    ...createTemplateItem(),
    id,
    options: texts.map((text, index) => ({ ...createTemplateOption(text, 0), id: `${id}-${index}` })),
    children,
  }
}

const template: DailyTemplate = {
  id: 'template',
  name: 'Synthetic',
  createdAt: '',
  updatedAt: '',
  items: [
    item('laptop', ['No laptop until noon']),
    item('workout', ['Swim', 'Lift weights'], [item('warmup', ['Stretch'])]),
    item('fixed', ['Breakfast']),
  ],
}
template.items[2].options[0].probability = 100
const questions = [
  { id: 'laptop', question: 'Ban laptop this morning?' },
  { id: 'workout', question: 'Workout type?' },
  { id: 'warmup', question: 'Warm up?' },
  { id: 'fixed', question: '  ' },
]

function texts(answers: Record<string, string | null>) {
  const visit = (items: { text: string; children: any[] }[]): string[] => items.flatMap((entry) => [entry.text, ...visit(entry.children)])
  return visit(generatePlanFromTemplate(template, '2026-09-30', '', [], [], answers).items)
}

test('steps follow template order, skip blank questions and record question ancestors', () => {
  expect(templateQuizSteps(template, questions).map(({ itemId, questionAncestorIds }) => [itemId, questionAncestorIds])).toEqual([
    ['laptop', []],
    ['workout', []],
    ['warmup', ['workout']],
  ])
})

test('answers choose options regardless of probability; none omits the row', () => {
  expect(texts({ laptop: 'laptop-0', workout: 'workout-1', warmup: 'warmup-0' })).toEqual(['No laptop until noon', 'Lift weights', 'Stretch', 'Breakfast'])
  expect(texts({ laptop: null, workout: 'workout-0', warmup: null })).toEqual(['Swim', 'Breakfast'])
})

test('unanswered rows keep their probability roll', () => {
  const generated = texts({})
  expect(generated).not.toContain('No laptop until noon')
  expect(generated).toContain('Breakfast')
})

test('a question whose only answer is blank takes a typed answer after the question', () => {
  const typedTemplate: DailyTemplate = { ...template, items: [item('focus', ['']), item('mood', [''])] }
  const steps = templateQuizSteps(typedTemplate, [
    { id: 'focus', question: '  Focus:' },
    { id: 'mood', question: 'Mood: ' },
  ])
  expect(steps.map(({ question, typedAnswerPrefix }) => [question, typedAnswerPrefix])).toEqual([
    ['Focus:', 'Focus: '],
    ['Mood:', 'Mood: '],
  ])
  expect(templateQuizSteps(template, questions).every(({ typedAnswerPrefix }) => typedAnswerPrefix === null)).toBe(true)

  const generated = generatePlanFromTemplate(typedTemplate, '2026-09-30', '', [], [], { focus: { text: 'Focus: <taxes>' }, mood: null })
  expect(generated.items.map(({ text, html }) => [text, html])).toEqual([['Focus: <taxes>', 'Focus: &lt;taxes&gt;']])
})
