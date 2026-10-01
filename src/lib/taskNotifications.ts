import type { AppState, PlanItem } from './types'

export function reconcileTaskNotifications(before: AppState, after: AppState): AppState {
  if (before.plans === after.plans && before.lists === after.lists && before.taskNotifications === after.taskNotifications) return after
  if (!after.taskNotifications.length) return after
  const live = new Set<string>()
  const sources = new Set(after.taskNotifications.map(record => `${record.sourceKind}:${record.sourceId}`))
  function visit(kind: string, source: string, items: PlanItem[]) {
    for (const item of items) {
      live.add(`${kind}:${source}:${item.id}`)
      visit(kind, source, item.children)
    }
  }
  for (const plan of after.plans) if (sources.has(`plan:${plan.id}`)) visit('plan', plan.id, plan.items)
  for (const list of after.lists) if (sources.has(`list:${list.id}`)) visit('list', list.id, list.items)
  const records = after.taskNotifications.filter(record => live.has(`${record.sourceKind}:${record.sourceId}:${record.itemId}`))
  return records.length === after.taskNotifications.length ? after : { ...after, taskNotifications: records }
}
