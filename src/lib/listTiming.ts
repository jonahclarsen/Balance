import { listItemAppearanceChance, listItemVariants, listRowSourceItemId } from './planner'
import type { Id, ListInstance, ListTemplateItem, PlanItem } from './types'

// A gap this long between check-offs means the list was left unattended, so
// that task and that run aren't timed.
const UNATTENDED_GAP_MS = 60 * 60 * 1000
// Runs needed before an over-time pattern is worth pointing out.
const MIN_RUNS_FOR_NUDGE = 3
// Timed runs of a task needed before running long on it pauses the clock.
const MIN_SAMPLES_TO_PAUSE = 3
const MIN_PAUSE_MARGIN_MS = 2 * 60 * 1000

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
  // Every gap between check-offs, including unattended ones and parent rows
  // (no source item), which close with their last child.
  steps: Array<{ sourceItemId: Id | null; durationMs: number }>
  lastCheckedAt: number | null
  // The first leaf not checked off yet, which the running clock is timing.
  currentSourceItemId: Id | null
}

export type ListPace = {
  typicalItemMs: Map<Id, number>
  // How long a task can run before the list counts as put down.
  pauseAfterItemMs: Map<Id, number>
}

export type ListTimingSummary = {
  runCount: number
  expectedRunMs: number | null
  typicalItemMs: Map<Id, number>
}

// A row reopened to reread it keeps its stamp, so it still counts while open.
function completions(items: PlanItem[], into: Completion[] = []): Completion[] {
  for (const item of items) {
    if (typeof item.doneAt === 'number') into.push({ item, at: item.doneAt * 1000 })
    completions(item.children, into)
  }
  return into
}

function firstOpenLeaf(items: PlanItem[]): PlanItem | null {
  for (const item of items) {
    const open = item.children.length > 0 ? firstOpenLeaf(item.children) : !item.done && item.doneAt === undefined ? item : null
    if (open) return open
  }
  return null
}

function allDone(items: PlanItem[]): boolean {
  return items.every((item) => item.done && allDone(item.children))
}

// Reopening a row this soon after checking it means it wasn't finished.
const RESTAMP_WINDOW_S = 30

// Stamp list rows as they are checked off so list and task durations can be
// measured. Reopening a row right after checking it clears the stamp, so the
// next check-off restamps it. Reopening it later, as moving back up to reread
// does, keeps the stamp so rechecking it doesn't retime the row. The stamp is
// an offset from the list's createdAt, which never changes, so every device
// measures from the same base.
export function withListCompletionTime(listCreatedAt: string, previous: PlanItem, item: PlanItem, now: number): PlanItem {
  if (item.done === previous.done) return item
  const at = Math.round((now - Date.parse(listCreatedAt)) / 1000)
  if (item.done) return item.doneAt === undefined ? { ...item, doneAt: at } : item
  if (item.doneAt === undefined || at - item.doneAt >= RESTAMP_WINDOW_S) return item
  const { doneAt: _doneAt, ...reopened } = item
  return reopened
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
  const steps: ListRunTiming['steps'] = []
  let unattended = false
  for (let index = 1; index < done.length; index += 1) {
    const { item, at } = done[index]
    const durationMs = at - done[index - 1].at
    // Parents close with their last child, so only leaves carry real work.
    const sourceItemId = item.children.length > 0 ? null : listRowSourceItemId(item.id)
    steps.push({ sourceItemId, durationMs })
    if (durationMs > UNATTENDED_GAP_MS) {
      unattended = true
      continue
    }
    if (sourceItemId) itemDurations.push({ sourceItemId, durationMs })
  }
  const finished = items.length > 0 && done.length > 1 && allDone(items)
  const base = Number.isFinite(createdAt) ? createdAt : 0
  const current = firstOpenLeaf(items)
  return {
    startedAt: done.length > 0 ? base + done[0].at : null,
    finishedAt: finished ? base + done[done.length - 1].at : null,
    unattended,
    itemDurations,
    steps,
    lastCheckedAt: done.length > 0 ? base + done[done.length - 1].at : null,
    currentSourceItemId: current ? listRowSourceItemId(current.id) : null,
  }
}

// Time spent on a run. A task that runs far past its usual time means the list
// was put down, so the clock pauses there and that task counts as its usual
// time however long it takes. A task with no history counts as untimed once
// it has been left for an hour.
export function listRunElapsed(timing: ListRunTiming, pace: ListPace, now: number): { elapsedMs: number; paused: boolean } {
  if (timing.startedAt === null || timing.lastCheckedAt === null) return { elapsedMs: 0, paused: false }
  let elapsedMs = 0
  for (const step of timing.steps) elapsedMs += countedStep(step.sourceItemId, step.durationMs, pace).ms
  if (timing.finishedAt !== null) return { elapsedMs, paused: false }
  const live = countedStep(timing.currentSourceItemId, Math.max(0, now - timing.lastCheckedAt), pace)
  return { elapsedMs: elapsedMs + live.ms, paused: live.paused }
}

