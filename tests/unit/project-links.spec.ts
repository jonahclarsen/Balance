import { expect, test } from '@playwright/test'
import { linkifyItemText, resolveItemLinks, internalLinkId } from '../../src/lib/planner'

test('page and individual project links work without name-based metric gating', () => {
  const text = 'Check balance://projects or balance://projects/project_123 today'
  const links = resolveItemLinks(text, [], [])
  expect(links).toEqual([
    { kind: 'projects', projectId: '', label: 'Project vibes' },
    { kind: 'projects', projectId: 'project_123', label: 'Project vibes' },
  ])
  expect(linkifyItemText(text, [], []).filter((segment) => segment.link).map((segment) => segment.link)).toEqual(links)
  expect(internalLinkId(links[0])).toBe('all')
  expect(resolveItemLinks('balance://projectsville', [], [])).toEqual([])
})
