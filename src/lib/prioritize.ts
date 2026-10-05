import { writable } from 'svelte/store'
import { goalDaysUntilLapse, isGoalActiveOnDate } from './goals'
import type { Goal, GoalCompletion, Id, PriorityItem, Project, ProjectCheckIn } from './types'

const OPEN_SESSION_KEY = 'balance.prioritize.open'
// An untouched session gives way to the start screen after this long.
export const PRIORITIZE_IDLE_MS = 30 * 60 * 1000

// Undo/redo asks the page to show the session (and item) it changed.
export const prioritizeReveal = writable<{ sessionId: Id; itemId?: Id } | null>(null)

export type OpenSession = { id: Id; activeAt: number }

export function readOpenSession(): OpenSession | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPEN_SESSION_KEY) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return null
    const { id, activeAt } = parsed as Record<string, unknown>
    return typeof id === 'string' && typeof activeAt === 'number' ? { id, activeAt } : null
  } catch {
    return null
  }
}

export function writeOpenSession(session: OpenSession | null): void {
  try {
    if (session) localStorage.setItem(OPEN_SESSION_KEY, JSON.stringify(session))
    else localStorage.removeItem(OPEN_SESSION_KEY)
  } catch { /* Keep the in-memory session. */ }
}

// Rated items by descending priority, then unrated items in their fixed order.
export function orderPriorityItems(items: PriorityItem[]): PriorityItem[] {
  const rated = items.filter((item) => item.priority !== undefined)
  const unrated = items.filter((item) => item.priority === undefined)
  return [...rated.sort((left, right) => right.priority! - left.priority!), ...unrated]
}

export function nextUnratedId(ordered: PriorityItem[], currentId: Id | null): Id | null {
  const start = ordered.findIndex((item) => item.id === currentId)
  for (let offset = 1; offset <= ordered.length; offset += 1) {
    const item = ordered[(start + offset) % ordered.length]
    if (item.priority === undefined) return item.id
  }
  return null
}

// Active, incomplete projects in their page order, then goals due today or
// overdue, most overdue first.
export function defaultPrioritySeeds(
  projects: Project[],
  checkIns: ProjectCheckIn[],
  goals: Goal[],
  completions: GoalCompletion[],
  currentDay: string,
): Omit<PriorityItem, 'id'>[] {
  const latestProgress = new Map<Id, { createdAt: string; progress: number }>()
  for (const entry of checkIns) {
    const latest = latestProgress.get(entry.projectId)
    if (!latest || entry.createdAt >= latest.createdAt) latestProgress.set(entry.projectId, entry)
  }
  const openProjects = projects.filter((project) => !project.archived && latestProgress.get(project.id)?.progress !== 100)
  const lapse = new Map(goals.map((goal) => [goal.id, goalDaysUntilLapse(goal, completions, currentDay)]))
  const dueGoals = goals
    .filter((goal) => isGoalActiveOnDate(goal, currentDay) && (lapse.get(goal.id) ?? 1) <= 0)
    .sort((left, right) => lapse.get(left.id)! - lapse.get(right.id)!)
  return [
    ...openProjects.map((project) => ({ text: project.name, projectId: project.id })),
    ...dueGoals.map((goal) => ({ text: goal.name, goalId: goal.id })),
  ]
}
