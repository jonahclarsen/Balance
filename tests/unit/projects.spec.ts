import { expect, test } from '@playwright/test'
import { projectCheckInForDay } from '../../src/lib/projects'
import { todayISO } from '../../src/lib/planner'

test('project days roll over at 3 a.m. local time across midnight and year boundaries', () => {
  const entry = { id: 'old', projectId: 'project', progress: 30, heart: 80, createdAt: new Date(2026, 11, 31, 23, 59).toISOString() }
  expect(projectCheckInForDay([entry], 'project', todayISO(new Date(2027, 0, 1, 2, 59)))).toBe(entry)
  expect(projectCheckInForDay([entry], 'project', todayISO(new Date(2027, 0, 1, 3)))).toBeUndefined()
  const early = { ...entry, id: 'early', createdAt: new Date(2027, 0, 1, 2, 59).toISOString() }
  expect(projectCheckInForDay([entry, early], 'project', '2026-12-31')).toBe(early)
  expect(projectCheckInForDay([entry, early], 'other-project', '2026-12-31')).toBeUndefined()
})

test('legacy duplicate check-ins remain intact and the latest is selected consistently', () => {
  const first = { id: 'a', projectId: 'project', progress: 30, heart: 80, createdAt: new Date(2026, 8, 9, 12).toISOString() }
  const last = { ...first, id: 'z' }
  expect(projectCheckInForDay([last, first], 'project', '2026-09-09')).toBe(last)
  expect(projectCheckInForDay([first, last], 'project', '2026-09-09')).toBe(last)
})
