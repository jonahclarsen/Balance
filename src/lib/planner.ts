import type {
  AppState,
  DailyPlan,
  DailyTemplate,
  Goal,
  GoalCompletion,
  Id,
  ListInstance,
  ListTemplate,
  ListTemplateItem,
  Metric,
  MetricEntry,
  MetricQuestion,
  MetricQuestionType,
  MoveDirection,
  MovePlacement,
  PlanItem,
  TemplateItem,
  TemplateOption,
} from './types'
import { goalDaysUntilLapse, isGoalActiveOnDate } from './goals'
import { createDefaultReplicatedPreferences } from './preferences'

export const DEFAULT_DAILY_REMINDER = "This shouldn't be aspirational"
export const DAY_ROLLOVER_HOUR = 3
export const SIRI_REMINDERS_HEADING = 'reminders from siri:'

export type BackspacePlanItemAtStartResult = {
  items: PlanItem[]
  operation:
    | { action: 'delete_previous'; previousId: Id }
    | {
        action: 'merge'
        previousId: Id
        patch: Partial<Omit<PlanItem, 'id' | 'children'>>
      }
  focusItemId: Id
  focusOffset: number
}

export type BackspaceTemplateOptionAtStartResult = {
  items: TemplateItem[]
  operation:
    | { action: 'delete_previous_item'; previousItemId: Id }
    | { action: 'delete_previous_option'; previousOptionId: Id }
    | {
        action: 'merge'
        previousItemId: Id
        previousOptionId: Id
        patch: Partial<TemplateOption>
      }
  focusOptionId: Id
  focusOffset: number
}

export type BackspaceListTemplateItemAtStartResult = {
  items: ListTemplateItem[]
  operation:
    | { action: 'delete_previous'; previousId: Id }
    | { action: 'merge'; previousId: Id; patch: Partial<ListTemplateItem> }
  focusItemId: Id
  focusOffset: number
}

