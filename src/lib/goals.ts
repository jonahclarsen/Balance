import { escapeHTML, nowISO, sanitizeInlineHTML, todayISO } from './planner'
import type { AppState, DailyPlan, Goal, GoalActivityPeriod, GoalCompletion, Id, PlanItem } from './types'

export const GOAL_FUTURE_DAYS = 6
export const GOAL_RECALCULATION_AGE_DAYS = 2

type GoalRecalculationOptions = {
  force?: boolean
}

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
  lightness: number,
  startDate = todayISO(),
  id: Id,
  matchTermsHtml?: string,
): Goal {
  const timestamp = nowISO()
  const normalizedMatchTerms = normalizeMatchTerms(matchTerms)

  return {
    id,
    name: name.trim(),
    cadenceDays: normalizeCadenceDays(cadenceDays),
    matchTerms: normalizedMatchTerms,
    matchTermsHtml: normalizeMatchTermsHtml(matchTermsHtml, normalizedMatchTerms),
    hue: normalizeHue(hue),
    lightness: normalizeLightness(lightness),
    activityPeriods: [{ startDate, endDate: null }],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export function normalizeGoal(goal: Goal): Goal {
  const matchTerms = normalizeMatchTerms(goal.matchTerms ?? [])
  return {
    ...goal,
    name: goal.name?.trim() ?? '',
    cadenceDays: normalizeCadenceDays(goal.cadenceDays),
    matchTerms,
    matchTermsHtml: normalizeMatchTermsHtml(goal.matchTermsHtml, matchTerms),
    hue: normalizeHue(goal.hue ?? 165),
    lightness: normalizeLightness(goal.lightness),
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

// Lightness is a 0–100 control where 50 means "leave the designed colors alone".
// Older goals (and any with a missing value) fall back to that neutral baseline.
export function normalizeLightness(value: number | undefined): number {
  if (value == null || Number.isNaN(Number(value))) return 50
  return Math.max(0, Math.min(100, Math.round(Number(value))))
}

// Convert the 0–100 lightness control into the percentage-point shift applied to
// every goal color: 50 → 0pp, 0 → -25pp, 100 → +25pp.
export function goalLightnessShift(lightness: number | undefined): number {
  return (normalizeLightness(lightness) - 50) / 2
}

export function normalizeMatchTerms(terms: string[]): string[] {
  return uniqueStrings(terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean))
}

export function parseMatchTerms(value: string): string[] {
  return normalizeMatchTerms(value.split(/[\n,]+/))
}

function normalizeMatchTermsHtml(value: string | undefined, matchTerms: string[]): string {
  const fallback = escapeHTML(matchTerms.join(', '))
  return value == null ? fallback : sanitizeInlineHTML(value)
}

// Live filter for the goal search boxes: matches the typed phrase against a
// goal's name or any of its match keywords. Empty/blank query returns all.
export function filterGoalsByPhrase<T extends Pick<Goal, 'name' | 'matchTerms'>>(goals: T[], query: string): T[] {
  const phrase = query.trim().toLocaleLowerCase()
  if (!phrase) return goals
  return goals.filter(
    (goal) =>
      goal.name.toLocaleLowerCase().includes(phrase) ||
      goal.matchTerms.some((term) => term.toLocaleLowerCase().includes(phrase)),
  )
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

// Edits the start of the earliest activity stint. Backdating earlier is always
// allowed; moving later is clamped to that stint's archive date (endDate) so the
// period can never end before it starts (which normalizeActivityPeriods would
// otherwise resolve by silently reactivating the goal). Clamping to the stint's
// own endDate also keeps it from colliding with a later, non-overlapping stint.
export function setGoalStartDate(goal: Goal, date: string): Goal {
  if (!date) return goal
  const period = goal.activityPeriods[0]
  if (!period) return goal

  const clamped = period.endDate ? minISODate(date, period.endDate) : date
  if (clamped === period.startDate) return goal

  const activityPeriods = [...goal.activityPeriods]
  activityPeriods[0] = { ...period, startDate: clamped }

  return {
    ...goal,
    activityPeriods: normalizeActivityPeriods(activityPeriods),
    updatedAt: nowISO(),
  }
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

export function reconcileGoalCompletionsForDate(
  state: AppState,
  date: string,
  options: GoalRecalculationOptions = {},
): GoalCompletion[] {
  if (!options.force && !isGoalDateRecalculable(date)) return state.goalCompletions

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

export function planItemGoalMatchesChanged(
  goals: Goal[],
  date: string,
  before: PlanItem,
  after: PlanItem,
  options: GoalRecalculationOptions = {},
): boolean {
  if (!options.force && !isGoalDateRecalculable(date)) return false
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
    let deadline = minISODate(shiftISODate(segmentStart, goal.cadenceDays - 1), periodEnd)

    while (segmentStart <= periodEnd && segmentStart <= visibleEnd) {
      const nextCompletion = sortedCompletions.find((date) => date >= segmentStart && date <= periodEnd)
      if (!nextCompletion) {
        const openEnd = minISODate(maxISODate(deadline, currentDate), periodEnd)
        markSegment(cells, indexesByDate, segmentStart, openEnd, deadline, false, currentDate)
        break
      }

      if (nextCompletion > segmentStart) {
        const completedOnTime = nextCompletion <= deadline
        markSegment(
          cells,
          indexesByDate,
          segmentStart,
          shiftISODate(nextCompletion, -1),
          deadline,
          completedOnTime,
          currentDate,
        )
      }

      const coverageEnd = minISODate(shiftISODate(nextCompletion, goal.cadenceDays - 1), periodEnd)
      const followingCompletion = sortedCompletions.find(
        (date) => date > nextCompletion && date <= coverageEnd,
      )
      const segmentEnd = followingCompletion ? shiftISODate(followingCompletion, -1) : coverageEnd
      markSegment(cells, indexesByDate, nextCompletion, segmentEnd, coverageEnd, true, currentDate)

      segmentStart = followingCompletion ?? shiftISODate(segmentEnd, 1)
      // Once coverage from a real completion ends, the following day is due.
      deadline = segmentStart
    }
  }

  return cells
}

/**
 * Days from `currentDate` until the goal is defaulted on (or, when negative,
 * since it defaulted). Uses the same rolling logic as `buildGoalDayCells`.
 * Before the first completion, the initial deadline is the last day of the
 * first cadence window. After a completion, `cadenceDays - 1` empty days are
 * allowed and the following day is due; any later completion resets that
 * rolling deadline.
 *
 * An unmet run stays open and becomes increasingly overdue until completion.
 * A completed run is safe through its coverage, with the next day becoming the
 * due date for the next completion.
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
  ]
    .filter((date) => date >= period.startDate && date <= currentDate)
    .sort()
  const latestCompletion = sortedCompletions.at(-1)
  const deadline = latestCompletion
    ? shiftISODate(latestCompletion, goal.cadenceDays)
    : shiftISODate(period.startDate, goal.cadenceDays - 1)

  if (period.endDate && deadline > period.endDate) return null
  return isoDateDiffDays(currentDate, deadline)
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

export function hueToHex(hue: number, lightnessControl = 50): string {
  const normalized = normalizeHue(hue)
  const saturation = 0.58
  // Mirror the CSS: a representative 48% base lightness shifted by the control.
  const lightness = Math.max(0, Math.min(1, 0.48 + goalLightnessShift(lightnessControl) / 100))
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
  satisfied: boolean,
  currentDate: string,
) {
  const startIndex = indexesByDate.get(maxISODate(startDate, cells[0]?.date ?? startDate))
  const endIndex = indexesByDate.get(minISODate(endDate, cells.at(-1)?.date ?? endDate))
  if (startIndex === undefined || endIndex === undefined || startIndex > endIndex) return

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
