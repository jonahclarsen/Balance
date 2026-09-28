import { writable } from 'svelte/store'
import type { Id } from './types'

// Which Today tasks have their subtasks hidden. This is a per-device view
// preference, like scroll speed, so it lives in localStorage rather than in the
// synced planner state.
const STORAGE_KEY = 'balance.collapsedPlanItems'
// Ids of tasks deleted while collapsed are never cleared individually; keeping
// only the most recent ones stops them from accumulating forever.
const MAX_STORED_IDS = 500

function loadCollapsedIds(): Set<Id> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is Id => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveCollapsedIds(ids: Set<Id>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids].slice(-MAX_STORED_IDS)))
  } catch {
    // Keep the session value.
  }
}

export const collapsedPlanItemIds = writable<Set<Id>>(loadCollapsedIds())

export function setPlanItemCollapsed(itemId: Id, collapsed: boolean) {
  collapsedPlanItemIds.update((ids) => {
    if (ids.has(itemId) === collapsed) return ids
    const next = new Set(ids)
    if (collapsed) next.add(itemId)
    else next.delete(itemId)
    saveCollapsedIds(next)
    return next
  })
}
