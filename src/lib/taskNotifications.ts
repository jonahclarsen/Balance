import type { AppState, PlanItem } from './types'

const cachedItemIds = new WeakMap<PlanItem[], ReadonlySet<string>>()
function itemIds(items: PlanItem[]): ReadonlySet<string> {
  const cached = cachedItemIds.get(items)
  if (cached) return cached
  const ids = new Set<string>()
  for (const item of items) {
    ids.add(item.id)
    for (const id of itemIds(item.children)) ids.add(id)
  }
  cachedItemIds.set(items, ids)
  return ids
}

export function reconcileTaskNotifications(before: AppState, after: AppState): AppState {
  if (before.plans === after.plans && before.lists === after.lists && before.taskNotifications === after.taskNotifications) return after
  if (!after.taskNotifications.length) return after
  // A synced day ID may be replaced while its tasks survive. Native scheduling
  // resolves the source ID alias and checks the task's calendar-day membership.
  const plans = after.plans.map(plan => itemIds(plan.items))
  const lists = new Map(after.lists.map(list => [list.id, itemIds(list.items)]))
  const records = after.taskNotifications.filter(record => record.sourceKind === 'plan'
    ? plans.some(ids => ids.has(record.itemId))
    : lists.get(record.sourceId)?.has(record.itemId))
  return records.length === after.taskNotifications.length ? after : { ...after, taskNotifications: records }
}
