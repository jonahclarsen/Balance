import { expect, test } from '@playwright/test'
import { activeProjects, listTemplatesForGeneration, nextProjectExpiry, projectActiveUntil } from '../../src/lib/projects'
import type { ListTemplate, ListTemplateItem, Project } from '../../src/lib/types'

const project = (patch: Partial<Project> = {}): Project => ({ id: 'project', name: 'Project', description: '', color: '#336699', archived: false, createdAt: '', updatedAt: '', ...patch })
const item = (id: string, patch: Partial<ListTemplateItem> = {}): ListTemplateItem => ({ id, text: id, html: id, probability: 100, children: [], ...patch })

test('active days count whole days from the most recent 7 a.m.', () => {
  expect(new Date(projectActiveUntil(1, new Date(2026, 9, 20, 7))).getTime()).toBe(new Date(2026, 9, 21, 7).getTime())
  expect(new Date(projectActiveUntil(1, new Date(2026, 9, 20, 23, 30))).getTime()).toBe(new Date(2026, 9, 21, 7).getTime())
  expect(new Date(projectActiveUntil(1, new Date(2026, 9, 20, 6, 59))).getTime()).toBe(new Date(2026, 9, 20, 7).getTime())
  expect(new Date(projectActiveUntil(3, new Date(2026, 9, 20, 12))).getTime()).toBe(new Date(2026, 9, 20, 7).getTime() + 3 * 24 * 60 * 60 * 1000)
})

test('only open projects within their active window are active', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  const projects = [
    project({ id: 'active', activeUntil: '2026-10-21T14:00:00Z' }),
    project({ id: 'lapsed', activeUntil: '2026-10-20T11:59:00Z' }),
    project({ id: 'done', activeUntil: '2026-10-21T14:00:00Z', completedAt: '2026-10-20T10:00:00Z' }),
    project({ id: 'archived', activeUntil: '2026-10-21T14:00:00Z', archived: true }),
    project({ id: 'soon', activeUntil: '2026-10-20T13:00:00Z' }),
  ]
  expect(activeProjects(projects, now).map(({ id }) => id)).toEqual(['active', 'soon'])
  expect(nextProjectExpiry(projects, now)).toBe(Date.parse('2026-10-20T13:00:00Z'))
})

test('flagged list items and their children drop out of generation while a project is active', () => {
  const templates: ListTemplate[] = [{
    id: 'list', name: 'List', maxExpectedWords: 0, archivedItems: [], createdAt: '', updatedAt: '',
    items: [item('keep', { children: [item('gated-child', { onlyWithoutActiveProject: true })] }), item('gated', { onlyWithoutActiveProject: true, children: [item('child')] })],
  }]
  const now = Date.parse('2026-10-20T12:00:00Z')
  expect(listTemplatesForGeneration(templates, [project()], now)).toBe(templates)
  const filtered = listTemplatesForGeneration(templates, [project({ activeUntil: '2026-10-21T14:00:00Z' })], now)
  expect(filtered[0].items.map(({ id }) => id)).toEqual(['keep'])
  expect(filtered[0].items[0].children).toEqual([])
})
