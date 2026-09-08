import type { AppState, DailyPlan, PlanItem, UneditedPlanItem } from './types'

// A marker's presence means untouched. No task content or false-valued marker
// is retained after an edit. These records use the generic replicated storage.
export function generatedItemMarkers(items: PlanItem[]): UneditedPlanItem[] {
  return items.flatMap((item) => [{ id: item.id }, ...generatedItemMarkers(item.children)])
}

export function preservedPlanItems(plan: DailyPlan, markers: UneditedPlanItem[]): PlanItem[] {
  const unedited = new Set(markers.map((marker) => marker.id))
  const touched = (item: PlanItem): boolean => !unedited.has(item.id) || item.children.some(touched)
  // Keep the entire affected root group so children never lose their context.
  return plan.items.filter(touched)
}

type Location = { item: PlanItem; planId: string; parentId: string | null; siblings: PlanItem[] }
function locations(plans: DailyPlan[]): Map<string, Location> {
  const result = new Map<string, Location>()
  function visit(items: PlanItem[], planId: string, parentId: string | null) {
    for (const item of items) {
      result.set(item.id, { item, planId, parentId, siblings: items })
      visit(item.children, planId, item.id)
    }
  }
  for (const plan of plans) visit(plan.items, plan.id, null)
  return result
}

function sameParent(a: Location, b: Location): boolean {
  return a.planId === b.planId && a.parentId === b.parentId
}

// Compare order only among surviving siblings. Inserting/deleting another row
// must not make every following untouched task count as moved.
function sharedRanks(current: Map<string, Location>, other: Map<string, Location>): Map<string, number> {
  const ranks = new Map<string, number>()
  const counts = new Map<PlanItem[], number>()
  for (const [id, location] of current) {
    const previous = other.get(id)
    if (!previous || !sameParent(location, previous)) continue
    const rank = counts.get(location.siblings) ?? 0
    ranks.set(id, rank)
    counts.set(location.siblings, rank + 1)
  }
  return ranks
}

function sameContent(before: PlanItem, after: PlanItem): boolean {
  if (before === after) return true
  const { children: beforeChildren, ...beforeFields } = before
  const { children: afterChildren, ...afterFields } = after
  return JSON.stringify(beforeFields) === JSON.stringify(afterFields) &&
    beforeChildren.length === afterChildren.length &&
    beforeChildren.every((item, index) => item.id === afterChildren[index].id)
}

export function reconcileUneditedPlanItems(before: AppState, after: AppState): AppState {
  if (before.plans === after.plans || after.uneditedPlanItems.length === 0) return after
  const previousPlans = new Map(before.plans.map((plan) => [plan.id, plan]))
  const nextPlans = new Map(after.plans.map((plan) => [plan.id, plan]))
  const previous = locations(before.plans.filter((plan) => nextPlans.get(plan.id)?.items !== plan.items))
  const next = locations(after.plans.filter((plan) => previousPlans.get(plan.id)?.items !== plan.items))
  const previousRanks = sharedRanks(previous, next)
  const nextRanks = sharedRanks(next, previous)
  const markers = after.uneditedPlanItems.filter(({ id }) => {
    const old = previous.get(id)
    // New generated items get their markers in the generating transaction.
    if (!old) return true
    const current = next.get(id)
    return current !== undefined && sameParent(old, current) &&
      previousRanks.get(id) === nextRanks.get(id) && sameContent(old.item, current.item)
  })
  return markers.length === after.uneditedPlanItems.length ? after : { ...after, uneditedPlanItems: markers }
}
