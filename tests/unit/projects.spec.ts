import { expect, test } from '@playwright/test'
import { activeProjects, nextProjectExpiry, projectActiveUntil, templateForGeneration } from '../../src/lib/projects'
import type { DailyTemplate, Project, TemplateItem } from '../../src/lib/types'

const project = (patch: Partial<Project> = {}): Project => ({ id: 'project', name: 'Project', description: '', color: '#336699', archived: false, createdAt: '', updatedAt: '', ...patch })
const item = (id: string, children: TemplateItem[] = []): TemplateItem => ({ id, startMinutes: null, endMinutes: null, options: [{ id: `${id}-option`, text: id, html: id, probability: 100 }], children })

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

test('gated day rows and their children drop out while a project is active at noon on the day', () => {
  const template: DailyTemplate = {
    id: 'day', name: 'Day', createdAt: '', updatedAt: '',
    items: [item('keep', [item('gated-child')]), item('gated', [item('child')])],
  }
  const conditions = [{ id: 'gated', noActiveProject: true }, { id: 'gated-child', noActiveProject: true }]
  // Active until 7 a.m. on the 21st: still active at noon on the 20th, lapsed by noon on the 21st.
  const projects = [project({ activeUntil: new Date(2026, 9, 21, 7).toISOString() })]
  expect(templateForGeneration(template, conditions, projects, '2026-10-21')).toBe(template)
  expect(templateForGeneration(template, [], projects, '2026-10-20')).toBe(template)
  const filtered = templateForGeneration(template, conditions, projects, '2026-10-20')
  expect(filtered.items.map(({ id }) => id)).toEqual(['keep'])
  expect(filtered.items[0].children).toEqual([])
})
