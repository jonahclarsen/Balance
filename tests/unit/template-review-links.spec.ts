import { expect, test } from '@playwright/test'
import {
  createInitialState,
  DEFAULT_TEMPLATE_REVIEW_GOAL_CADENCE_DAYS,
  linkifyItemText,
  resolveItemLinks,
  templateReviewFromURL,
  templateReviewURL,
} from '../../src/lib/planner'

test('template review links are recognized for day and list templates', () => {
  const dayURL = templateReviewURL('day', 'template_abc')
  const listURL = templateReviewURL('list', 'list_template_1')
  const text = `Recommit ${dayURL} and ${listURL} today`
  const dayLink = { kind: 'templateReview', templateKind: 'day', templateId: 'template_abc', label: 'Recommit to day plan' }
  const listLink = { kind: 'templateReview', templateKind: 'list', templateId: 'list_template_1', label: 'Recommit to list' }

  expect(templateReviewFromURL(` ${dayURL} `)).toEqual({ kind: 'day', templateId: 'template_abc' })
  expect(templateReviewFromURL(listURL)).toEqual({ kind: 'list', templateId: 'list_template_1' })
  expect(resolveItemLinks(text, [], [])).toEqual([dayLink, listLink])
  expect(linkifyItemText(text, [], [])).toEqual([
    { text: 'Recommit ', link: null },
    { text: dayURL, link: dayLink },
    { text: ' and ', link: null },
    { text: listURL, link: listLink },
    { text: ' today', link: null },
  ])

  for (const bad of ['balance://review/week/x', 'balance://review/day/', `${dayURL}/extra`, `${dayURL}?x=1`]) {
    expect(templateReviewFromURL(bad)).toBeNull()
    expect(resolveItemLinks(bad, [], [])).toEqual([])
  }
})

test('a fresh workspace starts with a goal that reviews the default day every ten days', () => {
  const state = createInitialState()
  const [template] = state.templates
  const [goal] = state.goals

  expect(state.goals).toHaveLength(1)
  expect(goal.cadenceDays).toBe(DEFAULT_TEMPLATE_REVIEW_GOAL_CADENCE_DAYS)
  expect(goal.nameHtml).toContain(`href="${templateReviewURL('day', template.id)}"`)
  expect(resolveItemLinks(goal.nameHtml, [], [])).toEqual([
    { kind: 'templateReview', templateKind: 'day', templateId: template.id, label: 'Recommit to day plan' },
  ])
})
