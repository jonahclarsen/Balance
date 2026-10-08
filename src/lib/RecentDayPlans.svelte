<svelte:options immutable />

<script lang="ts">
  import { onDestroy } from 'svelte'
  import { buildItemTimeWarnings, type ItemTimeWarning } from './planner'
  import type { DailyPlan, Id, PlanItem } from './types'

  export let plans: DailyPlan[]
  export let activePlanId: Id | null

  // Retain editor DOM, not snapshots of planner data. Hidden days receive edits,
  // undo and sync updates through the same live plans as the visible day.
  const RETENTION_MS = 3 * 60 * 1000
  const MAX_DAYS = 3
  let retainedIds: Id[] = []
  let previousActiveId: Id | null = null
  const inactiveSince = new Map<Id, number>()
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const warnings = new WeakMap<PlanItem[], ReadonlyMap<Id, ItemTimeWarning>>()

  function timeWarnings(items: PlanItem[]) {
    let result = warnings.get(items)
    if (!result) {
      result = buildItemTimeWarnings(items)
      warnings.set(items, result)
    }
    return result
  }

  function retain(activeId: Id | null, availablePlans: DailyPlan[]) {
    const now = Date.now()
    if (activeId !== previousActiveId) {
      if (previousActiveId) inactiveSince.set(previousActiveId, now)
      if (activeId) inactiveSince.delete(activeId)
      previousActiveId = activeId
    }
    const availableIds = new Set(availablePlans.map((plan) => plan.id))
    let nextIds = retainedIds.filter((id) => availableIds.has(id) &&
      (id === activeId || now - (inactiveSince.get(id) ?? 0) < RETENTION_MS))
    if (activeId && availableIds.has(activeId) && !nextIds.includes(activeId)) nextIds.push(activeId)
    if (nextIds.length > MAX_DAYS) {
      const oldestId = nextIds.filter((id) => id !== activeId)
        .sort((a, b) => (inactiveSince.get(a) ?? 0) - (inactiveSince.get(b) ?? 0))[0]
      nextIds = nextIds.filter((id) => id !== oldestId)
    }
    for (const id of inactiveSince.keys()) if (!nextIds.includes(id)) inactiveSince.delete(id)
    if (nextIds.length !== retainedIds.length || nextIds.some((id, index) => id !== retainedIds[index])) {
      retainedIds = nextIds
    }
    clearTimeout(expiryTimer)
    const deadlines = [...inactiveSince.values()].map((since) => since + RETENTION_MS - now)
    if (deadlines.length) expiryTimer = setTimeout(() => retain(activePlanId, plans), Math.min(...deadlines))
  }

  $: retain(activePlanId, plans)
  $: retainedPlans = retainedIds.flatMap((id) => {
    const plan = plans.find((entry) => entry.id === id)
    return plan ? [plan] : []
  })
  onDestroy(() => clearTimeout(expiryTimer))
</script>

{#each retainedPlans as plan (plan.id)}
  <div class="retained-day" hidden={plan.id !== activePlanId} inert={plan.id !== activePlanId}>
    <slot {plan} timeWarnings={timeWarnings(plan.items)} />
  </div>
{/each}

<style>
  .retained-day { display: contents; }
  .retained-day[hidden] { display: none; }
</style>