export function createId(prefix = 'id'): Id {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`
  }

  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
}

/**
 * The calendar day Balance considers "today". Match the widgets by keeping
 * midnight–3am attached to the previous day's plan.
 */
export function todayISO(now = new Date()): string {
  const day = new Date(now)
  if (day.getHours() < DAY_ROLLOVER_HOUR) day.setDate(day.getDate() - 1)
  return calendarDateISO(day)
}

export function calendarDateISO(day = new Date()): string {
  const year = day.getFullYear()
  const month = String(day.getMonth() + 1).padStart(2, '0')
  const date = String(day.getDate()).padStart(2, '0')
  return `${year}-${month}-${date}`
}

export function shiftCalendarDateISO(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(year, month - 1, day)
  shifted.setDate(shifted.getDate() + days)
  return calendarDateISO(shifted)
}

export function nowISO(): string {
  return new Date().toISOString()
}

export function createDefaultTemplate(): DailyTemplate {
  const createdAt = nowISO()

  return {
    id: createId('template'),
    name: 'Default day',
    createdAt,
    updatedAt: createdAt,
    items: [
      createTemplateItem('Wake up'),
      {
        ...createTemplateItem('Move'),
        options: [
          createTemplateOption('Swim', 50),
          createTemplateOption('Lift weights', 50),
        ],
      },
      {
        ...createTemplateItem('Work block'),
        children: [createTemplateItem('Pick the first useful task'), createTemplateItem('Write down next action')],
      },
    ],
  }
}

export function createDailyTemplate(name = 'New day'): DailyTemplate {
  const createdAt = nowISO()

  return {
    id: createId('template'),
    name,
    createdAt,
    updatedAt: createdAt,
    items: [createTemplateItem()],
  }
}

export function createInitialState(): AppState {
  return {
    schemaVersion: 1,
    deviceId: createId('device'),
    localSequence: 0,
    historyRevision: 0,
    activePlanDate: todayISO(),
    preferences: createDefaultReplicatedPreferences(),
    templates: [createDefaultTemplate()],
    plans: [],
    listTemplates: [],
    lists: [],
    metrics: [],
    metricEntries: [],
    notes: [],
    goals: [],
    goalCompletions: [],
    operations: [],
  }
}

export function createNoteItem(text = '', kind: import('./types').NoteItemKind = 'paragraph'): import('./types').NoteItem {
  return {
    ...createPlanItem(text),
    id: createId('note_item'),
    kind,
    children: [],
  }
}

export function formatDefaultNoteTitle(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hour = String(now.getHours() % 12 || 12).padStart(2, '0')
  const minute = String(now.getMinutes()).padStart(2, '0')
  const period = now.getHours() >= 12 ? 'PM' : 'AM'
  return `${year}/${month}/${day} ${hour}:${minute}${period}`
}

export function createNote(title = formatDefaultNoteTitle()): import('./types').Note {
  const createdAt = nowISO()
  return {
    id: createId('note'),
    title,
    items: [createNoteItem()],
    createdAt,
    updatedAt: createdAt,
  }
}

export function createTemplateOption(text = '', probability = 100): TemplateOption {
  return {
    id: createId('option'),
    text,
    html: escapeHTML(text),
    probability,
  }
}

export function createTemplateItem(text = ''): TemplateItem {
  return {
    id: createId('template_item'),
    startMinutes: null,
    endMinutes: null,
    options: [createTemplateOption(text, 100)],
    children: [],
  }
}

export function createPlanItem(text = ''): PlanItem {
  return {
    id: createId('plan_item'),
    text,
    html: escapeHTML(text),
    done: false,
    startMinutes: null,
    endMinutes: null,
    children: [],
  }
}

export type SiriReminderInsertion = {
  items: PlanItem[]
  item: PlanItem
  heading: PlanItem | null
  headingId: Id
  parentId: Id | null
  position: number
  reactivatedItemIds: Id[]
}

export function hasIncompletePlanItems(items: PlanItem[]): boolean {
  return items.some((item) => !item.done || hasIncompletePlanItems(item.children))
}

export function insertSiriReminder(items: PlanItem[], text: string): SiriReminderInsertion {
  const item = createPlanItem(text)
  const existingHeadingPath = findPlanItemPath(items, SIRI_REMINDERS_HEADING)

  if (existingHeadingPath) {
    const reactivatedItemIds: Id[] = []
    const nextItems = appendToExistingSiriHeading(items, existingHeadingPath, item, reactivatedItemIds)
    return {
      items: nextItems,
      item,
      heading: null,
      headingId: existingHeadingPath.at(-1)!,
      parentId: existingHeadingPath.at(-2) ?? null,
      position: -1,
      reactivatedItemIds,
    }
  }

  const heading = {
    ...createPlanItem(SIRI_REMINDERS_HEADING),
    children: [item],
  }
  const insertion = insertBeforeDeepestFirstIncomplete(items, heading)
  return {
    items: insertion.items,
    item,
    heading,
    headingId: heading.id,
    parentId: insertion.parentId,
    position: insertion.position,
    reactivatedItemIds: [],
  }
}

function findPlanItemPath(items: PlanItem[], text: string, ancestors: Id[] = []): Id[] | null {
  for (const item of items) {
    const path = [...ancestors, item.id]
    if (item.text === text) return path
    const childPath = findPlanItemPath(item.children, text, path)
    if (childPath) return childPath
  }
  return null
}

function appendToExistingSiriHeading(
  items: PlanItem[],
  path: Id[],
  item: PlanItem,
  reactivatedItemIds: Id[],
): PlanItem[] {
  const [nextId, ...remainingPath] = path
  return items.map((candidate) => {
    if (candidate.id !== nextId) return candidate

    if (candidate.done) reactivatedItemIds.push(candidate.id)
    if (remainingPath.length === 0) {
      return { ...candidate, done: false, children: [...candidate.children, item] }
    }
    return {
      ...candidate,
      done: false,
      children: appendToExistingSiriHeading(candidate.children, remainingPath, item, reactivatedItemIds),
    }
  })
}

function insertBeforeDeepestFirstIncomplete(
  items: PlanItem[],
  heading: PlanItem,
  parentId: Id | null = null,
): { items: PlanItem[]; parentId: Id | null; position: number } {
  const firstIncompleteIndex = items.findIndex((item) => !item.done)
  if (firstIncompleteIndex < 0) {
    return { items: [...items, heading], parentId, position: items.length }
  }

  const firstIncomplete = items[firstIncompleteIndex]
  if (!firstIncomplete.children.some((child) => !child.done)) {
    return {
      items: [...items.slice(0, firstIncompleteIndex), heading, ...items.slice(firstIncompleteIndex)],
      parentId,
      position: firstIncompleteIndex,
    }
  }

  const childInsertion = insertBeforeDeepestFirstIncomplete(firstIncomplete.children, heading, firstIncomplete.id)
  const nextItems = [...items]
  nextItems[firstIncompleteIndex] = { ...firstIncomplete, children: childInsertion.items }
  return { items: nextItems, parentId: childInsertion.parentId, position: childInsertion.position }
}

export function generatePlanFromTemplate(
  template: DailyTemplate,
  date: string,
  dailyReminder = DEFAULT_DAILY_REMINDER,
  goals: Goal[] = [],
  goalCompletions: GoalCompletion[] = [],
): DailyPlan {
  return {
    id: createId('plan'),
    date,
    title: formatPlanTitle(date),
    dailyReminder,
    generatedFromTemplateId: template.id,
    createdAt: nowISO(),
    items: generatePlanItems(template.items, date, goals, goalCompletions),
  }
}

const N_GOALS_PATTERN = /^(\d+)\s+goals$/i

function generatePlanItems(
  items: TemplateItem[],
  date: string,
  goals: Goal[],
  goalCompletions: GoalCompletion[],
): PlanItem[] {
  return items.flatMap((item) => {
    const option = pickOption(item.options)
    const text = option?.text.trim() ?? ''
    if (!option || text === '' || text.toLowerCase() === '(skip)') {
      return []
    }

    const nGoalsMatch = N_GOALS_PATTERN.exec(text)
    if (nGoalsMatch) {
      return selectGoalsForExpansion(goals, goalCompletions, date, Number(nGoalsMatch[1])).map((goal) => ({
        ...createPlanItem(goal.name),
        startMinutes: item.startMinutes,
        endMinutes: item.endMinutes,
        timeHidden: item.timeHidden,
      }))
    }

    return [
      {
        ...createPlanItem(option.text),
        html: option.html || escapeHTML(option.text),
        startMinutes: item.startMinutes,
        endMinutes: item.endMinutes,
        timeHidden: item.timeHidden,
        children: generatePlanItems(item.children, date, goals, goalCompletions),
      },
    ]
  })
}

/**
 * Selects up to `n` goals to expand an "n goals" template item into, ordered by
 * urgency (fewest days until lapse first). Whole urgency tiers are added greedily;
 * the tier that would overflow `n` is sampled at random to reach exactly `n`.
 */
function selectGoalsForExpansion(
  goals: Goal[],
  goalCompletions: GoalCompletion[],
  date: string,
  n: number,
): Goal[] {
  if (n <= 0) return []

  const eligible = goals.flatMap((goal) => {
    if (goal.cadenceDays === 1) return []
    if (!isGoalActiveOnDate(goal, date)) return []
    if (goal.matchTerms.length === 0) return []

    const daysUntilLapse = goalDaysUntilLapse(goal, goalCompletions, date)
    if (daysUntilLapse === null) return []

    return [{ goal, daysUntilLapse }]
  })

  const tiers = new Map<number, Goal[]>()
  for (const entry of eligible) {
    const tier = tiers.get(entry.daysUntilLapse) ?? []
    tier.push(entry.goal)
    tiers.set(entry.daysUntilLapse, tier)
  }

  const sortedTiers = [...tiers.entries()].sort(([left], [right]) => left - right)
  const selected: Goal[] = []

  for (const [, tierGoals] of sortedTiers) {
    if (selected.length >= n) break

    if (selected.length + tierGoals.length <= n) {
      selected.push(...tierGoals)
      continue
    }

    const needed = n - selected.length
    selected.push(...sampleRandom(tierGoals, needed))
    break
  }

  return selected
}

function sampleRandom<T>(values: T[], count: number): T[] {
  const pool = [...values]
  const picked: T[] = []

  for (let index = 0; index < count && pool.length > 0; index += 1) {
    const choice = Math.floor(Math.random() * pool.length)
    picked.push(pool.splice(choice, 1)[0])
  }

  return picked
}

function pickOption(options: TemplateOption[]): TemplateOption | null {
  if (options.length === 0) return null

  // A lone option below 100% implicitly competes with an empty "skip" of the
  // remaining probability: it appears that often and is simply omitted the rest
  // of the time. (At 100% it always appears, matching the previous behaviour.)
  if (options.length === 1) {
    const probability = Math.max(0, Math.min(100, options[0].probability || 0))
    if (probability >= 100) return options[0]
    return Math.random() * 100 < probability ? options[0] : null
  }

  const total = options.reduce((sum, option) => sum + Math.max(0, option.probability || 0), 0)
  if (total <= 0) return options[0]

  const roll = Math.random() * total
  let cursor = 0

  for (const option of options) {
    cursor += Math.max(0, option.probability || 0)
    if (roll <= cursor) return option
  }

  return options.at(-1) ?? null
}

export function updatePlanItem(items: PlanItem[], itemId: Id, updater: (item: PlanItem) => PlanItem): PlanItem[] {
  let changed = false
  const nextItems = items.map((item) => {
    if (item.id === itemId) {
      const nextItem = updater(item)
      if (nextItem !== item) changed = true
      return nextItem
    }

    const children = updatePlanItem(item.children, itemId, updater)
    if (children === item.children) return item

    changed = true
    return { ...item, children }
  })

  return changed ? nextItems : items
}

export function completePlanItemAncestors(
  items: PlanItem[],
  changedItemIds: Iterable<Id>,
): { items: PlanItem[]; completedParentIds: Id[] } {
  return completePlanItemBranches(items, changedItemIds, false)
}

export function completePlanItemAncestorsAfterRemoval(
  previousItems: PlanItem[],
  items: PlanItem[],
  removedItemIds: Iterable<Id>,
): { items: PlanItem[]; completedParentIds: Id[] } {
  const removedIds = new Set(removedItemIds)
  const affectedParentIds = new Set<Id>()

  function collectAffectedParents(nodes: PlanItem[], ancestors: Id[]): void {
    for (const item of nodes) {
      if (removedIds.has(item.id)) {
        const survivingParentId = ancestors.findLast((ancestorId) => !removedIds.has(ancestorId))
        if (survivingParentId) affectedParentIds.add(survivingParentId)
        continue
      }
      collectAffectedParents(item.children, [...ancestors, item.id])
    }
  }

  collectAffectedParents(previousItems, [])
  return completePlanItemBranches(items, affectedParentIds, true)
}

function completePlanItemBranches(
  items: PlanItem[],
  changedItemIds: Iterable<Id>,
  includeChangedItems: boolean,
): { items: PlanItem[]; completedParentIds: Id[] } {
  const changedIds = new Set(changedItemIds)
  const completedParentIds: Id[] = []

  function completeAncestors(nodes: PlanItem[]): { nodes: PlanItem[]; containsChange: boolean } {
    let changed = false
    let containsChange = false
    const nextNodes = nodes.map((item) => {
      const childResult = completeAncestors(item.children)
      const itemContainsChange = changedIds.has(item.id) || childResult.containsChange
      containsChange ||= itemContainsChange

      let nextItem = childResult.nodes === item.children ? item : { ...item, children: childResult.nodes }
      if (
        (childResult.containsChange || (includeChangedItems && changedIds.has(item.id))) &&
        !nextItem.done &&
        nextItem.children.length > 0 &&
        nextItem.children.every((child) => child.done)
      ) {
        nextItem = { ...nextItem, done: true }
        completedParentIds.push(nextItem.id)
      }

      if (nextItem !== item) changed = true
      return nextItem
    })

    return { nodes: changed ? nextNodes : nodes, containsChange }
  }

  const result = completeAncestors(items)
  return { items: result.nodes, completedParentIds }
}

export function completePlanItemDescendants(
  items: PlanItem[],
  changedItemIds: Iterable<Id>,
): { items: PlanItem[]; completedDescendantIds: Id[] } {
  const changedIds = new Set(changedItemIds)
  const completedDescendantIds: Id[] = []

  function completeDescendants(nodes: PlanItem[], belowChangedItem: boolean): PlanItem[] {
    let changed = false
    const nextNodes = nodes.map((item) => {
      const itemIsChanged = changedIds.has(item.id)
      const children = completeDescendants(item.children, belowChangedItem || itemIsChanged)
      let nextItem = children === item.children ? item : { ...item, children }

      if (belowChangedItem && !itemIsChanged && !nextItem.done) {
        nextItem = { ...nextItem, done: true }
        completedDescendantIds.push(nextItem.id)
      }

      if (nextItem !== item) changed = true
      return nextItem
    })

    return changed ? nextNodes : nodes
  }

  return {
    items: completeDescendants(items, false),
    completedDescendantIds,
  }
}

export function addPlanItem(items: PlanItem[], parentId: Id | null, item = createPlanItem()): PlanItem[] {
  if (!parentId) return [...items, item]

  return updatePlanItem(items, parentId, (parent) => ({
    ...parent,
    children: [...parent.children, item],
  }))
}

export function splitPlanItem(
  items: PlanItem[],
  itemId: Id,
  patch: Partial<Omit<PlanItem, 'id' | 'children'>>,
  newItem: PlanItem,
  placement: 'before' | 'after' | 'firstChild' = 'after',
  moveChildrenToNewItem = false,
): PlanItem[] {
  let changed = false

  const nextItems = items.flatMap((item) => {
    if (item.id === itemId) {
      changed = true
      if (placement === 'firstChild') {
        return [{ ...item, ...patch, children: [newItem, ...item.children] }]
      }

      const patchedItem = { ...item, ...patch, children: moveChildrenToNewItem ? [] : item.children }
      const insertedItem = moveChildrenToNewItem ? { ...newItem, children: item.children } : newItem
      return placement === 'before' ? [insertedItem, patchedItem] : [patchedItem, insertedItem]
    }

    const children = splitPlanItem(item.children, itemId, patch, newItem, placement, moveChildrenToNewItem)
    if (children === item.children) return [item]

    changed = true
    return [{ ...item, children }]
  })

  return changed ? nextItems : items
}

export function deletePlanItem(items: PlanItem[], itemId: Id): PlanItem[] {
  return items
    .filter((item) => item.id !== itemId)
    .map((item) => ({
      ...item,
      children: deletePlanItem(item.children, itemId),
    }))
}

export function deletePlanItemPreservingChildren(items: PlanItem[], itemId: Id): PlanItem[] {
  return deleteTreeNodePreservingChildren(items, itemId)
}

export function backspacePlanItemAtStart(items: PlanItem[], itemId: Id): BackspacePlanItemAtStartResult | null {
  const flattened = flattenPlanItems(items)
  const currentIndex = flattened.findIndex((item) => item.id === itemId)
  if (currentIndex <= 0) return null

  const current = flattened[currentIndex]
  const previous = flattened[currentIndex - 1]

  if (isPlanItemTextEmpty(previous) && previous.children.length === 0) {
    return {
      items: deletePlanItem(items, previous.id),
      operation: { action: 'delete_previous', previousId: previous.id },
      focusItemId: current.id,
      focusOffset: 0,
    }
  }

  const previousHTML = previous.html || escapeHTML(previous.text)
  const currentHTML = current.html || escapeHTML(current.text)
  const patch = {
    text: `${previous.text}${current.text}`,
    html: sanitizeInlineHTML(`${previousHTML}${currentHTML}`),
  }
  const withMergedPrevious = updatePlanItem(items, previous.id, (item) => ({
    ...item,
    ...patch,
    children: [...item.children, ...current.children],
  }))

  return {
    items: deletePlanItem(withMergedPrevious, current.id),
    operation: {
      action: 'merge',
      previousId: previous.id,
      patch,
    },
    focusItemId: previous.id,
    focusOffset: previous.text.length,
  }
}

export function copyPlanItems(items: PlanItem[], itemIds: Id[]): PlanItem[] {
  return copyTreeNodes(items, new Set(itemIds))
}

export function deletePlanItems(items: PlanItem[], itemIds: Id[]): PlanItem[] {
  return deleteTreeNodes(items, new Set(itemIds))
}

export function clonePlanItemsForPaste(items: PlanItem[]): PlanItem[] {
  return items.map(clonePlanItemForPaste)
}

export function pastePlanItems(
  items: PlanItem[],
  itemsToPaste: PlanItem[],
  targetId: Id | null,
  placement: MovePlacement | 'replace',
): PlanItem[] {
  return pasteTreeNodes(items, itemsToPaste, targetId, placement)
}

export function movePlanItem(
  items: PlanItem[],
  sourceId: Id,
  targetId: Id,
  placement: MovePlacement,
): PlanItem[] {
  if (sourceId === targetId || containsPlanItem(findPlanItem(items, sourceId)?.children ?? [], targetId)) {
    return items
  }

  const extracted = extractPlanItem(items, sourceId)
  if (!extracted.item) return items

  const inserted = insertPlanItem(extracted.items, extracted.item, targetId, placement)
  return inserted ?? items
}

export function movePlanItemWithinLevel(items: PlanItem[], itemId: Id, direction: MoveDirection): PlanItem[] {
  const index = items.findIndex((item) => item.id === itemId)

  if (index !== -1) {
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= items.length) return items

    const nextItems = [...items]
    const [item] = nextItems.splice(index, 1)
    nextItems.splice(targetIndex, 0, item)
    return nextItems
  }

  let changed = false
  const nextItems = items.map((item) => {
    const children = movePlanItemWithinLevel(item.children, itemId, direction)
    if (children === item.children) return item
    changed = true
    return { ...item, children }
  })

  return changed ? nextItems : items
}

export function movePlanItemsWithinLevel(items: PlanItem[], itemIds: Id[], direction: MoveDirection): PlanItem[] {
  return moveTreeNodesWithinLevel(items, new Set(itemIds), direction)
}

export function outdentPlanItem(items: PlanItem[], itemId: Id): PlanItem[] {
  return outdentItem(items, itemId)
}

export function indentPlanItems(items: PlanItem[], itemIds: Id[]): PlanItem[] {
  const selectedIds = new Set(itemIds)
  if (selectedIds.size === 0) return items

  return indentSelectedItems(items, selectedIds)
}

export function outdentPlanItems(items: PlanItem[], itemIds: Id[]): PlanItem[] {
  return outdentTreeNodes(items, new Set(itemIds))
}

export function defaultPlanItemTimeRange(items: PlanItem[], itemId: Id): { startMinutes: number; endMinutes: number } {
  return defaultTimeRangeAfterPreviousTimedItem(items, itemId)
}

export function findPlanItem(items: PlanItem[], itemId: Id): PlanItem | null {
  for (const item of items) {
    if (item.id === itemId) return item
    const child = findPlanItem(item.children, itemId)
    if (child) return child
  }

  return null
}

function containsPlanItem(items: PlanItem[], itemId: Id): boolean {
  return Boolean(findPlanItem(items, itemId))
}

function flattenPlanItems(items: PlanItem[]): PlanItem[] {
  return items.flatMap((item) => [item, ...flattenPlanItems(item.children)])
}

function isPlanItemTextEmpty(item: PlanItem): boolean {
  return item.text.trim() === '' && htmlToPlainText(item.html).trim() === ''
}

function clonePlanItemForPaste(item: PlanItem): PlanItem {
  return {
    ...item,
    id: createId('plan_item'),
    children: item.children.map(clonePlanItemForPaste),
  }
}

function moveSelectedItemsAtLevel<T extends { id: Id }>(items: T[], selectedIds: Set<Id>, direction: MoveDirection): T[] {
  if (!items.some((item) => selectedIds.has(item.id))) return items

  const nextItems = [...items]
  let changed = false

  if (direction === 'up') {
    for (let index = 1; index < nextItems.length; index += 1) {
      if (selectedIds.has(nextItems[index].id) && !selectedIds.has(nextItems[index - 1].id)) {
        ;[nextItems[index - 1], nextItems[index]] = [nextItems[index], nextItems[index - 1]]
        changed = true
      }
    }
  } else {
    for (let index = nextItems.length - 2; index >= 0; index -= 1) {
      if (selectedIds.has(nextItems[index].id) && !selectedIds.has(nextItems[index + 1].id)) {
        ;[nextItems[index], nextItems[index + 1]] = [nextItems[index + 1], nextItems[index]]
        changed = true
      }
    }
  }

  return changed ? nextItems : items
}

function extractPlanItem(items: PlanItem[], itemId: Id): { items: PlanItem[]; item: PlanItem | null } {
  let found: PlanItem | null = null

  const nextItems = items.flatMap((item) => {
    if (item.id === itemId) {
      found = item
      return []
    }

    const childResult = extractPlanItem(item.children, itemId)
    if (childResult.item) {
      found = childResult.item
      return [{ ...item, children: childResult.items }]
    }

    return [item]
  })

  return { items: nextItems, item: found }
}

function insertPlanItem(
  items: PlanItem[],
  itemToInsert: PlanItem,
  targetId: Id,
  placement: MovePlacement,
): PlanItem[] | null {
  let inserted = false

  const nextItems = items.flatMap((item) => {
    if (item.id === targetId) {
      inserted = true

      if (placement === 'before') return [itemToInsert, item]
      if (placement === 'after') return [item, itemToInsert]

      return [{ ...item, children: [...item.children, itemToInsert] }]
    }

    const childResult = insertPlanItem(item.children, itemToInsert, targetId, placement)
    if (childResult) {
      inserted = true
      return [{ ...item, children: childResult }]
    }

    return [item]
  })

  return inserted ? nextItems : null
}

export function updateTemplateItem(
  items: TemplateItem[],
  itemId: Id,
  updater: (item: TemplateItem) => TemplateItem,
): TemplateItem[] {
  let changed = false
  const nextItems = items.map((item) => {
    if (item.id === itemId) {
      const nextItem = updater(item)
      if (nextItem !== item) changed = true
      return nextItem
    }

    const children = updateTemplateItem(item.children, itemId, updater)
    if (children === item.children) return item

    changed = true
    return { ...item, children }
  })

  return changed ? nextItems : items
}

export function addTemplateItem(items: TemplateItem[], parentId: Id | null, item = createTemplateItem()): TemplateItem[] {
  if (!parentId) return [...items, item]

  return updateTemplateItem(items, parentId, (parent) => ({
    ...parent,
    children: [...parent.children, item],
  }))
}

export function splitTemplateItem(
  items: TemplateItem[],
  itemId: Id,
  optionId: Id,
  patch: Partial<TemplateOption>,
  newItem: TemplateItem,
  placement: 'before' | 'after' | 'firstChild' = 'after',
): TemplateItem[] {
  let changed = false

  const nextItems = items.flatMap((item) => {
    if (item.id === itemId) {
      let optionChanged = false
      const options = item.options.map((option) => {
        if (option.id !== optionId) return option
        optionChanged = true
        return { ...option, ...patch }
      })

      if (!optionChanged) return [item]

      changed = true
      const patchedItem = { ...item, options }
      return placement === 'before' ? [newItem, patchedItem] : [patchedItem, newItem]
    }

    const children = splitTemplateItem(item.children, itemId, optionId, patch, newItem, placement)
    if (children === item.children) return [item]

    changed = true
    return [{ ...item, children }]
  })

  return changed ? nextItems : items
}

export function deleteTemplateItem(items: TemplateItem[], itemId: Id): TemplateItem[] {
  return items
    .filter((item) => item.id !== itemId)
    .map((item) => ({
      ...item,
      children: deleteTemplateItem(item.children, itemId),
    }))
}

export function backspaceTemplateOptionAtStart(
  items: TemplateItem[],
  itemId: Id,
  optionId: Id,
): BackspaceTemplateOptionAtStartResult | null {
  const flattened = flattenTemplateOptions(items)
  const currentIndex = flattened.findIndex((entry) => entry.item.id === itemId && entry.option.id === optionId)
  if (currentIndex <= 0) return null

  const current = flattened[currentIndex]
  const previous = flattened[currentIndex - 1]

  if (isTemplateOptionTextEmpty(previous.option)) {
    if (previous.item.options.length > 1) {
      return {
        items: updateTemplateItem(items, previous.item.id, (item) => ({
          ...item,
          options: item.options.filter((option) => option.id !== previous.option.id),
        })),
        operation: { action: 'delete_previous_option', previousOptionId: previous.option.id },
        focusOptionId: current.option.id,
        focusOffset: 0,
      }
    }

    if (previous.item.children.length === 0) {
      return {
        items: deleteTemplateItem(items, previous.item.id),
        operation: { action: 'delete_previous_item', previousItemId: previous.item.id },
        focusOptionId: current.option.id,
        focusOffset: 0,
      }
    }
  }

  const previousHTML = previous.option.html || escapeHTML(previous.option.text)
  const currentHTML = current.option.html || escapeHTML(current.option.text)
  const patch = {
    text: `${previous.option.text}${current.option.text}`,
    html: sanitizeInlineHTML(`${previousHTML}${currentHTML}`),
  }
  let nextItems = updateTemplateItem(items, previous.item.id, (item) => ({
    ...item,
    options: item.options.map((option) => (option.id === previous.option.id ? { ...option, ...patch } : option)),
    children: previous.item.id === current.item.id ? item.children : [...item.children, ...current.item.children],
  }))

  if (previous.item.id === current.item.id) {
    nextItems = updateTemplateItem(nextItems, current.item.id, (item) => ({
      ...item,
      options: item.options.filter((option) => option.id !== current.option.id),
    }))
  } else {
    nextItems = deleteTemplateItem(nextItems, current.item.id)
  }

  return {
    items: nextItems,
    operation: {
      action: 'merge',
      previousItemId: previous.item.id,
      previousOptionId: previous.option.id,
      patch,
    },
    focusOptionId: previous.option.id,
    focusOffset: previous.option.text.length,
  }
}

function flattenTemplateOptions(items: TemplateItem[]): Array<{ item: TemplateItem; option: TemplateOption }> {
  return items.flatMap((item) => [
    ...item.options.map((option) => ({ item, option })),
    ...flattenTemplateOptions(item.children),
  ])
}

function isTemplateOptionTextEmpty(option: TemplateOption): boolean {
  return option.text.trim() === '' && htmlToPlainText(option.html).trim() === ''
}

export function copyTemplateItems(items: TemplateItem[], itemIds: Id[]): TemplateItem[] {
  return copyTreeNodes(items, new Set(itemIds))
}

export function deleteTemplateItems(items: TemplateItem[], itemIds: Id[]): TemplateItem[] {
  return deleteTreeNodes(items, new Set(itemIds))
}

export function deleteTemplateItemPreservingChildren(items: TemplateItem[], itemId: Id): TemplateItem[] {
  return deleteTreeNodePreservingChildren(items, itemId)
}

export function cloneTemplateItemsForPaste(items: TemplateItem[]): TemplateItem[] {
  return items.map(cloneTemplateItemForPaste)
}

function cloneTemplateItemForPaste(item: TemplateItem): TemplateItem {
  return {
    ...item,
    id: createId('template_item'),
    options: item.options.map((option) => ({ ...option, id: createId('option') })),
    children: item.children.map(cloneTemplateItemForPaste),
  }
}

export function pasteTemplateItems(
  items: TemplateItem[],
  itemsToPaste: TemplateItem[],
  targetId: Id | null,
  placement: MovePlacement | 'replace',
): TemplateItem[] {
  return pasteTreeNodes(items, itemsToPaste, targetId, placement)
}

export function moveTemplateItemsWithinLevel(items: TemplateItem[], itemIds: Id[], direction: MoveDirection): TemplateItem[] {
  return moveTreeNodesWithinLevel(items, new Set(itemIds), direction)
}

export function indentTemplateItems(items: TemplateItem[], itemIds: Id[]): TemplateItem[] {
  return indentSelectedItems(items, new Set(itemIds))
}

export function outdentTemplateItems(items: TemplateItem[], itemIds: Id[]): TemplateItem[] {
  return outdentTreeNodes(items, new Set(itemIds))
}

export function moveTemplateItem(
  items: TemplateItem[],
  sourceId: Id,
  targetId: Id,
  placement: MovePlacement,
): TemplateItem[] {
  if (sourceId === targetId || containsTemplateItem(findTemplateItem(items, sourceId)?.children ?? [], targetId)) {
    return items
  }

  const extracted = extractTemplateItem(items, sourceId)
  if (!extracted.item) return items

  const inserted = insertTemplateItem(extracted.items, extracted.item, targetId, placement)
  return inserted ?? items
}

export function moveTemplateItemWithinLevel(items: TemplateItem[], itemId: Id, direction: MoveDirection): TemplateItem[] {
  const index = items.findIndex((item) => item.id === itemId)

  if (index !== -1) {
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= items.length) return items

    const nextItems = [...items]
    const [item] = nextItems.splice(index, 1)
    nextItems.splice(targetIndex, 0, item)
    return nextItems
  }

  let changed = false
  const nextItems = items.map((item) => {
    const children = moveTemplateItemWithinLevel(item.children, itemId, direction)
    if (children === item.children) return item
    changed = true
    return { ...item, children }
  })

  return changed ? nextItems : items
}

export function outdentTemplateItem(items: TemplateItem[], itemId: Id): TemplateItem[] {
  return outdentItem(items, itemId)
}

export function defaultTemplateItemTimeRange(items: TemplateItem[], itemId: Id): { startMinutes: number; endMinutes: number } {
  return defaultTimeRangeAfterPreviousTimedItem(items, itemId)
}

function findTemplateItem(items: TemplateItem[], itemId: Id): TemplateItem | null {
  for (const item of items) {
    if (item.id === itemId) return item
    const child = findTemplateItem(item.children, itemId)
    if (child) return child
  }

  return null
}

function containsTemplateItem(items: TemplateItem[], itemId: Id): boolean {
  return Boolean(findTemplateItem(items, itemId))
}

function extractTemplateItem(items: TemplateItem[], itemId: Id): { items: TemplateItem[]; item: TemplateItem | null } {
  let found: TemplateItem | null = null

  const nextItems = items.flatMap((item) => {
    if (item.id === itemId) {
      found = item
      return []
    }

    const childResult = extractTemplateItem(item.children, itemId)
    if (childResult.item) {
      found = childResult.item
      return [{ ...item, children: childResult.items }]
    }

    return [item]
  })

  return { items: nextItems, item: found }
}

function insertTemplateItem(
  items: TemplateItem[],
  itemToInsert: TemplateItem,
  targetId: Id,
  placement: MovePlacement,
): TemplateItem[] | null {
  let inserted = false

  const nextItems = items.flatMap((item) => {
    if (item.id === targetId) {
      inserted = true

      if (placement === 'before') return [itemToInsert, item]
      if (placement === 'after') return [item, itemToInsert]

      return [{ ...item, children: [...item.children, itemToInsert] }]
    }

    const childResult = insertTemplateItem(item.children, itemToInsert, targetId, placement)
    if (childResult) {
      inserted = true
      return [{ ...item, children: childResult }]
    }

    return [item]
  })

  return inserted ? nextItems : null
}

function indentSelectedItems<T extends { id: Id; children: T[] }>(items: T[], selectedIds: Set<Id>): T[] {
  let changed = false

  const recursed = items.map((item) => {
    const children = indentSelectedItems(item.children, selectedIds)
    if (children === item.children) return item

    changed = true
    return { ...item, children }
  })

  const result: T[] = []
  for (const item of recursed) {
    const previous = result[result.length - 1]

    if (selectedIds.has(item.id) && previous && !selectedIds.has(previous.id)) {
      result[result.length - 1] = { ...previous, children: [...previous.children, item] }
      changed = true
    } else {
      result.push(item)
    }
  }

  return changed ? result : items
}

function outdentItem<T extends { id: Id; children: T[] }>(items: T[], itemId: Id): T[] {
  for (let parentIndex = 0; parentIndex < items.length; parentIndex += 1) {
    const parent = items[parentIndex]
    const childIndex = parent.children.findIndex((child) => child.id === itemId)

    if (childIndex !== -1) {
      const beforeChildren = parent.children.slice(0, childIndex)
      const itemToPromote = parent.children[childIndex]
      const followingSiblings = parent.children.slice(childIndex + 1)
      const promoted =
        followingSiblings.length > 0
          ? { ...itemToPromote, children: [...itemToPromote.children, ...followingSiblings] }
          : itemToPromote

      return [
        ...items.slice(0, parentIndex),
        { ...parent, children: beforeChildren },
        promoted,
        ...items.slice(parentIndex + 1),
      ]
    }

    const children = outdentItem(parent.children, itemId)
    if (children !== parent.children) {
      return [
        ...items.slice(0, parentIndex),
        { ...parent, children },
        ...items.slice(parentIndex + 1),
      ]
    }
  }

  return items
}

const DEFAULT_TIME_START_MINUTES = 9 * 60
const DEFAULT_TIME_DURATION_MINUTES = 60

function defaultTimeRangeAfterPreviousTimedItem<T extends {
  id: Id
  startMinutes: number | null
  endMinutes: number | null
  timeHidden?: boolean | null
  children: T[]
}>(items: T[], itemId: Id): { startMinutes: number; endMinutes: number } {
  const previousResult = previousTimedItem(items, itemId)
  const previous = previousResult.found ? previousResult.previous : null
  const startMinutes = previous
    ? previousResult.depth > previous.depth
      ? previous.startMinutes
      : previous.endMinutes
    : DEFAULT_TIME_START_MINUTES
  const endMinutes = Math.min(startMinutes + DEFAULT_TIME_DURATION_MINUTES, MAX_TIMELINE_MINUTES)

  if (endMinutes > startMinutes) return { startMinutes, endMinutes }

  return {
    startMinutes: Math.max(0, MAX_TIMELINE_MINUTES - DEFAULT_TIME_DURATION_MINUTES),
    endMinutes: MAX_TIMELINE_MINUTES,
  }
}

type TimedItemPosition = {
  startMinutes: number
  endMinutes: number
  depth: number
}

function previousTimedItem<T extends {
  id: Id
  startMinutes: number | null
  endMinutes: number | null
  timeHidden?: boolean | null
  children: T[]
}>(
  items: T[],
  itemId: Id,
  previous: TimedItemPosition | null = null,
  depth = 0,
): { found: boolean; previous: TimedItemPosition | null; depth: number } {
  let lastTimedItem = previous

  for (const item of items) {
    if (item.id === itemId) return { found: true, previous: lastTimedItem, depth }

    if (hasActiveTimeRange(item)) {
      lastTimedItem = {
        startMinutes: item.startMinutes,
        endMinutes: item.endMinutes,
        depth,
      }
    }

    const childResult = previousTimedItem(item.children, itemId, lastTimedItem, depth + 1)
    if (childResult.found) return childResult

    lastTimedItem = childResult.previous
  }

  return { found: false, previous: lastTimedItem, depth }
}

export type ItemTimeWarning = {
  overlapsPrevious: boolean
  overlapsNext: boolean
  precedesAncestor: boolean
  exceedsAncestor: boolean
}

type MutableItemTimeWarning = ItemTimeWarning
const itemTimeWarningsCache = new WeakMap<object, ReadonlyMap<Id, ItemTimeWarning>>()

// Build every time warning in one tree walk. Only adjacent timed items at the
// same indentation level are compared, so a nested child doesn't make a later
// top-level item look like a conflict. The latest ancestor start and earliest
// ancestor end carry down through recursion.
export function buildItemTimeWarnings<T extends {
  id: Id
  startMinutes: number | null
  endMinutes: number | null
  timeHidden?: boolean | null
  children: T[]
}>(items: T[]): ReadonlyMap<Id, ItemTimeWarning> {
  const cached = itemTimeWarningsCache.get(items)
  if (cached) return cached

  const warnings = new Map<Id, MutableItemTimeWarning>()

  const warningFor = (itemId: Id): MutableItemTimeWarning => {
    let warning = warnings.get(itemId)
    if (!warning) {
      warning = { overlapsPrevious: false, overlapsNext: false, precedesAncestor: false, exceedsAncestor: false }
      warnings.set(itemId, warning)
    }
    return warning
  }

  const visit = (
    siblings: T[],
    ancestorStartMinutes: number | null,
    ancestorEndMinutes: number | null,
  ) => {
    let previousTimedItem: T | null = null

    for (const item of siblings) {
      const isTimed = hasActiveTimeRange(item)

      if (isTimed) {
        const warning = warningFor(item.id)

        if (previousTimedItem && item.startMinutes! < previousTimedItem.endMinutes!) {
          warning.overlapsPrevious = true
          warningFor(previousTimedItem.id).overlapsNext = true
        }

        if (ancestorStartMinutes !== null && item.startMinutes! < ancestorStartMinutes) {
          warning.precedesAncestor = true
        }

        if (ancestorEndMinutes !== null && item.endMinutes! > ancestorEndMinutes) {
          warning.exceedsAncestor = true
        }

        previousTimedItem = item
      }

      const childAncestorStartMinutes =
        !isTimed
          ? ancestorStartMinutes
          : ancestorStartMinutes === null
            ? item.startMinutes
            : Math.max(ancestorStartMinutes, item.startMinutes)
      const childAncestorEndMinutes =
        !isTimed
          ? ancestorEndMinutes
          : ancestorEndMinutes === null
            ? item.endMinutes
            : Math.min(ancestorEndMinutes, item.endMinutes)
      visit(item.children, childAncestorStartMinutes, childAncestorEndMinutes)
    }
  }

  visit(items, null, null)
  itemTimeWarningsCache.set(items, warnings)
  return warnings
}

export function hasActiveTimeRange(item: {
  startMinutes: number | null
  endMinutes: number | null
  timeHidden?: boolean | null
}): item is { startMinutes: number; endMinutes: number; timeHidden?: boolean | null } {
  return item.timeHidden !== true && item.startMinutes !== null && item.endMinutes !== null
}

export function formatMinutes(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440
  const hours = Math.floor(normalized / 60)
  const mins = normalized % 60
  const suffix = hours >= 12 ? 'pm' : 'am'
  const hour12 = hours % 12 || 12
  return mins === 0 ? `${hour12}${suffix}` : `${hour12}:${String(mins).padStart(2, '0')}${suffix}`
}

export const MAX_TIMELINE_MINUTES = 36 * 60 - 1

export function clampMinutes(minutes: number): number {
  return Math.max(0, Math.min(MAX_TIMELINE_MINUTES, minutes))
}

export function formatPlanTitle(date: string): string {
  const parsed = new Date(`${date}T12:00:00`)
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(parsed)
}

export function escapeHTML(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function sanitizeInlineHTML(value: string): string {
  if (!globalThis.document) return escapeHTML(value)

  const template = document.createElement('template')
  template.innerHTML = value
  const sanitized = Array.from(template.content.childNodes).map(sanitizeNode).join('')
  return stripTrailingLineBreaks(sanitized)
}

// Converts bare web URLs in pasted content to anchors while preserving its
// allowed inline formatting. Existing anchors are left alone.
export function linkifyExternalURLs(value: string): string {
  const sanitized = sanitizeInlineHTML(value)
  if (!globalThis.document) return sanitized

  const template = document.createElement('template')
  template.innerHTML = sanitized
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('a')) continue
    textNodes.push(node as Text)
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent ?? ''
    const matches = Array.from(text.matchAll(/https?:\/\/[^\s<>"']+/gi))
    if (matches.length === 0) continue

    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const match of matches) {
      const start = match.index ?? 0
      let url = match[0]
      let trailing = ''
      while (/[.,!?;:)\]]$/.test(url)) {
        trailing = url.at(-1) + trailing
        url = url.slice(0, -1)
      }
      if (!isURL(url)) continue

      fragment.append(text.slice(cursor, start))
      const anchor = document.createElement('a')
      anchor.setAttribute('href', url)
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noreferrer')
      anchor.textContent = url
      fragment.append(anchor, trailing)
      cursor = start + match[0].length
    }
    if (cursor === 0) continue
    fragment.append(text.slice(cursor))
    textNode.replaceWith(fragment)
  }

  return Array.from(template.content.childNodes).map(sanitizeNode).join('')
}

// Removes line breaks at the rendered end of the content. A flat regex isn't
// enough: when the last formatted line of an item is deleted, WebKit (and
// Chromium) keep the caret placeholder inside the formatting wrapper — e.g.
// `<b><br></b>` — so an item that looks empty would otherwise persist as a
// phantom newline. Descends through trailing inline wrappers, drops the breaks
// (including raw trailing "\n" text pasted from pretty-printed HTML), and
// removes wrappers the pruning left empty.
function stripTrailingLineBreaks(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  if (!pruneTrailingLineBreaks(template.content)) return html
  return Array.from(template.content.childNodes).map(sanitizeNode).join('')
}

function pruneTrailingLineBreaks(parent: ParentNode): boolean {
  let pruned = false

  for (let last = parent.lastChild; last; last = parent.lastChild) {
    if (last.nodeType === Node.TEXT_NODE) {
      const text = last.textContent ?? ''
      const stripped = text.replace(/\n+$/, '')
      if (stripped === '') {
        if (stripped !== text) pruned = true
        last.remove()
        continue
      }
      if (stripped === text) return pruned
      last.textContent = stripped
      return true
    }

    if (last.nodeName === 'BR') {
      last.remove()
      pruned = true
      continue
    }

    if (last.nodeType === Node.ELEMENT_NODE) {
      const childPruned = pruneTrailingLineBreaks(last as unknown as ParentNode)
      if (!last.hasChildNodes()) {
        last.remove()
        pruned = true
        continue
      }
      if (!childPruned) return pruned
      return true
    }

    last.remove()
    pruned = true
  }

  return pruned
}

export function htmlToPlainText(value: string): string {
  if (!globalThis.document) return value.replace(/<[^>]+>/g, '')

  const div = document.createElement('div')
  div.innerHTML = sanitizeInlineHTML(value)
  return div.textContent ?? ''
}

// Like htmlToPlainText, but keeps line breaks: <br> becomes a newline instead of
// being dropped. Used for read-only rendering (e.g. locked list items) where the
// text is shown with white-space: pre-wrap, so the breaks need to survive.
export function htmlToPlainTextWithBreaks(value: string): string {
  const withBreaks = sanitizeInlineHTML(value).replace(/<br>/g, '\n')
  if (!globalThis.document) return withBreaks.replace(/<[^>]+>/g, '')

  const div = document.createElement('div')
  div.innerHTML = withBreaks
  return div.textContent ?? ''
}

export function isURL(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false

  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function noteIdFromURL(value: string): Id | null {
  const match = value.trim().match(/^balance:\/\/note\/([a-zA-Z0-9_-]+)$/)
  return match?.[1] ?? null
}

function sanitizeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeHTML(node.textContent ?? '')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const element = node as HTMLElement
  const children = Array.from(element.childNodes).map(sanitizeNode).join('')
  const tag = element.tagName.toLowerCase()

  if (tag === 'br') return '<br>'
  if (tag === 'b' || tag === 'strong') return `<strong>${children}</strong>`
  if (tag === 'i' || tag === 'em') return `<em>${children}</em>`
  if (tag === 'u') return `<u>${children}</u>`
  if (tag === 'p' || tag === 'div') return children ? `${children}<br>` : ''

  if (tag === 'a') {
    const href = element.getAttribute('href') ?? ''
    if (noteIdFromURL(href)) return `<a href="${escapeHTML(href.trim())}">${children}</a>`
    if (!isURL(href)) return children
    return `<a href="${escapeHTML(href.trim())}" target="_blank" rel="noreferrer">${children}</a>`
  }

  return children
}

// ---------------------------------------------------------------------------
// Generic tree helpers — shared structural operations over any node with an
// `id` and a `children` array. Used by the list-template editor so it doesn't
// re-implement the tree plumbing the plan/template editors already rely on.
// ---------------------------------------------------------------------------

type TreeNode<T> = { id: Id; children: T[] }

function flattenTreeNodes<T extends TreeNode<T>>(items: T[]): T[] {
  return items.flatMap((item) => [item, ...flattenTreeNodes(item.children)])
}

function copyTreeNodes<T extends TreeNode<T>>(items: T[], selectedIds: Set<Id>): T[] {
  if (selectedIds.size === 0) return []

  const copied: T[] = []
  for (const item of items) {
    if (selectedIds.has(item.id)) {
      copied.push(item)
      continue
    }
    copied.push(...copyTreeNodes(item.children, selectedIds))
  }
  return copied
}

function deleteTreeNodes<T extends TreeNode<T>>(items: T[], selectedIds: Set<Id>): T[] {
  if (selectedIds.size === 0) return items

  let changed = false
  const nextItems = items.flatMap((item) => {
    if (selectedIds.has(item.id)) {
      changed = true
      return []
    }
    const children = deleteTreeNodes(item.children, selectedIds)
    if (children === item.children) return [item]
    changed = true
    return [{ ...item, children }]
  })
  return changed ? nextItems : items
}

function deleteTreeNodePreservingChildren<T extends TreeNode<T>>(items: T[], itemId: Id): T[] {
  const index = items.findIndex((item) => item.id === itemId)

  if (index >= 0) {
    const item = items[index]

    // Keep the children's visible indentation whenever the deleted item has a
    // preceding sibling they can belong to. If there is no such sibling, they
    // replace the item at its current level, which is the shallowest valid
    // indentation beneath the item above.
    if (index > 0) {
      const previous = items[index - 1]
      return [
        ...items.slice(0, index - 1),
        { ...previous, children: [...previous.children, ...item.children] },
        ...items.slice(index + 1),
      ]
    }

    return [...item.children, ...items.slice(1)]
  }

  for (let childIndex = 0; childIndex < items.length; childIndex += 1) {
    const item = items[childIndex]
    const children = deleteTreeNodePreservingChildren(item.children, itemId)
    if (children === item.children) continue

    return [
      ...items.slice(0, childIndex),
      { ...item, children },
      ...items.slice(childIndex + 1),
    ]
  }

  return items
}

function pasteTreeNodes<T extends TreeNode<T>>(
  items: T[],
  itemsToPaste: T[],
  targetId: Id | null,
  placement: MovePlacement | 'replace',
): T[] {
  if (itemsToPaste.length === 0) return items
  if (!targetId) return [...items, ...itemsToPaste]

  let inserted = false
  const nextItems = items.flatMap((item) => {
    if (item.id === targetId) {
      inserted = true
      if (placement === 'before') return [...itemsToPaste, item]
      if (placement === 'after') return [item, ...itemsToPaste]
      if (placement === 'replace') return itemsToPaste
      return [{ ...item, children: [...item.children, ...itemsToPaste] }]
    }
    const children = pasteTreeNodes(item.children, itemsToPaste, targetId, placement)
    if (children === item.children) return [item]
    inserted = true
    return [{ ...item, children }]
  })
  return inserted ? nextItems : items
}

function moveTreeNodesWithinLevel<T extends TreeNode<T>>(items: T[], selectedIds: Set<Id>, direction: MoveDirection): T[] {
  if (selectedIds.size === 0) return items
  const movedItems = moveSelectedItemsAtLevel(items, selectedIds, direction)
  let changed = movedItems !== items
  const nextItems = movedItems.map((item) => {
    if (selectedIds.has(item.id)) return item
    const children = moveTreeNodesWithinLevel(item.children, selectedIds, direction)
    if (children === item.children) return item
    changed = true
    return { ...item, children }
  })
  return changed ? nextItems : items
}

function outdentTreeNodes<T extends TreeNode<T>>(items: T[], selectedIds: Set<Id>): T[] {
  const rootIds = copyTreeNodes(items, selectedIds).map((item) => item.id)
  let nextItems = items
  for (let index = rootIds.length - 1; index >= 0; index -= 1) {
    nextItems = outdentItem(nextItems, rootIds[index])
  }
  return nextItems
}

function findTreeNode<T extends TreeNode<T>>(items: T[], itemId: Id): T | null {
  for (const item of items) {
    if (item.id === itemId) return item
    const child = findTreeNode(item.children, itemId)
    if (child) return child
  }
  return null
}

function updateTreeNode<T extends TreeNode<T>>(items: T[], itemId: Id, updater: (item: T) => T): T[] {
  let changed = false
  const nextItems = items.map((item) => {
    if (item.id === itemId) {
      const nextItem = updater(item)
      if (nextItem !== item) changed = true
      return nextItem
    }
    const children = updateTreeNode(item.children, itemId, updater)
    if (children === item.children) return item
    changed = true
    return { ...item, children }
  })
  return changed ? nextItems : items
}

function addTreeNode<T extends TreeNode<T>>(items: T[], parentId: Id | null, item: T): T[] {
  if (!parentId) return [...items, item]
  return updateTreeNode(items, parentId, (parent) => ({ ...parent, children: [...parent.children, item] }))
}

function deleteTreeNode<T extends TreeNode<T>>(items: T[], itemId: Id): T[] {
  return items
    .filter((item) => item.id !== itemId)
    .map((item) => ({ ...item, children: deleteTreeNode(item.children, itemId) }))
}

function extractTreeNode<T extends TreeNode<T>>(items: T[], itemId: Id): { items: T[]; item: T | null } {
  let found: T | null = null
  const nextItems = items.flatMap((item) => {
    if (item.id === itemId) {
      found = item
      return []
    }
    const childResult = extractTreeNode(item.children, itemId)
    if (childResult.item) {
      found = childResult.item
      return [{ ...item, children: childResult.items }]
    }
    return [item]
  })
  return { items: nextItems, item: found }
}

function insertTreeNode<T extends TreeNode<T>>(
  items: T[],
  itemToInsert: T,
  targetId: Id,
  placement: MovePlacement,
): T[] | null {
  let inserted = false
  const nextItems = items.flatMap((item) => {
    if (item.id === targetId) {
      inserted = true
      if (placement === 'before') return [itemToInsert, item]
      if (placement === 'after') return [item, itemToInsert]
      return [{ ...item, children: [...item.children, itemToInsert] }]
    }
    const childResult = insertTreeNode(item.children, itemToInsert, targetId, placement)
    if (childResult) {
      inserted = true
      return [{ ...item, children: childResult }]
    }
    return [item]
  })
  return inserted ? nextItems : null
}

function moveTreeNode<T extends TreeNode<T>>(items: T[], sourceId: Id, targetId: Id, placement: MovePlacement): T[] {
  if (sourceId === targetId || findTreeNode(findTreeNode(items, sourceId)?.children ?? [], targetId)) {
    return items
  }
  const extracted = extractTreeNode(items, sourceId)
  if (!extracted.item) return items
  return insertTreeNode(extracted.items, extracted.item, targetId, placement) ?? items
}

function moveTreeNodeWithinLevel<T extends TreeNode<T>>(items: T[], itemId: Id, direction: MoveDirection): T[] {
  const index = items.findIndex((item) => item.id === itemId)
  if (index !== -1) {
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= items.length) return items
    const nextItems = [...items]
    const [item] = nextItems.splice(index, 1)
    nextItems.splice(targetIndex, 0, item)
    return nextItems
  }
  let changed = false
  const nextItems = items.map((item) => {
    const children = moveTreeNodeWithinLevel(item.children, itemId, direction)
    if (children === item.children) return item
    changed = true
    return { ...item, children }
  })
  return changed ? nextItems : items
}

// ---------------------------------------------------------------------------
// List templates
// ---------------------------------------------------------------------------

export const MIN_LIST_ITEM_PROBABILITY = 10

export function clampListItemProbability(probability: number): number {
  if (!Number.isFinite(probability)) return MIN_LIST_ITEM_PROBABILITY
  return Math.max(MIN_LIST_ITEM_PROBABILITY, Math.min(100, Math.round(probability)))
}

export function createListTemplateItem(text = ''): ListTemplateItem {
  return {
    id: createId('list_item'),
    text,
    html: escapeHTML(text),
    probability: 100,
    children: [],
  }
}

export function createListTemplate(name = 'New list'): ListTemplate {
  const createdAt = nowISO()
  return {
    id: createId('list_template'),
    name,
    maxExpectedWords: 0,
    items: [createListTemplateItem('First item')],
    archivedItems: [],
    createdAt,
    updatedAt: createdAt,
  }
}

export function findListTemplateItem(items: ListTemplateItem[], itemId: Id): ListTemplateItem | null {
  return findTreeNode(items, itemId)
}

export function updateListTemplateItem(
  items: ListTemplateItem[],
  itemId: Id,
  updater: (item: ListTemplateItem) => ListTemplateItem,
): ListTemplateItem[] {
  return updateTreeNode(items, itemId, updater)
}

export function addListTemplateItem(
  items: ListTemplateItem[],
  parentId: Id | null,
  item = createListTemplateItem(),
): ListTemplateItem[] {
  return addTreeNode(items, parentId, item)
}

export function deleteListTemplateItem(items: ListTemplateItem[], itemId: Id): ListTemplateItem[] {
  return deleteTreeNode(items, itemId)
}

export function deleteListTemplateItemPreservingChildren(
  items: ListTemplateItem[],
  itemId: Id,
): ListTemplateItem[] {
  return deleteTreeNodePreservingChildren(items, itemId)
}

export function backspaceListTemplateItemAtStart(
  items: ListTemplateItem[],
  itemId: Id,
): BackspaceListTemplateItemAtStartResult | null {
  const flattened = flattenTreeNodes(items)
  const currentIndex = flattened.findIndex((item) => item.id === itemId)
  if (currentIndex <= 0) return null

  const current = flattened[currentIndex]
  const previous = flattened[currentIndex - 1]

  if (isListTemplateItemTextEmpty(previous) && previous.children.length === 0) {
    return {
      items: deleteListTemplateItem(items, previous.id),
      operation: { action: 'delete_previous', previousId: previous.id },
      focusItemId: current.id,
      focusOffset: 0,
    }
  }

  const previousHTML = previous.html || escapeHTML(previous.text)
  const currentHTML = current.html || escapeHTML(current.text)
  const patch = {
    text: `${previous.text}${current.text}`,
    html: sanitizeInlineHTML(`${previousHTML}${currentHTML}`),
  }
  const withMergedPrevious = updateListTemplateItem(items, previous.id, (item) => ({
    ...item,
    ...patch,
    children: [...item.children, ...current.children],
  }))

  return {
    items: deleteListTemplateItem(withMergedPrevious, current.id),
    operation: { action: 'merge', previousId: previous.id, patch },
    focusItemId: previous.id,
    focusOffset: previous.text.length,
  }
}

function isListTemplateItemTextEmpty(item: ListTemplateItem): boolean {
  return item.text.trim() === '' && htmlToPlainText(item.html).trim() === ''
}

export function copyListTemplateItems(items: ListTemplateItem[], itemIds: Id[]): ListTemplateItem[] {
  return copyTreeNodes(items, new Set(itemIds))
}

export function deleteListTemplateItems(items: ListTemplateItem[], itemIds: Id[]): ListTemplateItem[] {
  return deleteTreeNodes(items, new Set(itemIds))
}

export function cloneListTemplateItemsForPaste(items: ListTemplateItem[]): ListTemplateItem[] {
  const clone = (item: ListTemplateItem): ListTemplateItem => ({
    ...item,
    id: createId('list_item'),
    children: item.children.map(clone),
  })
  return items.map(clone)
}

export function pasteListTemplateItems(
  items: ListTemplateItem[],
  itemsToPaste: ListTemplateItem[],
  targetId: Id | null,
  placement: MovePlacement | 'replace',
): ListTemplateItem[] {
  return pasteTreeNodes(items, itemsToPaste, targetId, placement)
}

export function moveListTemplateItemsWithinLevel(items: ListTemplateItem[], itemIds: Id[], direction: MoveDirection): ListTemplateItem[] {
  return moveTreeNodesWithinLevel(items, new Set(itemIds), direction)
}

export function indentListTemplateItems(items: ListTemplateItem[], itemIds: Id[]): ListTemplateItem[] {
  return indentSelectedItems(items, new Set(itemIds))
}

export function outdentListTemplateItems(items: ListTemplateItem[], itemIds: Id[]): ListTemplateItem[] {
  return outdentTreeNodes(items, new Set(itemIds))
}

export function moveListTemplateItem(
  items: ListTemplateItem[],
  sourceId: Id,
  targetId: Id,
  placement: MovePlacement,
): ListTemplateItem[] {
  return moveTreeNode(items, sourceId, targetId, placement)
}

export function moveListTemplateItemWithinLevel(
  items: ListTemplateItem[],
  itemId: Id,
  direction: MoveDirection,
): ListTemplateItem[] {
  return moveTreeNodeWithinLevel(items, itemId, direction)
}

export function outdentListTemplateItem(items: ListTemplateItem[], itemId: Id): ListTemplateItem[] {
  return outdentItem(items, itemId)
}

// Splits a list-template item's text into two siblings (Enter behaviour),
// mirroring splitPlanItem but for the option-less list item shape.
export function splitListTemplateItem(
  items: ListTemplateItem[],
  itemId: Id,
  patch: Partial<Pick<ListTemplateItem, 'text' | 'html'>>,
  newItem: ListTemplateItem,
  placement: 'before' | 'after' = 'after',
): ListTemplateItem[] {
  let changed = false
  const nextItems = items.flatMap((item) => {
    if (item.id === itemId) {
      changed = true
      const patchedItem = { ...item, ...patch }
      return placement === 'before' ? [newItem, patchedItem] : [patchedItem, newItem]
    }
    const children = splitListTemplateItem(item.children, itemId, patch, newItem, placement)
    if (children === item.children) return [item]
    changed = true
    return [{ ...item, children }]
  })
  return changed ? nextItems : items
}

// ---------------------------------------------------------------------------
// List instances (generated checklists; reuse PlanItem)
// ---------------------------------------------------------------------------

export function generateListFromTemplate(template: ListTemplate, date: string): ListInstance {
  return {
    id: createId('list'),
    date,
    listTemplateId: template.id,
    createdAt: nowISO(),
    items: generateListItems(template.items),
  }
}

function generateListItems(items: ListTemplateItem[]): PlanItem[] {
  return items.flatMap((item) => {
    const appears = Math.random() * 100 < clampListItemProbability(item.probability)
    if (!appears) return []
    return [
      {
        ...createPlanItem(item.text),
        html: item.html || escapeHTML(item.text),
        children: generateListItems(item.children),
      },
    ]
  })
}

// ---------------------------------------------------------------------------
// Word counting (list-template "expected word count" cap)
// ---------------------------------------------------------------------------

export function wordCount(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

// Probability-weighted expected word count of a whole list template. A child
// can only appear when every ancestor appears, so its effective probability is
// the product of its own probability and all ancestor probabilities.
export function expectedWordCount(items: ListTemplateItem[], ancestorProbability = 1): number {
  return items.reduce((sum, item) => {
    const appearanceProbability =
      ancestorProbability * (clampListItemProbability(item.probability) / 100)
    const itemWords = (wordCount(htmlToPlainText(item.html)) || wordCount(item.text)) *
      appearanceProbability
    return sum + itemWords + expectedWordCount(item.children, appearanceProbability)
  }, 0)
}

// Unweighted word count of every item, regardless of appearance probability.
export function totalWordCount(items: ListTemplateItem[]): number {
  return items.reduce((sum, item) => {
    const itemWords = wordCount(htmlToPlainText(item.html)) || wordCount(item.text)
    return sum + itemWords + totalWordCount(item.children)
  }, 0)
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function createMetricQuestion(prompt = '', type: MetricQuestionType = 'text'): MetricQuestion {
  return { id: createId('metric_question'), prompt, html: escapeHTML(prompt), type }
}

export function createMetric(name = 'New metric'): Metric {
  const createdAt = nowISO()
  return {
    id: createId('metric'),
    name,
    questions: [createMetricQuestion('')],
    createdAt,
    updatedAt: createdAt,
  }
}

export function createMetricEntry(metricId: Id, date: string): MetricEntry {
  const createdAt = nowISO()
  return {
    id: createId('metric_entry'),
    metricId,
    date,
    answers: [],
    createdAt,
    updatedAt: createdAt,
  }
}

// ---------------------------------------------------------------------------
// Internal links — a plan/list item whose text contains a list template name
// or a metric name (case-insensitive substring) becomes a clickable opener.
// Matching mirrors the cheap lowercase-substring scan goal completion uses: we
// only ever walk the handful of list templates / metrics, never the full text
// repeatedly, so this stays fast even on long item text.
// ---------------------------------------------------------------------------

export type ItemLink =
  | { kind: 'list'; listTemplateId: Id; label: string }
  | { kind: 'metric'; metricId: Id; label: string }
  | { kind: 'note'; noteId: Id; label: string }

export function resolveItemLinks(text: string, listTemplates: ListTemplate[], metrics: Metric[], notes: import('./types').Note[] = []): ItemLink[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const lower = trimmed.toLowerCase()
  const links: ItemLink[] = []

  for (const template of listTemplates) {
    const name = template.name.trim()
    if (name && lower.includes(name.toLowerCase())) {
      links.push({ kind: 'list', listTemplateId: template.id, label: name })
    }
  }

  for (const metric of metrics) {
    const name = metric.name.trim()
    if (name && lower.includes(name.toLowerCase())) {
      links.push({ kind: 'metric', metricId: metric.id, label: name })
    }
  }

  for (const match of trimmed.matchAll(/balance:\/\/note\/([a-zA-Z0-9_-]+)/g)) {
    const note = notes.find((candidate) => candidate.id === match[1])
    if (note) links.push({ kind: 'note', noteId: note.id, label: note.title.trim() || 'Untitled note' })
  }

  return links
}

// The metric an item links to, if any. List/plan items that reference a metric
// can only be completed by finishing that metric's survey, so callers use this
// to gate direct done-toggles and route clicks to the survey instead.
export function itemMetricLink(
  text: string,
  listTemplates: ListTemplate[],
  metrics: Metric[],
): Extract<ItemLink, { kind: 'metric' }> | null {
  for (const link of resolveItemLinks(text, listTemplates, metrics)) {
    if (link.kind === 'metric') return link
  }
  return null
}

export type ItemTextSegment = { text: string; link: ItemLink | null }

// Splits an item's text into segments, marking each list-name or metric-name
// occurrence (case-insensitive substring) as a link and leaving everything else
// as plain text. Each name is scanned with indexOf over the lowercased text, so
// cost is bounded by the small number of templates/metrics, not the text length.
export function linkifyItemText(text: string, listTemplates: ListTemplate[], metrics: Metric[], notes: import('./types').Note[] = []): ItemTextSegment[] {
  if (text === '') return [{ text, link: null }]

  const haystack = text.toLowerCase()
  const matches: { start: number; end: number; link: ItemLink }[] = []
  const collect = (name: string, link: ItemLink) => {
    const needle = name.toLowerCase()
    let index = haystack.indexOf(needle)
    while (index !== -1) {
      matches.push({ start: index, end: index + name.length, link })
      index = haystack.indexOf(needle, index + name.length)
    }
  }

  for (const template of listTemplates) {
    const name = template.name.trim()
    if (!name) continue
    collect(name, { kind: 'list', listTemplateId: template.id, label: name })
  }
  for (const metric of metrics) {
    const name = metric.name.trim()
    if (!name) continue
    collect(name, { kind: 'metric', metricId: metric.id, label: name })
  }
  for (const match of text.matchAll(/balance:\/\/note\/([a-zA-Z0-9_-]+)/g)) {
    const note = notes.find((candidate) => candidate.id === match[1])
    if (!note || match.index === undefined) continue
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      link: { kind: 'note', noteId: note.id, label: note.title.trim() || 'Untitled note' },
    })
  }

  if (matches.length === 0) return [{ text, link: null }]

  // Earliest start first, longest match wins on ties; skip overlaps.
  matches.sort((a, b) => a.start - b.start || b.end - a.end)
  const segments: ItemTextSegment[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start), link: null })
    segments.push({ text: text.slice(match.start, match.end), link: match.link })
    cursor = match.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), link: null })
  return segments
}

export function internalLinkId(link: ItemLink): string {
  if (link.kind === 'list') return link.listTemplateId
  if (link.kind === 'metric') return link.metricId
  return link.noteId
}

// Renders saved rich text while re-inserting clickable internal-link anchors.
// Links are mapped by plain-text offset into the already-sanitized DOM, so a
// note URL remains clickable even when it sits inside bold/italic/underlined
// text. Both editable and locked rows go through this renderer.
export function renderItemDisplayHTML(sourceHTML: string, sourceText: string, segments: ItemTextSegment[]): string {
  const fallbackHTML = sanitizeInlineHTML(sourceHTML || escapeHTML(sourceText))
  if (!segments.some((segment) => segment.link) || !globalThis.document) return fallbackHTML

  const ranges: { start: number; end: number; link: ItemLink }[] = []
  let segmentOffset = 0
  for (const segment of segments) {
    if (segment.link) ranges.push({ start: segmentOffset, end: segmentOffset + segment.text.length, link: segment.link })
    segmentOffset += segment.text.length
  }

  const template = document.createElement('template')
  template.innerHTML = fallbackHTML
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text)

  let textOffset = 0
  for (const textNode of textNodes) {
    const value = textNode.textContent ?? ''
    const nodeStart = textOffset
    const nodeEnd = nodeStart + value.length
    const overlaps = ranges.filter((range) => range.start < nodeEnd && range.end > nodeStart)
    textOffset = nodeEnd
    if (textNode.parentElement?.closest('a')) continue
    if (overlaps.length === 0) continue

    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const range of overlaps) {
      const start = Math.max(0, range.start - nodeStart)
      const end = Math.min(value.length, range.end - nodeStart)
      if (start > cursor) fragment.append(value.slice(cursor, start))
      const anchor = document.createElement('a')
      anchor.href = '#'
      anchor.dataset.internalLinkKind = range.link.kind
      anchor.dataset.internalLinkId = internalLinkId(range.link)
      anchor.dataset.internalLinkLabel = range.link.label
      anchor.title = `Open ${range.link.label}`
      anchor.textContent = value.slice(start, end)
      fragment.append(anchor)
      cursor = end
    }
    if (cursor < value.length) fragment.append(value.slice(cursor))
    textNode.replaceWith(fragment)
  }

  return template.innerHTML
}

export function itemLinkFromAnchor(anchor: HTMLElement): ItemLink | null {
  const kind = anchor.dataset.internalLinkKind
  const id = anchor.dataset.internalLinkId
  const label = anchor.dataset.internalLinkLabel ?? anchor.textContent ?? ''

  if (kind === 'list' && id) return { kind, listTemplateId: id, label }
  if (kind === 'metric' && id) return { kind, metricId: id, label }
  if (kind === 'note' && id) return { kind, noteId: id, label }
  const noteId = noteIdFromURL(anchor.getAttribute('href') ?? '')
  if (noteId) return { kind: 'note', noteId, label }
  return null
}