function countedStep(sourceItemId: Id | null, durationMs: number, pace: ListPace): { ms: number; paused: boolean } {
  const limit = (sourceItemId === null ? undefined : pace.pauseAfterItemMs.get(sourceItemId)) ?? UNATTENDED_GAP_MS
  if (durationMs <= limit) return { ms: durationMs, paused: false }
  return { ms: (sourceItemId === null ? undefined : pace.typicalItemMs.get(sourceItemId)) ?? 0, paused: true }
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

// Historical samples depend on saved runs, not the template being typed in.
// Keep their medians stable across template edits, including the map passed to
// every row. Immutable list updates invalidate this cache on check-off/undo/sync.
const historyTimingCache = new WeakMap<ListInstance[], Map<Id, ListPace & { runCount: number }>>()

function historicalTiming(lists: ListInstance[], listTemplateId: Id) {
  let byTemplate = historyTimingCache.get(lists)
  if (!byTemplate) {
    byTemplate = new Map()
    historyTimingCache.set(lists, byTemplate)
  }
  const cached = byTemplate.get(listTemplateId)
  if (cached) return cached
  const runs = lists
    .filter((list) => list.listTemplateId === listTemplateId)
    .map(listRunTiming)
    .filter((run) => run.finishedAt !== null && !run.unattended)

  const samples = new Map<Id, number[]>()
  for (const run of runs) {
    for (const { sourceItemId, durationMs } of run.itemDurations) {
      const values = samples.get(sourceItemId) ?? []
      values.push(durationMs)
      samples.set(sourceItemId, values)
    }
  }

  const typicalItemMs = new Map<Id, number>()
  const pauseAfterItemMs = new Map<Id, number>()
  for (const [sourceItemId, values] of samples) {
    const limit = outlierLimit(values)
    const kept = values.filter((value) => value <= limit).sort((a, b) => a - b)
    const typical = median(kept)
    typicalItemMs.set(sourceItemId, typical)
    if (kept.length < MIN_SAMPLES_TO_PAUSE) continue
    // Far beyond even a slow run of the task: an extreme-outlier fence, at
    // least triple the usual time, and never sooner than a couple of minutes.
    const q1 = quantile(kept, 0.25)
    const q3 = quantile(kept, 0.75)
    const fence = Math.max(q3 + 3 * (q3 - q1), 3 * typical, typical + MIN_PAUSE_MARGIN_MS)
    pauseAfterItemMs.set(sourceItemId, Math.min(fence, UNATTENDED_GAP_MS))
  }

  const result = { runCount: runs.length, typicalItemMs, pauseAfterItemMs }
  byTemplate.set(listTemplateId, result)
  return result
}

export function listPace(lists: ListInstance[], listTemplateId: Id): ListPace {
  return historicalTiming(lists, listTemplateId)
}

// Each wording's typical time is weighted by its current appearance chance,
// so changes to the template still update the estimate immediately.
export function summarizeListTiming(lists: ListInstance[], listTemplateId: Id, templateItems: ListTemplateItem[]): ListTimingSummary {
  const { runCount, typicalItemMs } = historicalTiming(lists, listTemplateId)
  const expected = expectedItemsMs(templateItems, 1, typicalItemMs)
  return {
    runCount,
    expectedRunMs: expected.timed ? expected.ms : null,
    typicalItemMs,
  }
}

function expectedItemsMs(
  items: ListTemplateItem[],
  ancestorChance: number,
  typicalItemMs: Map<Id, number>,
): { ms: number; timed: boolean } {
  let ms = 0
  let timed = false
  for (const item of items) {
    for (const variant of listItemVariants(item)) {
      const typical = typicalItemMs.get(variant.id)
      if (typical === undefined) continue
      ms += typical * variant.chance * ancestorChance
      timed = true
    }
    const children = expectedItemsMs(item.children, ancestorChance * listItemAppearanceChance(item), typicalItemMs)
    ms += children.ms
    timed ||= children.timed
  }
  return { ms, timed }
}

// Compare at the displayed minute so "8 min" never reads as over an 8 min ideal.
export function exceedsIdealMinutes(ms: number, idealMinutes: number | undefined): boolean {
  return Boolean(idealMinutes) && roundedMinutes(ms) > (idealMinutes ?? 0)
}

// Suggest trimming once enough runs have been timed to trust the expected time.
export function shouldSuggestTrim(summary: ListTimingSummary, idealMinutes: number | undefined): boolean {
  if (summary.expectedRunMs === null || summary.runCount < MIN_RUNS_FOR_NUDGE) return false
  return exceedsIdealMinutes(summary.expectedRunMs, idealMinutes)
}

function roundedMinutes(ms: number): number {
  return Math.round(Math.max(0, Math.round(ms / 1000)) / 60)
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} sec`
  const totalMinutes = roundedMinutes(ms)
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`
}
