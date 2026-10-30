import type { DailyTemplate, Id, Project, ProjectActivePeriod, TemplateItem, TemplateItemCondition } from './types'

export const PROJECT_ACTIVE_DAY_COUNTS = [1, 2, 3, 4, 5] as const
const ACTIVE_DAY_START_HOUR = 7
const DAY_MS = 24 * 60 * 60 * 1000

// Active days count from the most recent 7 a.m., so activating at 6 a.m. for
// one day ends at 7 a.m. the same morning.
export function projectActiveUntil(days: number, now = new Date()): string {
  const start = new Date(now)
  start.setHours(ACTIVE_DAY_START_HOUR, 0, 0, 0)
  if (start > now) start.setDate(start.getDate() - 1)
  return new Date(start.getTime() + days * DAY_MS).toISOString()
}

export function isProjectOpen(project: Project): boolean {
  return !project.archived && !project.completedAt
}

export function isProjectActive(project: Project, now = Date.now()): boolean {
  return isProjectOpen(project) && Boolean(project.activeUntil) && Date.parse(project.activeUntil!) > now
}

export function activeProjects(projects: Project[], now = Date.now()): Project[] {
  return projects.filter((project) => isProjectActive(project, now))
}

// The earliest moment an active project lapses, for scheduling a refresh.
export function nextProjectExpiry(projects: Project[], now = Date.now()): number | null {
  let next: number | null = null
  for (const project of activeProjects(projects, now)) {
    const end = Date.parse(project.activeUntil!)
    if (next === null || end < next) next = end
  }
  return next
}

// The stretch that ends at activeUntil while the project is active.
function currentPeriod(project: Project, now: number): ProjectActivePeriod | undefined {
  if (!isProjectActive(project, now)) return undefined
  const last = project.activePeriods?.at(-1)
  return last?.end === project.activeUntil ? last : undefined
}

// Sets or clears activeUntil and records the change in activePeriods:
// extending the current stretch, ending it now, or starting a new one.
export function withActiveUntil(project: Project, activeUntil: string | null, now = new Date(), createId: () => Id): Project {
  const { activeUntil: _activeUntil, ...rest } = project
  const current = currentPeriod(project, now.getTime())
  const periods = project.activePeriods ?? []
  let activePeriods = periods
  if (current) {
    const end = activeUntil ?? now.toISOString()
    activePeriods = periods.map((period) => period === current ? { ...period, end } : period)
  } else if (activeUntil) {
    activePeriods = [...periods, { id: createId(), start: now.toISOString(), end: activeUntil }]
  }
  return {
    ...rest,
    ...(activeUntil ? { activeUntil } : {}),
    ...(activePeriods.length ? { activePeriods } : {}),
  }
}

export type ProjectHistoryEntry = { project: Project; period: ProjectActivePeriod }

// Every recorded stretch, most recent first.
export function projectHistory(projects: Project[]): ProjectHistoryEntry[] {
  return projects
    .flatMap((project) => (project.activePeriods ?? []).map((period) => ({ project, period })))
    .sort((a, b) => b.period.start.localeCompare(a.period.start) || b.period.end.localeCompare(a.period.end))
}

