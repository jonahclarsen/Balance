import type { PlanItem } from './types'

export type NextTask = { item: PlanItem; ancestors: PlanItem[] }

// The next task is the first unfinished item in reading order. An unfinished
// parent yields to its first unfinished child, since that is the concrete step
// to take; blank rows are skipped.
export function findNextTask(items: PlanItem[], ancestors: PlanItem[] = []): NextTask | null {
  for (const item of items) {
    if (item.done) continue
    const child = findNextTask(item.children, [...ancestors, item])
    if (child) return child
    if (item.text.trim() || item.html.includes('data-balance-image=')) return { item, ancestors }
  }
  return null
}
