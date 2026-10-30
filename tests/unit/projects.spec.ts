import { expect, test } from '@playwright/test'
import { activeProjects, endedProjectsOn, historyDayHeading, needsProjectPick, nextProjectExpiry, periodDays, periodFromDays, projectActiveUntil, projectActiveUntilOn, projectHistory, projectHistoryNoteDay, projectHistoryNoteId, projectHistoryPeriods, templateForGeneration, withActiveUntil } from '../../src/lib/projects'
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

test('a day with open projects but none active by noon asks for a pick, counted from 7 a.m. that day', () => {
  const endsMorning = new Date(2026, 9, 21, 7).toISOString()
  const projects = [project({ id: 'ending', activeUntil: endsMorning }), project({ id: 'idle' }), project({ id: 'done', activeUntil: endsMorning, completedAt: '2026-10-20' })]
  expect(needsProjectPick(projects, '2026-10-20')).toBe(false)
  expect(needsProjectPick(projects, '2026-10-21')).toBe(true)
  expect(endedProjectsOn(projects, '2026-10-21').map(({ id }) => id)).toEqual(['ending'])
  expect(needsProjectPick([project({ completedAt: '2026-10-20' })], '2026-10-21')).toBe(false)
  expect(new Date(projectActiveUntilOn('2026-10-21', 2)).getTime()).toBe(new Date(2026, 9, 23, 7).getTime())
})

test('activating, changing, stopping and reactivating a project records its active stretches', () => {
  let ids = 0
  const nextId = () => `period-${++ids}`
  const at = (hour: number, day = 20) => new Date(2026, 9, day, hour)
  let current = withActiveUntil(project(), projectActiveUntil(2, at(9)), at(9), nextId)
  expect(current.activePeriods).toEqual([{ id: 'period-1', start: at(9).toISOString(), end: at(7, 22).toISOString() }])

  // Changing the days moves the current stretch's end.
  current = withActiveUntil(current, projectActiveUntil(3, at(10)), at(10), nextId)
  expect(current.activePeriods).toEqual([{ id: 'period-1', start: at(9).toISOString(), end: at(7, 23).toISOString() }])

  // Stopping ends it now.
  current = withActiveUntil(current, null, at(15, 21), nextId)
  expect(current.activeUntil).toBeUndefined()
  expect(current.activePeriods![0].end).toBe(at(15, 21).toISOString())

  // A lapsed stretch stays as it was and a new one starts.
  current = withActiveUntil(current, projectActiveUntil(1, at(8, 25)), at(8, 25), nextId)
  current = withActiveUntil(current, projectActiveUntil(1, at(8, 28)), at(8, 28), nextId)
  expect(current.activePeriods!.map(({ id, end }) => [id, end])).toEqual([
    ['period-1', at(15, 21).toISOString()],
    ['period-2', at(7, 26).toISOString()],
    ['period-3', at(7, 29).toISOString()],
  ])
  expect(projectHistory([current]).map(({ period }) => period.id)).toEqual(['period-3', 'period-2', 'period-1'])
})

test('active stretches convert to and from the active days they cover', () => {
  const span = periodFromDays('2026-10-20', '2026-10-22')
  expect(span).toEqual({ start: new Date(2026, 9, 20, 7).toISOString(), end: new Date(2026, 9, 23, 7).toISOString() })
  expect(periodDays({ id: 'p', ...span })).toEqual({ first: '2026-10-20', last: '2026-10-22' })
  // Picked late in the evening, a stretch starts on that evening's day.
  expect(periodDays({ id: 'p', start: new Date(2026, 9, 19, 22).toISOString(), end: new Date(2026, 9, 21, 7).toISOString() })).toEqual({ first: '2026-10-19', last: '2026-10-20' })
})

test('a stretch ends on its last full day', () => {
  const start = new Date(2026, 9, 26, 7).toISOString()
  // Ending at 7 a.m. or partway through Saturday Oct 31 means it ended Friday.
  expect(periodDays({ id: 'p', start, end: new Date(2026, 9, 31, 7).toISOString() }).last).toBe('2026-10-30')
  expect(periodDays({ id: 'p', start, end: new Date(2026, 9, 31, 15).toISOString() }).last).toBe('2026-10-30')
  // Stopped the same day it started, it still covers that day.
  expect(periodDays({ id: 'p', start, end: new Date(2026, 9, 26, 15).toISOString() })).toEqual({ first: '2026-10-26', last: '2026-10-26' })
})

test('history groups stretches by start day and keeps written days', () => {
  const a = project({ id: 'a', activePeriods: [{ id: 'a1', ...periodFromDays('2026-10-20', '2026-10-22') }] })
  const b = project({ id: 'b', activePeriods: [{ id: 'b1', ...periodFromDays('2026-10-20', '2026-10-21') }, { id: 'b2', ...periodFromDays('2026-10-25', '2026-10-26') }] })
  const periods = projectHistoryPeriods([a, b], ['2026-10-01'])
  expect(periods.map(({ day, entries }) => [day, entries.map((entry) => entry.period.id).sort()])).toEqual([
    ['2026-10-25', ['b2']],
    ['2026-10-20', ['a1', 'b1']],
    ['2026-10-01', []],
  ])
  expect(projectHistoryNoteDay(projectHistoryNoteId('2026-10-20'))).toBe('2026-10-20')
  expect(projectHistoryNoteDay('project-history-backstory')).toBeNull()
})

test('history headings read like "tues october 28"', () => {
  const now = new Date(2026, 9, 30)
  expect(historyDayHeading('2026-10-27', now)).toBe('tues october 27')
  expect(historyDayHeading('2026-10-29', now)).toBe('thurs october 29')
  expect(historyDayHeading('2025-12-01', now)).toBe('mon december 1 2025')
})
