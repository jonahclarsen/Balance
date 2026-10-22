import type { DailyTemplate, Id, Project, TemplateItem, TemplateItemCondition } from './types'

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

// Whether any project is active at noon on the given day.
export function hasActiveProjectOn(projects: Project[], date: string): boolean {
  const noon = new Date(`${date}T12:00:00`).getTime()
  return projects.some((project) => isProjectActive(project, noon))
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
