import { expect, test } from '@playwright/test'
import { GOAL_STATS_URL, isGoalStatsURL, linkifyItemText, resolveItemLinks } from '../../src/lib/planner'

test('goal stats links are recognized within task text without matching other routes', () => {
  const text = `Review ${GOAL_STATS_URL}, then plan tomorrow`
  const link = { kind: 'goalStats', label: 'Goal stats' }
  expect(resolveItemLinks(text, [], [])).toEqual([link])
  expect(linkifyItemText(text, [], [])).toEqual([
    { text: 'Review ', link: null },
    { text: GOAL_STATS_URL, link },
    { text: ', then plan tomorrow', link: null },
  ])
  expect(isGoalStatsURL(` ${GOAL_STATS_URL} `)).toBe(true)
  for (const suffix of ['Extra', '/other', '?range=30', '#other']) {
    expect(isGoalStatsURL(GOAL_STATS_URL + suffix)).toBe(false)
    expect(resolveItemLinks(GOAL_STATS_URL + suffix, [], [])).toEqual([])
  }
})
