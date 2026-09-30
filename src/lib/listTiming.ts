import { listRowSourceItemId } from './planner'
import type { Id, ListInstance, PlanItem } from './types'

// How many of the most recent finished runs describe a list's current pace.
const RECENT_RUN_COUNT = 7
// A gap this long between check-offs means the list was left unattended, so
// that task and that run aren't timed.
const UNATTENDED_GAP_MS = 60 * 60 * 1000
// Runs needed before an over-time pattern is worth pointing out.
const MIN_RUNS_FOR_NUDGE = 3
// The trim suggestion reappears at most this often after being dismissed.
export const LIST_TRIM_NUDGE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

type Completion = { item: PlanItem; at: number }

export type ListRunTiming = {
  startedAt: number | null
  finishedAt: number | null
  // Some gap between check-offs was long enough that the list was left alone.
  unattended: boolean
  // Time between each leaf row's check-off and the check-off before it, keyed
  // by the template item it came from. The first check-off starts the clock and
  // has no measured duration.
  itemDurations: Array<{ sourceItemId: Id; durationMs: number }>
}

export type ListTimingSummary = {
  runCount: number
  typicalRunMs: number | null
  typicalItemMs: Map<Id, number>
}

function completions(items: PlanItem[], into: Completion[] = []): Completion[] {
  for (const item of items) {
    if (item.done && typeof item.doneAt === 'number') into.push({ item, at: item.doneAt * 1000 })
    completions(item.children, into)
  }
  return into
}

function allDone(items: PlanItem[]): boolean {
  return items.every((item) => item.done && allDone(item.children))
}

// List edits replace the items array, so an unchanged list keeps its cached
// timing and a check-off re-times only the list it happened in.
const runTimingCache = new WeakMap<PlanItem[], ListRunTiming>()

export function listRunTiming(instance: Pick<ListInstance, 'items' | 'createdAt'>): ListRunTiming {
  const cached = runTimingCache.get(instance.items)
  if (cached) return cached
  const timing = computeListRunTiming(instance.items, Date.parse(instance.createdAt))
  runTimingCache.set(instance.items, timing)
  return timing
}

function computeListRunTiming(items: PlanItem[], createdAt: number): ListRunTiming {
  const done = completions(items).sort((a, b) => a.at - b.at)
  const itemDurations: ListRunTiming['itemDurations'] = []
  let unattended = false
  for (let index = 1; index < done.length; index += 1) {
    const { item, at } = done[index]
    const durationMs = at - done[index - 1].at
    if (durationMs > UNATTENDED_GAP_MS) {
      unattended = true
      continue
    }
    // Parents close with their last child, so only leaves carry real work.
    const sourceItemId = item.children.length > 0 ? null : listRowSourceItemId(item.id)
    if (sourceItemId) itemDurations.push({ sourceItemId, durationMs })
  }
  const finished = items.length > 0 && done.length > 1 && allDone(items)
  const base = Number.isFinite(createdAt) ? createdAt : 0
  return {
    startedAt: done.length > 0 ? base + done[0].at : null,
    finishedAt: finished ? base + done[done.length - 1].at : null,
    unattended,
    itemDurations,
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

// A task that ran far past its usual time most likely means you were
// interrupted, so it shouldn't count toward what the task normally costs.
function outlierLimit(values: number[]): number {
  if (values.length < 4) return Infinity
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  return q3 + 1.5 * (q3 - q1)
}

// Summarize a template's finished runs. Each run's duration substitutes the
// task's typical time for any outlier task, so one interruption doesn't make a
// whole run look slow.
export function summarizeListTiming(lists: ListInstance[], listTemplateId: Id): ListTimingSummary {
  const runs = lists
    .filter((list) => list.listTemplateId === listTemplateId)
    .map(listRunTiming)
    .filter(
      (run): run is ListRunTiming & { startedAt: number; finishedAt: number } =>
        run.finishedAt !== null && !run.unattended,
    )
    .sort((a, b) => b.finishedAt - a.finishedAt)

  const samples = new Map<Id, number[]>()
  for (const run of runs) {
    for (const { sourceItemId, durationMs } of run.itemDurations) {
      const values = samples.get(sourceItemId) ?? []
      values.push(durationMs)
      samples.set(sourceItemId, values)
    }
  }

  const limits = new Map<Id, number>()
  const typicalItemMs = new Map<Id, number>()
  for (const [sourceItemId, values] of samples) {
    const limit = outlierLimit(values)
    limits.set(sourceItemId, limit)
    typicalItemMs.set(sourceItemId, median(values.filter((value) => value <= limit)))
  }

  const recentRunMs = runs.slice(0, RECENT_RUN_COUNT).map((run) => {
    let durationMs = run.finishedAt - run.startedAt
    for (const { sourceItemId, durationMs: itemMs } of run.itemDurations) {
      if (itemMs > (limits.get(sourceItemId) ?? Infinity)) {
        durationMs -= itemMs - (typicalItemMs.get(sourceItemId) ?? 0)
      }
    }
    return durationMs
  })

  return {
    runCount: runs.length,
    typicalRunMs: recentRunMs.length > 0 ? median(recentRunMs) : null,
    typicalItemMs,
  }
}

// Suggest trimming when recent runs have consistently gone past the ideal.
export function shouldSuggestTrim(summary: ListTimingSummary, idealMinutes: number | undefined): boolean {
  if (!idealMinutes || summary.typicalRunMs === null || summary.runCount < MIN_RUNS_FOR_NUDGE) return false
  return summary.typicalRunMs > idealMinutes * 60_000
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.round(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}
