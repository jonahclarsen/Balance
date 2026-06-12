import { nowISO, todayISO } from './planner'
import type { AppState, DailyPlan, Goal, GoalActivityPeriod, GoalCompletion, Id, PlanItem } from './types'

export const GOAL_HISTORY_DEFAULT_DAYS = 30
export const GOAL_HISTORY_MAX_DAYS = 3660
export const GOAL_FUTURE_DAYS = 6
export const GOAL_RECALCULATION_AGE_DAYS = 2

export type GoalDayCell = {
  date: string
  active: boolean
  segmentStart: boolean
  segmentEnd: boolean
  completed: boolean
  relieved: boolean
  missed: boolean
  overdue: boolean
  current: boolean
}

export function createGoal(
  name: string,
  cadenceDays: number,
  matchTerms: string[],
  hue: number,
  startDate = todayISO(),
  id: Id,
  neutral = false,
): Goal {
  const timestamp = nowISO()

  return {
    id,
    name: name.trim(),
    cadenceDays: normalizeCadenceDays(cadenceDays),
    matchTerms: normalizeMatchTerms(matchTerms),
    hue: normalizeHue(hue),
    neutral: Boolean(neutral),
    activityPeriods: [{ startDate, endDate: null }],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export function normalizeGoal(goal: Goal): Goal {
  return {
    ...goal,
    name: goal.name?.trim() ?? '',
    cadenceDays: normalizeCadenceDays(goal.cadenceDays),
    matchTerms: normalizeMatchTerms(goal.matchTerms ?? []),
    hue: normalizeHue(goal.hue ?? 165),
    neutral: Boolean(goal.neutral),
    activityPeriods: normalizeActivityPeriods(goal.activityPeriods ?? []),
    createdAt: goal.createdAt ?? nowISO(),
    updatedAt: goal.updatedAt ?? goal.createdAt ?? nowISO(),
  }
}

export function normalizeGoalCompletion(completion: GoalCompletion): GoalCompletion {
  return {
    ...completion,
    itemIds: uniqueStrings(completion.itemIds ?? []),
    matchedTerms: normalizeMatchTerms(completion.matchedTerms ?? []),
    computedAt: completion.computedAt ?? nowISO(),
  }
}

export function normalizeCadenceDays(value: number): number {
  return Math.max(1, Math.min(3650, Math.round(Number(value) || 1)))
}

export function normalizeHue(value: number): number {
  return ((Math.round(Number(value) || 0) % 360) + 360) % 360
}

export function normalizeMatchTerms(terms: string[]): string[] {
  return uniqueStrings(terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean))
}

export function parseMatchTerms(value: string): string[] {
  return normalizeMatchTerms(value.split(/[\n,]+/))
}

export function isGoalActiveOnDate(goal: Goal, date: string): boolean {
  return goal.activityPeriods.some(
    (period) => period.startDate <= date && (period.endDate === null || period.endDate >= date),
  )
}

export function setGoalActiveOnDate(goal: Goal, active: boolean, date = todayISO()): Goal {
  const currentlyActive = isGoalActiveOnDate(goal, date)
  if (currentlyActive === active) return goal

  const activityPeriods = [...goal.activityPeriods]

  if (active) {
    activityPeriods.push({ startDate: date, endDate: null })
  } else {
    const periodIndex = activityPeriods.findIndex(
      (period) => period.startDate <= date && (period.endDate === null || period.endDate >= date),
    )
    if (periodIndex === -1) return goal

    const period = activityPeriods[periodIndex]
    const previousDate = shiftISODate(date, -1)
    if (period.startDate > previousDate) {
      activityPeriods.splice(periodIndex, 1)
    } else {
      activityPeriods[periodIndex] = { ...period, endDate: previousDate }
    }
  }

  return {
    ...goal,
    activityPeriods: normalizeActivityPeriods(activityPeriods),
    updatedAt: nowISO(),
  }
}

export function visibleGoalDates(days: number, endDate = todayISO()): string[] {
  const count = Math.max(1, Math.min(GOAL_HISTORY_MAX_DAYS, Math.round(days) || GOAL_HISTORY_DEFAULT_DAYS))
  return Array.from({ length: count }, (_, index) => shiftISODate(endDate, index - count + 1))
}

export function goalWasActiveInRange(goal: Goal, dates: string[]): boolean {
  const first = dates[0]
  const last = dates.at(-1)
  if (!first || !last) return false

  return goal.activityPeriods.some(
    (period) => period.startDate <= last && (period.endDate === null || period.endDate >= first),
  )
}

export function isGoalDateRecalculable(date: string, currentDate = todayISO()): boolean {
  return date <= currentDate && date >= shiftISODate(currentDate, -GOAL_RECALCULATION_AGE_DAYS)
}

export function reconcileGoalCompletionsForDate(state: AppState, date: string): GoalCompletion[] {
  if (!isGoalDateRecalculable(date)) return state.goalCompletions

  const plan = state.plans.find((candidate) => candidate.date === date)
  const otherDates = state.goalCompletions.filter((completion) => completion.date !== date)
  if (!plan) return otherDates

  const existingByGoal = new Map(
    state.goalCompletions
      .filter((completion) => completion.date === date)
      .map((completion) => [completion.goalId, completion]),
  )
  const completions = state.goals.flatMap((goal) => {
    if (!isGoalActiveOnDate(goal, date) || goal.matchTerms.length === 0) return []

    const match = matchingPlanItems(plan, goal)
    if (match.itemIds.length === 0) return []

    const existing = existingByGoal.get(goal.id)
    if (
      existing &&
      sameStrings(existing.itemIds, match.itemIds) &&
      sameStrings(existing.matchedTerms, match.matchedTerms)
    ) {
      return [existing]
    }

    return [
      {
        goalId: goal.id,
        date,
        itemIds: match.itemIds,
        matchedTerms: match.matchedTerms,
        computedAt: nowISO(),
      },
    ]
  })

  return [...otherDates, ...completions].sort(compareGoalCompletions)
}

export function reconcileRecentGoalCompletions(state: AppState): GoalCompletion[] {
  let goalCompletions = state.goalCompletions

  for (const plan of state.plans) {
    if (!isGoalDateRecalculable(plan.date)) continue
    goalCompletions = reconcileGoalCompletionsForDate({ ...state, goalCompletions }, plan.date)
  }

  return goalCompletions
}

export function goalCompletionsEqual(left: GoalCompletion[], right: GoalCompletion[]): boolean {
  if (left.length !== right.length) return false

  return left.every((completion, index) => {
    const other = right[index]
    return (
      completion.goalId === other?.goalId &&
      completion.date === other.date &&
      completion.computedAt === other.computedAt &&
      sameStrings(completion.itemIds, other.itemIds) &&
      sameStrings(completion.matchedTerms, other.matchedTerms)
    )
  })
}

export function goalMatchesForItem(
  goals: Goal[],
  completions: GoalCompletion[],
  date: string,
  itemId: Id,
): Goal[] {
  const goalIds = new Set(
    completions
      .filter((completion) => completion.date === date && completion.itemIds.includes(itemId))
      .map((completion) => completion.goalId),
  )
  return goals.filter((goal) => goalIds.has(goal.id))
}

/**
 * Of the goals already known to be due today, returns those whose match terms
 * appear in the item's text. Kept cheap by parsing text the same way goal
 * completion does (lowercase substring) and only ever scanning the handful of
 * due-today goals the caller precomputes — never the full goal list per item.
 */
export function dueTodayGoalsForItem(item: PlanItem, dueTodayGoals: Goal[]): Goal[] {
  if (dueTodayGoals.length === 0) return []

  const normalizedText = item.text.toLocaleLowerCase()
  return dueTodayGoals.filter((goal) => goal.matchTerms.some((term) => normalizedText.includes(term)))
}

export function planItemGoalMatchesChanged(goals: Goal[], date: string, before: PlanItem, after: PlanItem): boolean {
  if (!isGoalDateRecalculable(date)) return false
  if (!before.done && !after.done) return false
  if (before.done === after.done && before.text === after.text) return false

  return goals.some((goal) => {
    if (!isGoalActiveOnDate(goal, date) || goal.matchTerms.length === 0) return false
    return !sameStrings(matchingTermsForItem(before, goal), matchingTermsForItem(after, goal))
  })
}

export function buildGoalDayCells(
  goal: Goal,
  completions: GoalCompletion[],
  dates: string[],
  currentDate = todayISO(),
): GoalDayCell[] {
  const completionDates = new Set(
    completions.filter((completion) => completion.goalId === goal.id).map((completion) => completion.date),
  )
  const sortedCompletions = [...completionDates].sort()
  const cells = dates.map<GoalDayCell>((date) => ({
    date,
    active: isGoalActiveOnDate(goal, date),
    segmentStart: false,
    segmentEnd: false,
    completed: completionDates.has(date),
    relieved: false,
    missed: false,
    overdue: false,
    current: false,
  }))
  const indexesByDate = new Map(dates.map((date, index) => [date, index]))

  for (const period of goal.activityPeriods) {
    const visibleStart = dates[0]
    const visibleEnd = dates.at(-1)
    if (!visibleStart || !visibleEnd || period.startDate > visibleEnd || (period.endDate && period.endDate < visibleStart)) {
      continue
    }

    let segmentStart = period.startDate
    const periodEnd = period.endDate ?? visibleEnd

    while (segmentStart <= periodEnd && segmentStart <= visibleEnd) {
      const deadline = minISODate(shiftISODate(segmentStart, goal.cadenceDays - 1), periodEnd)
      const satisfied = completionDates.has(segmentStart)
      // A satisfied segment only re-anchors on a completion inside its
      // coverage; an owed segment stays open past its deadline (overdue)
      // until the next completion finally starts the following cycle. With
      // no completion yet, it is clipped at the current day so the days
      // beyond it render as projected cadence-length cycles, not one bar.
      const completionCutoff = satisfied ? deadline : periodEnd
      const nextCompletion = sortedCompletions.find((date) => date > segmentStart && date <= completionCutoff)
      const segmentEnd = nextCompletion
        ? shiftISODate(nextCompletion, -1)
        : satisfied
          ? deadline
          : minISODate(maxISODate(deadline, currentDate), periodEnd)
      markSegment(cells, indexesByDate, segmentStart, segmentEnd, deadline, completionDates, currentDate)
      segmentStart = nextCompletion ?? shiftISODate(segmentEnd, 1)
    }
  }

  return cells
}

/**
 * Days from `currentDate` until the goal is defaulted on (or, when negative,
 * since it defaulted). Uses the same segment logic as `buildGoalDayCells`: a
 * segment starts at the activity-period start or on a completion date, and its
 * deadline is `min(segmentStart + cadenceDays - 1, periodEnd)`. A segment that
 * starts on a completion is "satisfied" (the relieved rectangle); otherwise it
 * is the open period you owe.
 *
 * - Owed current period (including a goal not yet done for the first time):
 *   the deadline is its natural end, and the period does not roll over when
 *   that deadline passes — it stays open, increasingly overdue, until the next
 *   completion. That completion counts as the first of the *next* cycle; the
 *   overrun cycle stays failed in history.
 * - Satisfied current period: you are covered through its end, so the deadline
 *   is the natural end of the *next* period.
 *
 * Returns the signed day delta (0 = due today, negative = overdue). Returns
 * `null` when the goal is not active on `currentDate`, has no current segment,
 * or its activity period ends before the next obligation, so callers can
 * sort/treat such goals as non-urgent.
 */
export function goalDaysUntilLapse(
  goal: Goal,
  completions: GoalCompletion[],
  currentDate = todayISO(),
): number | null {
  if (!isGoalActiveOnDate(goal, currentDate)) return null

  const period = goal.activityPeriods.find(
    (candidate) => candidate.startDate <= currentDate && (candidate.endDate === null || candidate.endDate >= currentDate),
  )
  if (!period) return null

  const sortedCompletions = [
    ...new Set(completions.filter((completion) => completion.goalId === goal.id).map((completion) => completion.date)),
  ].sort()
  const completionDates = new Set(sortedCompletions)

  let segmentStart = period.startDate
  while (segmentStart <= currentDate) {
    const cadenceEnd = shiftISODate(segmentStart, goal.cadenceDays - 1)
    const deadline = period.endDate ? minISODate(cadenceEnd, period.endDate) : cadenceEnd
    const satisfied = completionDates.has(segmentStart)
    const completionCutoff = satisfied ? deadline : period.endDate
    const nextCompletion = sortedCompletions.find(
      (date) => date > segmentStart && (completionCutoff === null || date <= completionCutoff),
    )

    if (!satisfied) {
      // Owed period: it stays open (overdue past its deadline) until the next
      // completion, so currentDate is inside it unless that completion has
      // already happened.
      if (!nextCompletion || currentDate < nextCompletion) return isoDateDiffDays(currentDate, deadline)
      segmentStart = nextCompletion
      continue
    }

    const segmentEnd = nextCompletion ? shiftISODate(nextCompletion, -1) : deadline
    if (currentDate <= segmentEnd) {
      // Satisfied period: covered through its end, so the deadline is the
      // natural end of the next period, unless the activity period stops first.
      if (period.endDate && deadline >= period.endDate) return null
      const nextCadenceEnd = shiftISODate(deadline, goal.cadenceDays)
      const nextDeadline = period.endDate ? minISODate(nextCadenceEnd, period.endDate) : nextCadenceEnd
      return isoDateDiffDays(currentDate, nextDeadline)
    }

    segmentStart = nextCompletion ?? shiftISODate(segmentEnd, 1)
  }

  return null
}

/**
 * Sorts a copy of `goals` by urgency. Daily goals always come first. Other
 * goals sort by the closest lapse date (including overdue/negative values),
 * then by shortest cadence. Goals with no current segment
 * (`goalDaysUntilLapse` returns `null`) sort last, except for the daily-goal
 * override. Remaining ties fall back to the original order for stability.
 */
export function sortGoalsByUrgency(goals: Goal[], completions: GoalCompletion[], currentDate = todayISO()): Goal[] {
  const urgency = new Map(goals.map((goal) => [goal.id, goalDaysUntilLapse(goal, completions, currentDate)]))
  const order = new Map(goals.map((goal, index) => [goal.id, index]))

  return [...goals].sort((left, right) => {
    const dailyDifference = Number(right.cadenceDays === 1) - Number(left.cadenceDays === 1)
    if (dailyDifference !== 0) return dailyDifference

    const leftDays = urgency.get(left.id) ?? null
    const rightDays = urgency.get(right.id) ?? null
    if (leftDays === null && rightDays === null) {
      return left.cadenceDays - right.cadenceDays || (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)
    }
    if (leftDays === null) return 1
    if (rightDays === null) return -1
    return (
      leftDays - rightDays ||
      left.cadenceDays - right.cadenceDays ||
      (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)
    )
  })
}

export function shiftISODate(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return todayISO()

  const shifted = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)
  const year = shifted.getFullYear()
  const month = String(shifted.getMonth() + 1).padStart(2, '0')
  const day = String(shifted.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function hueToHex(hue: number): string {
  const normalized = normalizeHue(hue)
  const saturation = 0.58
  const lightness = 0.48
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = chroma * (1 - Math.abs(((normalized / 60) % 2) - 1))
  const offset = lightness - chroma / 2
  const [red, green, blue] =
    normalized < 60
      ? [chroma, x, 0]
      : normalized < 120
        ? [x, chroma, 0]
        : normalized < 180
          ? [0, chroma, x]
          : normalized < 240
            ? [0, x, chroma]
            : normalized < 300
              ? [x, 0, chroma]
              : [chroma, 0, x]

  return `#${[red, green, blue]
    .map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, '0'))
    .join('')}`
}

export function hexToHue(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!match) return 0

  const value = match[1]
  const red = Number.parseInt(value.slice(0, 2), 16) / 255
  const green = Number.parseInt(value.slice(2, 4), 16) / 255
  const blue = Number.parseInt(value.slice(4, 6), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  if (delta === 0) return 0

  const raw =
    max === red
      ? ((green - blue) / delta) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4
  return normalizeHue(raw * 60)
}

function matchingPlanItems(plan: DailyPlan, goal: Goal): { itemIds: Id[]; matchedTerms: string[] } {
  const itemIds: Id[] = []
  const matchedTerms = new Set<string>()

  function visit(items: PlanItem[]) {
    for (const item of items) {
      if (item.done) {
        const normalizedText = item.text.toLocaleLowerCase()
        const terms = goal.matchTerms.filter((term) => normalizedText.includes(term))
        if (terms.length > 0) {
          itemIds.push(item.id)
          terms.forEach((term) => matchedTerms.add(term))
        }
      }
      visit(item.children)
    }
  }

  visit(plan.items)
  return { itemIds: uniqueStrings(itemIds), matchedTerms: [...matchedTerms].sort() }
}

function matchingTermsForItem(item: PlanItem, goal: Goal): string[] {
  if (!item.done) return []

  const normalizedText = item.text.toLocaleLowerCase()
  return goal.matchTerms.filter((term) => normalizedText.includes(term))
}

function markSegment(
  cells: GoalDayCell[],
  indexesByDate: Map<string, number>,
  startDate: string,
  endDate: string,
  deadline: string,
  completionDates: Set<string>,
  currentDate: string,
) {
  const startIndex = indexesByDate.get(maxISODate(startDate, cells[0]?.date ?? startDate))
  const endIndex = indexesByDate.get(minISODate(endDate, cells.at(-1)?.date ?? endDate))
  if (startIndex === undefined || endIndex === undefined || startIndex > endIndex) return

  const satisfied = completionDates.has(startDate)
  // An owed cycle counts as failed once its deadline passes without a rescue
  // (any completion inside the window would have re-anchored the segment).
  const failed = !satisfied && deadline < currentDate
  const isCurrentSegment = startDate <= currentDate && currentDate <= endDate

  for (let index = startIndex; index <= endIndex; index += 1) {
    const cell = cells[index]
    cell.segmentStart = index === startIndex
    cell.segmentEnd = index === endIndex
    cell.relieved = satisfied && !cell.completed
    cell.missed = failed && !cell.completed && cell.date <= deadline
    cell.overdue = !satisfied && !cell.completed && cell.date > deadline && cell.date <= currentDate
    cell.current = isCurrentSegment
  }
}

function normalizeActivityPeriods(periods: GoalActivityPeriod[]): GoalActivityPeriod[] {
  const normalized = periods
    .filter((period) => Boolean(period.startDate))
    .map((period) => ({
      startDate: period.startDate,
      endDate: period.endDate && period.endDate >= period.startDate ? period.endDate : null,
    }))
    .sort((left, right) => left.startDate.localeCompare(right.startDate))

  return normalized.reduce<GoalActivityPeriod[]>((merged, period) => {
    const previous = merged.at(-1)
    if (!previous) {
      merged.push(period)
      return merged
    }

    const touchesPrevious = previous.endDate === null || period.startDate <= shiftISODate(previous.endDate, 1)
    if (!touchesPrevious) {
      merged.push(period)
      return merged
    }

    previous.endDate =
      previous.endDate === null || period.endDate === null
        ? null
        : maxISODate(previous.endDate, period.endDate)
    return merged
  }, [])
}

function compareGoalCompletions(left: GoalCompletion, right: GoalCompletion): number {
  return left.date.localeCompare(right.date) || left.goalId.localeCompare(right.goalId)
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function minISODate(left: string, right: string): string {
  return left < right ? left : right
}

export function isoDateDiffDays(from: string, to: string): number {
  const parse = (date: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (!match) return Date.now()
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  }
  return Math.round((parse(to) - parse(from)) / 86_400_000)
}

function maxISODate(left: string, right: string): string {
  return left > right ? left : right
}