function localDate(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Active days run from 7 a.m. A stretch starts on the day containing its
// start and ends on its last full day, so one ending at 7 a.m. Saturday or
// partway through Saturday ended Friday. A stretch shorter than a day keeps
// its first day.
export function periodDays(period: ProjectActivePeriod): { first: string; last: string } {
  const offset = ACTIVE_DAY_START_HOUR * 60 * 60 * 1000
  const first = localDate(Date.parse(period.start) - offset)
  const endDay = new Date(`${localDate(Date.parse(period.end) - offset)}T12:00:00`)
  endDay.setDate(endDay.getDate() - 1)
  const last = localDate(endDay.getTime())
  return { first, last: last < first ? first : last }
}

export type ProjectHistoryPeriod = { day: string; entries: ProjectHistoryEntry[] }

// Stretches grouped by the day they started, most recent first. Days with
// writing but no stretches left keep their place so nothing written is hidden.
export function projectHistoryPeriods(projects: Project[], notedDays: string[] = []): ProjectHistoryPeriod[] {
  const byDay = new Map<string, ProjectHistoryEntry[]>()
  for (const entry of projectHistory(projects)) {
    const { first } = periodDays(entry.period)
    byDay.set(first, [...(byDay.get(first) ?? []), entry])
  }
  for (const day of notedDays) if (!byDay.has(day)) byDay.set(day, [])
  return [...byDay].map(([day, entries]) => ({ day, entries })).sort((a, b) => b.day.localeCompare(a.day))
}

const HISTORY_NOTE_PREFIX = 'project-history-'
export const PROJECT_BACKSTORY_NOTE_ID = `${HISTORY_NOTE_PREFIX}backstory`

export function projectHistoryNoteId(day: string): Id {
  return `${HISTORY_NOTE_PREFIX}${day}`
}

export function projectHistoryNoteDay(id: Id): string | null {
  const day = id.slice(HISTORY_NOTE_PREFIX.length)
  return id.startsWith(HISTORY_NOTE_PREFIX) && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

const SHORT_WEEKDAYS = ['sun', 'mon', 'tues', 'wed', 'thurs', 'fri', 'sat']

// "tues october 28", plus the year when it isn't this year.
export function historyDayHeading(day: string, now = new Date()): string {
  const date = new Date(`${day}T12:00:00`)
  const month = date.toLocaleDateString('en-US', { month: 'long' }).toLowerCase()
  const year = date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`
  return `${SHORT_WEEKDAYS[date.getDay()]} ${month} ${date.getDate()}${year}`
}

// The stretch covering whole active days from `first` through `last`.
export function periodFromDays(first: string, last: string): Pick<ProjectActivePeriod, 'start' | 'end'> {
  const start = new Date(`${first}T00:00:00`)
  start.setHours(ACTIVE_DAY_START_HOUR)
  const end = new Date(`${last}T00:00:00`)
  end.setDate(end.getDate() + 1)
  end.setHours(ACTIVE_DAY_START_HOUR)
  return { start: start.toISOString(), end: end.toISOString() }
}

function noonOn(date: string): number {
  return new Date(`${date}T12:00:00`).getTime()
}

// Whether any project is active at noon on the given day.
export function hasActiveProjectOn(projects: Project[], date: string): boolean {
  return projects.some((project) => isProjectActive(project, noonOn(date)))
}

// Picked while generating a day, active days count from 7 a.m. that day, so
// picking one day tonight covers all of tomorrow.
export function projectActiveUntilOn(date: string, days: number): string {
  return projectActiveUntil(days, new Date(noonOn(date)))
}

// Open projects whose active stretch is over by noon on the given day.
export function endedProjectsOn(projects: Project[], date: string): Project[] {
  return projects.filter((project) => isProjectOpen(project) && project.activeUntil && Date.parse(project.activeUntil) <= noonOn(date))
}

// Generating a day with open projects but none active by noon asks for new ones.
export function needsProjectPick(projects: Project[], date: string): boolean {
  return projects.some(isProjectOpen) && !hasActiveProjectOn(projects, date)
}

function withoutNoActiveProjectItems(items: TemplateItem[], gatedIds: Set<Id>): TemplateItem[] {
  let changed = false
  const kept = items.flatMap((item) => {
    if (gatedIds.has(item.id)) {
      changed = true
      return []
    }
    const children = withoutNoActiveProjectItems(item.children, gatedIds)
    if (children === item.children) return [item]
    changed = true
    return [{ ...item, children }]
  })
  return changed ? kept : items
}

// The day template as generating `date` should see it, for both its quiz and its items.
export function templateForGeneration(template: DailyTemplate, conditions: TemplateItemCondition[], projects: Project[], date: string): DailyTemplate {
  const gatedIds = new Set(conditions.filter(({ noActiveProject }) => noActiveProject).map(({ id }) => id))
  if (gatedIds.size === 0 || !hasActiveProjectOn(projects, date)) return template
  const items = withoutNoActiveProjectItems(template.items, gatedIds)
  return items === template.items ? template : { ...template, items }
}
