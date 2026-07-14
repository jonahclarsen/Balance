import { invoke, isTauri } from '@tauri-apps/api/core'
import { get, writable, type Writable } from 'svelte/store'
import {
  addPlanItem,
  addTemplateItem,
  createId,
  createInitialState,
  createPlanItem,
  createTemplateItem,
  createTemplateOption,
  DEFAULT_DAILY_REMINDER,
  backspacePlanItemAtStart as backspacePlanItemAtStartInTree,
  deletePlanItem,
  deletePlanItems,
  deleteTemplateItem,
  copyTemplateItems as copyTemplateItemsFromTree,
  deleteTemplateItems,
  cloneTemplateItemsForPaste,
  pasteTemplateItems as pasteTemplateItemsIntoTree,
  moveTemplateItemsWithinLevel as moveTemplateItemsWithinLevelInTree,
  indentTemplateItems as indentTemplateItemsInTree,
  outdentTemplateItems as outdentTemplateItemsInTree,
  escapeHTML,
  formatMinutes,
  generatePlanFromTemplate,
  htmlToPlainText,
  movePlanItem,
  movePlanItemWithinLevel,
  movePlanItemsWithinLevel,
  moveTemplateItem,
  moveTemplateItemWithinLevel,
  nowISO,
  outdentPlanItem as outdentPlanItemInTree,
  indentPlanItems as indentPlanItemsInTree,
  outdentPlanItems as outdentPlanItemsInTree,
  outdentTemplateItem as outdentTemplateItemInTree,
  clonePlanItemsForPaste,
  copyPlanItems as copyPlanItemsFromTree,
  pastePlanItems as pastePlanItemsIntoTree,
  sanitizeInlineHTML,
  splitPlanItem,
  splitTemplateItem,
  todayISO,
  updatePlanItem,
  updateTemplateItem,
  addListTemplateItem,
  updateListTemplateItem,
  deleteListTemplateItem,
  copyListTemplateItems as copyListTemplateItemsFromTree,
  deleteListTemplateItems,
  cloneListTemplateItemsForPaste,
  pasteListTemplateItems as pasteListTemplateItemsIntoTree,
  moveListTemplateItemsWithinLevel as moveListTemplateItemsWithinLevelInTree,
  indentListTemplateItems as indentListTemplateItemsInTree,
  outdentListTemplateItems as outdentListTemplateItemsInTree,
  moveListTemplateItem,
  moveListTemplateItemWithinLevel,
  outdentListTemplateItem as outdentListTemplateItemInTree,
  splitListTemplateItem,
  createListTemplate,
  createListTemplateItem,
  clampListItemProbability,
  generateListFromTemplate,
  createMetric,
  createMetricQuestion,
  createMetricEntry,
} from './planner'
import {
  createGoal,
  goalCompletionsEqual,
  normalizeGoal,
  normalizeGoalCompletion,
  normalizeMatchTerms,
  planItemGoalMatchesChanged,
  reconcileGoalCompletionsForDate,
  reconcileRecentGoalCompletions,
  setGoalActiveOnDate,
  setGoalStartDate,
} from './goals'
import type {
  AppState,
  DailyPlan,
  Goal,
  Id,
  ListInstance,
  ListTemplate,
  ListTemplateItem,
  Metric,
  MetricEntry,
  MetricQuestion,
  MetricQuestionType,
  Operation,
  PlanItem,
  TemplateItem,
  TemplateOption,
} from './types'

const STORAGE_KEY = 'balance.appState.v1'
const TEXT_MERGE_WINDOW_MS = 1200
const MAX_HISTORY_ENTRIES = 200
const PERSIST_DEBOUNCE_MS = 500
type SplitPlacement = 'before' | 'after' | 'firstChild'

type Mutator = (state: AppState) => AppState
type CommitOptions = {
  undoable?: boolean
  mergeKey?: string
  mergeWindowMs?: number
  reconcileGoals?: boolean | ((before: AppState, after: AppState) => boolean)
  forcedGoalRecalculationDates?: string[] | ((before: AppState, after: AppState) => string[])
}
type TextChangeOptions = {
  mergeHistory?: boolean
  mergeKey?: string
  mergeWindowMs?: number
}

type HistoryEntry = {
  before: AppState
  after: AppState
  mergeKey: string | null
  updatedAt: number
}

export type RecoveryKeyStatus = {
  confirmed: boolean
  recoveryKey: string | null
  databasePath: string
}

export type RecoveryEntry = {
  historyId: string
  operationId: string
  operationType: string | null
  sequence: number
  undone: boolean
  createdAtMs: number
  timestamp: string | null
  restoredItemCount: number
  preview: string
  undoJson: string
}

export type DatabaseOperationEntry = {
  id: string
  deviceId: string
  sequence: number
  type: string
  timestamp: string
  payloadJson: string
}

export type DatabaseHistoryEntry = {
  id: string
  operationId: string
  sequence: number
  undone: boolean
  createdAtMs: number
  updatedAtMs: number
  undoJson: string
  redoJson: string
  operationType: string | null
  timestamp: string | null
}

export type DatabaseInspection = {
  operations: DatabaseOperationEntry[]
  historyEntries: DatabaseHistoryEntry[]
  plans: DailyPlan[]
}

let undoStack: HistoryEntry[] = []
let redoStack: HistoryEntry[] = []
let persistenceTarget: 'tauri' | 'localStorage' | null = null
let persistenceReady = false
let pendingOperations = new Map<string, Operation>()
let operationFlushActive = false
let operationFlushPromise: Promise<void> | null = null
let operationFlushTimer: number | null = null
let lastOperationMergeKey: string | null = null
let lastOperationMergeUpdatedAt = 0

export const persistenceError = writable('')

function parseStoredState(raw: string | null): AppState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as AppState
    if (parsed.schemaVersion !== 1) return null
    return normalizeState({
      ...parsed,
      historyRevision: parsed.historyRevision || 0,
      activePlanDate: parsed.activePlanDate || todayISO(),
      operations: parsed.operations || [],
    })
  } catch {
    return null
  }
}

function readLocalState(): AppState {
  return parseStoredState(localStorage.getItem(STORAGE_KEY)) ?? createInitialState()
}

function readInitialState(): AppState {
  return isTauri() ? createInitialState() : readLocalState()
}

async function hydratePersistence(store: Writable<AppState>): Promise<void> {
  try {
    const stored = await invoke<string | null>('read_app_state')
    const parsed = parseStoredState(stored)
    persistenceTarget = 'tauri'

    if (parsed) {
      store.set(parsed)
    } else {
      await invoke('initialize_app_state', { stateJson: JSON.stringify(get(store)) })
    }
  } catch (error) {
    if (isTauri()) {
      console.error('Could not load encrypted Balance app state', error)
    } else {
      persistenceTarget = 'localStorage'
    }
  } finally {
    if (persistenceTarget) {
      persistenceReady = true
      if (persistenceTarget === 'localStorage') {
        pendingOperations.clear()
        persistLocalState(get(store))
      }
      if (persistenceTarget === 'tauri' && pendingOperations.size > 0) scheduleOperationFlush()
    }
  }
}

function persistLocalState(state: AppState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function splitPlacementForBeforeText(before: { html?: string; text?: string }): SplitPlacement {
  return (before.html ?? '') === '' && (before.text ?? '') === '' ? 'before' : 'after'
}

function shouldMoveChildrenToSplitItem(before: { text?: string }, after: { text?: string }): boolean {
  return (before.text ?? '') !== ''
}

function queueOperationPersistence(operation: Operation): void {
  if (persistenceTarget === 'localStorage') return

  pendingOperations.set(operation.id, operation)
  if (!persistenceReady || persistenceTarget !== 'tauri') return

  scheduleOperationFlush()
}

function scheduleOperationFlush(): void {
  if (operationFlushTimer !== null) window.clearTimeout(operationFlushTimer)
  operationFlushTimer = window.setTimeout(() => {
    operationFlushTimer = null
    if (!operationFlushActive) void flushOperations()
  }, PERSIST_DEBOUNCE_MS)
}

async function flushOperations(): Promise<void> {
  if (operationFlushPromise) return operationFlushPromise

  operationFlushPromise = flushOperationsNow().finally(() => {
    operationFlushPromise = null
  })
  return operationFlushPromise
}

async function flushOperationsNow(): Promise<void> {
  operationFlushActive = true

  try {
    while (pendingOperations.size > 0) {
      const operations = [...pendingOperations.values()].sort((a, b) => a.sequence - b.sequence)
      pendingOperations.clear()

      for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index]
        try {
          await invoke('persist_operation', { operationJson: JSON.stringify(operation) })
          persistenceError.set('')
        } catch (error) {
          for (const operationToRetry of operations.slice(index)) {
            pendingOperations.set(operationToRetry.id, operationToRetry)
          }
          throw error
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    persistenceError.set(`Could not persist Balance operation: ${message}`)
    console.error('Could not persist Balance operation', error)
    throw error
  } finally {
    operationFlushActive = false
    if (pendingOperations.size > 0 && operationFlushTimer === null) scheduleOperationFlush()
  }
}

function createPlannerStore() {
  const store = writable<AppState>(readInitialState())
  store.subscribe((state) => {
    if (persistenceReady && persistenceTarget === 'localStorage') persistLocalState(state)
  })
  const ready = hydratePersistence(store)

  function commit(type: string, payload: unknown, mutate: Mutator, options: CommitOptions = {}): void {
    let operationToPersist: Operation | null = null

    store.update((state) => {
      let next = mutate(state)
      if (next === state) return state

      const shouldReconcileGoals =
        typeof options.reconcileGoals === 'function'
          ? options.reconcileGoals(state, next)
          : options.reconcileGoals !== false
      const forcedGoalRecalculationDates =
        typeof options.forcedGoalRecalculationDates === 'function'
          ? options.forcedGoalRecalculationDates(state, next)
          : (options.forcedGoalRecalculationDates ?? [])
      const reconciledGoalCompletions = shouldReconcileGoals
        ? reconcileChangedGoalCompletions(state, next, forcedGoalRecalculationDates)
        : next.goalCompletions
      if (
        reconciledGoalCompletions !== next.goalCompletions &&
        !goalCompletionsEqual(reconciledGoalCompletions, next.goalCompletions)
      ) {
        next = { ...next, goalCompletions: reconciledGoalCompletions }
      }

      const now = Date.now()
      const timestamp = nowISO()
      const lastOperation = state.operations.at(-1)
      const canMergeOperation =
        Boolean(options.mergeKey) &&
        lastOperationMergeKey === options.mergeKey &&
        lastOperation !== undefined &&
        now - lastOperationMergeUpdatedAt <= (options.mergeWindowMs ?? 0)
      const sequence = canMergeOperation ? lastOperation.sequence : state.localSequence + 1
      const goalDataChanged = next.goals !== state.goals || next.goalCompletions !== state.goalCompletions
      const previousGoalData =
        canMergeOperation && lastOperation?.payload !== null && typeof lastOperation?.payload === 'object'
          ? (lastOperation.payload as Record<string, unknown>).goalData
          : undefined
      const goalData = goalDataChanged
        ? {
            goals: next.goals,
            goalCompletions: next.goalCompletions,
          }
        : previousGoalData
      const listsMetricsChanged =
        next.listTemplates !== state.listTemplates ||
        next.lists !== state.lists ||
        next.metrics !== state.metrics ||
        next.metricEntries !== state.metricEntries
      const previousListsMetricsData =
        canMergeOperation && lastOperation?.payload !== null && typeof lastOperation?.payload === 'object'
          ? (lastOperation.payload as Record<string, unknown>).listsMetricsData
          : undefined
      const listsMetricsData = listsMetricsChanged
        ? {
            listTemplates: next.listTemplates,
            lists: next.lists,
            metrics: next.metrics,
            metricEntries: next.metricEntries,
          }
        : previousListsMetricsData
      const operationPayload =
        goalData !== undefined || listsMetricsData !== undefined
          ? {
              ...(payload && typeof payload === 'object' ? payload : { value: payload }),
              ...(goalData !== undefined ? { goalData } : {}),
              ...(listsMetricsData !== undefined ? { listsMetricsData } : {}),
            }
          : payload
      const operation: Operation = canMergeOperation
        ? { ...lastOperation, timestamp, payload: operationPayload }
        : {
            id: `op_${state.deviceId}_${sequence}`,
            deviceId: state.deviceId,
            sequence,
            type,
            timestamp,
            payload: operationPayload,
          }

      const committed = {
        ...next,
        localSequence: sequence,
        operations: canMergeOperation ? [...next.operations.slice(0, -1), operation] : [...next.operations, operation],
      }
      operationToPersist = operation
      lastOperationMergeKey = options.mergeKey ?? null
      lastOperationMergeUpdatedAt = now

      if (!isTauri() && options.undoable !== false) {
        recordHistory(state, committed, options)
      }

      return committed
    })

    if (operationToPersist) queueOperationPersistence(operationToPersist)
  }

  return {
    subscribe: store.subscribe,
    ready,

    setActivePlanDate(date: string) {
      commit('set_active_plan_date', { date }, (state) => ({
        ...state,
        activePlanDate: date,
      }))
    },

    generatePlan(templateId: Id, date: string, replaceExisting: boolean) {
      const current = get(store)
      const template = current.templates.find((candidate) => candidate.id === templateId)
      if (!template) return
      const generated = generatePlanFromTemplate(
        template,
        date,
        dailyReminderForGeneratedPlan(current.plans, date),
        current.goals,
        current.goalCompletions,
      )

      commit('generate_plan', { templateId, date, replaceExisting, generatedPlan: generated }, (state) => {
        const plans = replaceExisting ? state.plans.filter((plan) => plan.date !== date) : state.plans

        return {
          ...state,
          activePlanDate: date,
          plans: [...plans, generated].sort((a, b) => b.date.localeCompare(a.date)),
        }
      })
    },

    patchPlanDailyReminder(planId: Id, dailyReminder: string) {
      commit(
        'patch_plan_daily_reminder',
        { planId, dailyReminder },
        (state) => updatePlan(state, planId, (plan) => applyPatch(plan, { dailyReminder })),
        { mergeKey: `plan-daily-reminder:${planId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS },
      )
    },

    addRootPlanItem(planId: Id) {
      const item = createPlanItem()
      commit('add_plan_item', { planId, parentId: null, item }, (state) => updatePlan(state, planId, (plan) => ({
        ...plan,
        items: addPlanItem(plan.items, null, item),
      })))
    },

    addPlanChild(planId: Id, parentId: Id) {
      const item = createPlanItem()
      commit('add_plan_item', { planId, parentId, item }, (state) => updatePlan(state, planId, (plan) => ({
        ...plan,
        items: addPlanItem(plan.items, parentId, item),
      })))
    },

    patchPlanItem(
      planId: Id,
      itemId: Id,
      patch: Partial<Omit<PlanItem, 'id' | 'children'>>,
      options: TextChangeOptions = {},
    ) {
      const isTextPatch = 'text' in patch || 'html' in patch
      let goalMatchesChanged = false
      const mergeOptions =
        options.mergeKey && options.mergeHistory !== false
          ? { mergeKey: options.mergeKey, mergeWindowMs: options.mergeWindowMs ?? TEXT_MERGE_WINDOW_MS }
          : isTextPatch && options.mergeHistory !== false
            ? { mergeKey: `plan-item-text:${planId}:${itemId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS }
            : {}
      commit('patch_plan_item', { planId, itemId, patch }, (state) => updatePlan(state, planId, (plan) => {
        const items = updatePlanItem(plan.items, itemId, (item) => {
          const nextItem = applyPatch(item, patch)
          goalMatchesChanged = planItemGoalMatchesChanged(state.goals, plan.date, item, nextItem, { force: true })
          return nextItem
        })
        return items === plan.items ? plan : { ...plan, items }
      }), {
        ...mergeOptions,
        reconcileGoals: () => goalMatchesChanged,
        forcedGoalRecalculationDates: (_before, after) => {
          const plan = after.plans.find((candidate) => candidate.id === planId)
          return plan && goalMatchesChanged ? [plan.date] : []
        },
      })
    },

    patchPlanItemsDone(planId: Id, itemIds: Id[], done: boolean) {
      if (itemIds.length === 0) return

      let goalMatchesChanged = false

      commit('patch_plan_items_done', { planId, itemIds, done }, (state) => updatePlan(state, planId, (plan) => {
        let items = plan.items

        for (const itemId of itemIds) {
          items = updatePlanItem(items, itemId, (item) => {
            const nextItem = applyPatch(item, { done })
            if (planItemGoalMatchesChanged(state.goals, plan.date, item, nextItem, { force: true })) {
              goalMatchesChanged = true
            }
            return nextItem
          })
        }

        return items === plan.items ? plan : { ...plan, items }
      }), {
        reconcileGoals: () => goalMatchesChanged,
        forcedGoalRecalculationDates: (_before, after) => {
          const plan = after.plans.find((candidate) => candidate.id === planId)
          return plan && goalMatchesChanged ? [plan.date] : []
        },
      })
    },

    splitPlanItem(
      planId: Id,
      itemId: Id,
      before: Partial<Omit<PlanItem, 'id' | 'children'>>,
      after: { html: string; text: string },
    ) {
      let placement = splitPlacementForBeforeText(before)
      const patch = placement === 'before' ? after : before
      const inserted = placement === 'before' ? before : after
      let moveChildrenToNewItem = shouldMoveChildrenToSplitItem(before, after)

      const newItem = {
        ...createPlanItem(inserted.text ?? ''),
        html: inserted.html ?? '',
      }

      commit('split_plan_item', { planId, itemId, patch, newItem, placement, moveChildrenToNewItem }, (state) => updatePlan(state, planId, (plan) => {
        const items = splitPlanItem(plan.items, itemId, patch, newItem, placement, moveChildrenToNewItem)
        return items === plan.items ? plan : { ...plan, items }
      }))

      return newItem.id
    },

    deletePlanItem(planId: Id, itemId: Id) {
      commit('delete_plan_item', { planId, itemId }, (state) => updatePlan(state, planId, (plan) => ({
        ...plan,
        items: deletePlanItem(plan.items, itemId),
      })))
    },

    backspacePlanItemAtStart(planId: Id, itemId: Id) {
      const plan = get(store).plans.find((candidate) => candidate.id === planId)
      if (!plan) return null

      const result = backspacePlanItemAtStartInTree(plan.items, itemId)
      if (!result) return null

      commit(
        'backspace_plan_item_at_start',
        { planId, itemId, ...result.operation },
        (state) =>
          updatePlan(state, planId, (candidate) =>
            candidate.id === plan.id ? { ...candidate, items: result.items } : candidate,
          ),
      )

      return {
        focusItemId: result.focusItemId,
        focusOffset: result.focusOffset,
      }
    },

    copyPlanItems(planId: Id, itemIds: Id[]) {
      const plan = get(store).plans.find((candidate) => candidate.id === planId)
      return plan ? copyPlanItemsFromTree(plan.items, itemIds) : []
    },

    cutPlanItems(planId: Id, itemIds: Id[]) {
      const plan = get(store).plans.find((candidate) => candidate.id === planId)
      const copiedItems = plan ? copyPlanItemsFromTree(plan.items, itemIds) : []
      if (copiedItems.length === 0) return []

      const selectedRootIds = copiedItems.map((item) => item.id)
      commit('delete_plan_items', { planId, itemIds: selectedRootIds }, (state) => updatePlan(state, planId, (plan) => ({
        ...plan,
        items: deletePlanItems(plan.items, selectedRootIds),
      })))

      return copiedItems
    },

    deletePlanItems(planId: Id, itemIds: Id[]) {
      const plan = get(store).plans.find((candidate) => candidate.id === planId)
      const selectedRootIds = plan ? copyPlanItemsFromTree(plan.items, itemIds).map((item) => item.id) : []
      if (selectedRootIds.length === 0) return []

      commit('delete_plan_items', { planId, itemIds: selectedRootIds }, (state) => updatePlan(state, planId, (plan) => ({
        ...plan,
        items: deletePlanItems(plan.items, selectedRootIds),
      })))

      return selectedRootIds
    },

    pastePlanItems(planId: Id, itemsToPaste: PlanItem[], targetId: Id | null, placement: 'before' | 'after' | 'inside' | 'replace') {
      if (itemsToPaste.length === 0) return []

      const pastedItems = clonePlanItemsForPaste(itemsToPaste)
      commit('paste_plan_items', { planId, targetId, placement, items: pastedItems }, (state) =>
        updatePlan(state, planId, (plan) => {
          const items = pastePlanItemsIntoTree(plan.items, pastedItems, targetId, placement)
          return items === plan.items ? plan : { ...plan, items }
        }),
      )

      return pastedItems.map((item) => item.id)
    },

    movePlanItem(planId: Id, sourceId: Id, targetId: Id, placement: 'before' | 'after' | 'inside') {
      commit('move_plan_item', { planId, sourceId, targetId, placement }, (state) => updatePlan(state, planId, (plan) => ({
        ...plan,
        items: movePlanItem(plan.items, sourceId, targetId, placement),
      })))
    },

    movePlanItemWithinLevel(planId: Id, itemId: Id, direction: 'up' | 'down') {
      commit('move_plan_item_within_level', { planId, itemId, direction }, (state) => updatePlan(state, planId, (plan) => ({
        ...plan,
        items: movePlanItemWithinLevel(plan.items, itemId, direction),
      })))
    },

    movePlanItemsWithinLevel(planId: Id, itemIds: Id[], direction: 'up' | 'down') {
      if (itemIds.length === 0) return

      commit('move_plan_items_within_level', { planId, itemIds, direction }, (state) =>
        updatePlan(state, planId, (plan) => {
          const items = movePlanItemsWithinLevel(plan.items, itemIds, direction)
          return items === plan.items ? plan : { ...plan, items }
        }),
      )
    },

    outdentPlanItem(planId: Id, itemId: Id) {
      commit('outdent_plan_item', { planId, itemId }, (state) => updatePlan(state, planId, (plan) => {
        const items = outdentPlanItemInTree(plan.items, itemId)
        return items === plan.items ? plan : { ...plan, items }
      }))
    },

    indentPlanItems(planId: Id, itemIds: Id[]) {
      if (itemIds.length === 0) return

      commit('indent_plan_items', { planId, itemIds }, (state) =>
        updatePlan(state, planId, (plan) => {
          const items = indentPlanItemsInTree(plan.items, itemIds)
          return items === plan.items ? plan : { ...plan, items }
        }),
      )
    },

    outdentPlanItems(planId: Id, itemIds: Id[]) {
      if (itemIds.length === 0) return

      commit('outdent_plan_items', { planId, itemIds }, (state) =>
        updatePlan(state, planId, (plan) => {
          const items = outdentPlanItemsInTree(plan.items, itemIds)
          return items === plan.items ? plan : { ...plan, items }
        }),
      )
    },

    addGoal(name: string, cadenceDays: number, matchTerms: string[], hue: number, lightness = 50) {
      const goal = createGoal(name, cadenceDays, matchTerms, hue, lightness, todayISO(), createId('goal'))
      commit('replace_goal_data', { action: 'add_goal', goalId: goal.id }, (state) => ({
        ...state,
        goals: [...state.goals, goal],
      }))
      return goal.id
    },

    patchGoal(goalId: Id, patch: Partial<Pick<Goal, 'name' | 'cadenceDays' | 'matchTerms' | 'hue' | 'lightness'>>) {
      commit(
        'replace_goal_data',
        { action: 'patch_goal', goalId, patch },
        (state) => {
          let changed = false
          const goals = state.goals.map((goal) => {
            if (goal.id !== goalId) return goal

            const next = normalizeGoal({
              ...goal,
              ...patch,
              matchTerms: patch.matchTerms ? normalizeMatchTerms(patch.matchTerms) : goal.matchTerms,
              updatedAt: nowISO(),
            })
            if (JSON.stringify(next) !== JSON.stringify(goal)) changed = true
            return next
          })

          return changed ? { ...state, goals } : state
        },
        { mergeKey: `goal:${goalId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS },
      )
    },

    setGoalStartDate(goalId: Id, date: string) {
      commit('replace_goal_data', { action: 'set_goal_start_date', goalId, date }, (state) => {
        let changed = false
        const goals = state.goals.map((goal) => {
          if (goal.id !== goalId) return goal
          const next = setGoalStartDate(goal, date)
          if (next !== goal) changed = true
          return next
        })
        return changed ? { ...state, goals } : state
      })
    },

    setGoalActive(goalId: Id, active: boolean, date = todayISO()) {
      commit('replace_goal_data', { action: 'set_goal_active', goalId, active, date }, (state) => {
        let changed = false
        const goals = state.goals.map((goal) => {
          if (goal.id !== goalId) return goal
          const next = setGoalActiveOnDate(goal, active, date)
          if (next !== goal) changed = true
          return next
        })
        return changed ? { ...state, goals } : state
      })
    },

    deleteGoal(goalId: Id) {
      commit('replace_goal_data', { action: 'delete_goal', goalId }, (state) => ({
        ...state,
        goals: state.goals.filter((goal) => goal.id !== goalId),
        goalCompletions: state.goalCompletions.filter((completion) => completion.goalId !== goalId),
      }))
    },

    renameTemplate(templateId: Id, name: string) {
      commit('rename_template', { templateId, name }, (state) => ({
        ...state,
        templates: state.templates.map((template) =>
          template.id === templateId ? { ...template, name, updatedAt: nowISO() } : template,
        ),
      }))
    },

    addRootTemplateItem(templateId: Id) {
      const item = createTemplateItem()
      commit('add_template_item', { templateId, parentId: null, item }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: addTemplateItem(template.items, null, item),
        })),
      )
    },

    addTemplateChild(templateId: Id, parentId: Id) {
      const item = createTemplateItem()
      commit('add_template_item', { templateId, parentId, item }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: addTemplateItem(template.items, parentId, item),
        })),
      )
    },

    patchTemplateItem(templateId: Id, itemId: Id, patch: Partial<TemplateItem>, options: TextChangeOptions = {}) {
      const mergeOptions =
        options.mergeKey && options.mergeHistory !== false
          ? { mergeKey: options.mergeKey, mergeWindowMs: options.mergeWindowMs ?? TEXT_MERGE_WINDOW_MS }
          : {}
      commit('patch_template_item', { templateId, itemId, patch }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: updateTemplateItem(template.items, itemId, (item) => ({ ...item, ...patch })),
        })),
        mergeOptions,
      )
    },

    splitTemplateItem(
      templateId: Id,
      itemId: Id,
      optionId: Id,
      before: Partial<TemplateOption>,
      after: { html: string; text: string },
    ) {
      const placement = splitPlacementForBeforeText(before)
      const patch = placement === 'before' ? after : before
      const inserted = placement === 'before' ? before : after
      const newItem = {
        ...createTemplateItem(inserted.text ?? ''),
        options: [
          {
            ...createTemplateOption(inserted.text ?? '', 100),
            html: inserted.html ?? '',
          },
        ],
      }

      commit('split_template_item', { templateId, itemId, optionId, patch, newItem, placement }, (state) =>
        updateTemplate(state, templateId, (template) => {
          const items = splitTemplateItem(template.items, itemId, optionId, patch, newItem, placement)
          return items === template.items ? template : { ...template, updatedAt: nowISO(), items }
        }),
      )

      return newItem.options[0].id
    },

    deleteTemplateItem(templateId: Id, itemId: Id) {
      commit('delete_template_item', { templateId, itemId }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: deleteTemplateItem(template.items, itemId),
        })),
      )
    },

    copyTemplateItems(templateId: Id, itemIds: Id[]) {
      const template = get(store).templates.find((candidate) => candidate.id === templateId)
      return template ? copyTemplateItemsFromTree(template.items, itemIds) : []
    },

    cutTemplateItems(templateId: Id, itemIds: Id[]) {
      const template = get(store).templates.find((candidate) => candidate.id === templateId)
      const copiedItems = template ? copyTemplateItemsFromTree(template.items, itemIds) : []
      if (copiedItems.length === 0) return []

      const rootIds = copiedItems.map((item) => item.id)
      commit('delete_template_items', { templateId, itemIds: rootIds }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: deleteTemplateItems(template.items, rootIds),
        })),
      )
      return copiedItems
    },

    deleteTemplateItems(templateId: Id, itemIds: Id[]) {
      const template = get(store).templates.find((candidate) => candidate.id === templateId)
      const rootIds = template ? copyTemplateItemsFromTree(template.items, itemIds).map((item) => item.id) : []
      if (rootIds.length === 0) return []

      commit('delete_template_items', { templateId, itemIds: rootIds }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: deleteTemplateItems(template.items, rootIds),
        })),
      )
      return rootIds
    },

    pasteTemplateItems(templateId: Id, itemsToPaste: TemplateItem[], targetId: Id | null, placement: 'after' | 'replace') {
      if (itemsToPaste.length === 0) return []
      const pastedItems = cloneTemplateItemsForPaste(itemsToPaste)
      commit('paste_template_items', { templateId, targetId, placement, items: pastedItems }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: pasteTemplateItemsIntoTree(template.items, pastedItems, targetId, placement),
        })),
      )
      return pastedItems.map((item) => item.id)
    },

    moveTemplateItemsWithinLevel(templateId: Id, itemIds: Id[], direction: 'up' | 'down') {
      commit('move_template_items_within_level', { templateId, itemIds, direction }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: moveTemplateItemsWithinLevelInTree(template.items, itemIds, direction),
        })),
      )
    },

    indentTemplateItems(templateId: Id, itemIds: Id[]) {
      commit('indent_template_items', { templateId, itemIds }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: indentTemplateItemsInTree(template.items, itemIds),
        })),
      )
    },

    outdentTemplateItems(templateId: Id, itemIds: Id[]) {
      commit('outdent_template_items', { templateId, itemIds }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: outdentTemplateItemsInTree(template.items, itemIds),
        })),
      )
    },

    moveTemplateItem(templateId: Id, sourceId: Id, targetId: Id, placement: 'before' | 'after' | 'inside') {
      commit('move_template_item', { templateId, sourceId, targetId, placement }, (state) =>
        updateTemplate(state, templateId, (template) => {
          const items = moveTemplateItem(template.items, sourceId, targetId, placement)
          return items === template.items ? template : { ...template, updatedAt: nowISO(), items }
        }),
      )
    },

    moveTemplateItemWithinLevel(templateId: Id, itemId: Id, direction: 'up' | 'down') {
      commit('move_template_item_within_level', { templateId, itemId, direction }, (state) =>
        updateTemplate(state, templateId, (template) => {
          const items = moveTemplateItemWithinLevel(template.items, itemId, direction)
          return items === template.items ? template : { ...template, updatedAt: nowISO(), items }
        }),
      )
    },

    outdentTemplateItem(templateId: Id, itemId: Id) {
      commit('outdent_template_item', { templateId, itemId }, (state) =>
        updateTemplate(state, templateId, (template) => {
          const items = outdentTemplateItemInTree(template.items, itemId)
          return items === template.items ? template : { ...template, updatedAt: nowISO(), items }
        }),
      )
    },

    addTemplateOption(templateId: Id, itemId: Id) {
      const option = createTemplateOption('', 0)
      commit('add_template_option', { templateId, itemId, option }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: updateTemplateItem(template.items, itemId, (item) => ({
            ...item,
            options: [...item.options, option],
          })),
        })),
      )
    },

    patchTemplateOption(
      templateId: Id,
      itemId: Id,
      optionId: Id,
      patch: Partial<TemplateOption>,
      options: TextChangeOptions = {},
    ) {
      const isTextPatch = 'text' in patch || 'html' in patch
      commit('patch_template_option', { templateId, itemId, optionId, patch }, (state) =>
        updateTemplate(state, templateId, (template) => {
          const items = updateTemplateItem(template.items, itemId, (item) => {
            let changed = false
            const options = item.options.map((option) => {
              if (option.id !== optionId) return option
              const nextOption = applyPatch(option, patch)
              if (nextOption !== option) changed = true
              return nextOption
            })

            return changed ? { ...item, options } : item
          })

          return items === template.items ? template : { ...template, updatedAt: nowISO(), items }
        }),
        isTextPatch && options.mergeHistory !== false
          ? { mergeKey: `template-option-text:${templateId}:${itemId}:${optionId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS }
          : {},
      )
    },

    deleteTemplateOption(templateId: Id, itemId: Id, optionId: Id) {
      commit('delete_template_option', { templateId, itemId, optionId }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: updateTemplateItem(template.items, itemId, (item) => {
            if (item.options.length <= 1) return item
            return {
              ...item,
              options: item.options.filter((option) => option.id !== optionId),
            }
          }),
        })),
      )
    },

    // ---- List templates ----

    addListTemplate() {
      const template = createListTemplate()
      commit('add_list_template', { templateId: template.id }, (state) => ({
        ...state,
        listTemplates: [...state.listTemplates, template],
      }))
      return template.id
    },

    deleteListTemplate(templateId: Id) {
      commit('delete_list_template', { templateId }, (state) => ({
        ...state,
        listTemplates: state.listTemplates.filter((template) => template.id !== templateId),
        lists: state.lists.filter((list) => list.listTemplateId !== templateId),
      }))
    },

    moveListTemplate(sourceId: Id, targetId: Id, placement: 'before' | 'after') {
      if (sourceId === targetId) return

      commit('move_list_template', { sourceId, targetId, placement }, (state) => {
        const sourceIndex = state.listTemplates.findIndex((template) => template.id === sourceId)
        const targetIndex = state.listTemplates.findIndex((template) => template.id === targetId)
        if (sourceIndex === -1 || targetIndex === -1) return state

        const listTemplates = [...state.listTemplates]
        const [source] = listTemplates.splice(sourceIndex, 1)
        const remainingTargetIndex = listTemplates.findIndex((template) => template.id === targetId)
        const insertionIndex = remainingTargetIndex + (placement === 'after' ? 1 : 0)
        listTemplates.splice(insertionIndex, 0, source)

        if (listTemplates.every((template, index) => template === state.listTemplates[index])) return state
        return { ...state, listTemplates }
      })
    },

    renameListTemplate(templateId: Id, name: string) {
      commit(
        'rename_list_template',
        { templateId, name },
        (state) => updateListTemplate(state, templateId, (template) => ({ ...template, name, updatedAt: nowISO() })),
        { mergeKey: `list-template-name:${templateId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS },
      )
    },

    setListTemplateMaxWords(templateId: Id, maxExpectedWords: number) {
      const normalized = Math.max(0, Math.round(maxExpectedWords) || 0)
      commit('set_list_template_max_words', { templateId, maxExpectedWords: normalized }, (state) =>
        updateListTemplate(state, templateId, (template) =>
          template.maxExpectedWords === normalized
            ? template
            : { ...template, maxExpectedWords: normalized, updatedAt: nowISO() },
        ),
      )
    },

    addRootListTemplateItem(templateId: Id) {
      const item = createListTemplateItem()
      commit('add_list_template_item', { templateId, parentId: null, item }, (state) =>
        updateListTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: addListTemplateItem(template.items, null, item),
        })),
      )
    },

    addListTemplateChild(templateId: Id, parentId: Id) {
      const item = createListTemplateItem()
      commit('add_list_template_item', { templateId, parentId, item }, (state) =>
        updateListTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: addListTemplateItem(template.items, parentId, item),
        })),
      )
    },

    patchListTemplateItem(templateId: Id, itemId: Id, patch: Partial<ListTemplateItem>, options: TextChangeOptions = {}) {
      const normalizedPatch =
        patch.probability !== undefined
          ? { ...patch, probability: clampListItemProbability(patch.probability) }
          : patch
      const isTextPatch = 'text' in patch || 'html' in patch
      const mergeOptions =
        options.mergeKey && options.mergeHistory !== false
          ? { mergeKey: options.mergeKey, mergeWindowMs: options.mergeWindowMs ?? TEXT_MERGE_WINDOW_MS }
          : isTextPatch && options.mergeHistory !== false
            ? { mergeKey: `list-template-item-text:${templateId}:${itemId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS }
            : {}
      commit('patch_list_template_item', { templateId, itemId, patch: normalizedPatch }, (state) =>
        updateListTemplate(state, templateId, (template) => {
          const items = updateListTemplateItem(template.items, itemId, (item) => applyPatch(item, normalizedPatch))
          return items === template.items ? template : { ...template, updatedAt: nowISO(), items }
        }),
        mergeOptions,
      )
    },

    splitListTemplateItem(
      templateId: Id,
      itemId: Id,
      before: Partial<Pick<ListTemplateItem, 'text' | 'html'>>,
      after: { html: string; text: string },
    ) {
      const placement: 'before' | 'after' = splitPlacementForBeforeText(before) === 'before' ? 'before' : 'after'
      const patch = placement === 'before' ? after : before
      const inserted = placement === 'before' ? before : after
      const newItem = { ...createListTemplateItem(inserted.text ?? ''), html: inserted.html ?? '' }

      commit('split_list_template_item', { templateId, itemId, patch, newItem, placement }, (state) =>
        updateListTemplate(state, templateId, (template) => {
          const items = splitListTemplateItem(template.items, itemId, patch, newItem, placement)
          return items === template.items ? template : { ...template, updatedAt: nowISO(), items }
        }),
      )

      return newItem.id
    },

    deleteListTemplateItem(templateId: Id, itemId: Id) {
      commit('delete_list_template_item', { templateId, itemId }, (state) =>
        updateListTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: deleteListTemplateItem(template.items, itemId),
        })),
      )
    },

    copyListTemplateItems(templateId: Id, itemIds: Id[]) {
      const template = get(store).listTemplates.find((candidate) => candidate.id === templateId)
      return template ? copyListTemplateItemsFromTree(template.items, itemIds) : []
    },

    cutListTemplateItems(templateId: Id, itemIds: Id[]) {
      const template = get(store).listTemplates.find((candidate) => candidate.id === templateId)
      const copiedItems = template ? copyListTemplateItemsFromTree(template.items, itemIds) : []
      if (copiedItems.length === 0) return []

      const rootIds = copiedItems.map((item) => item.id)
      commit('delete_list_template_items', { templateId, itemIds: rootIds }, (state) =>
        updateListTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: deleteListTemplateItems(template.items, rootIds),
        })),
      )
      return copiedItems
    },

    deleteListTemplateItems(templateId: Id, itemIds: Id[]) {
      const template = get(store).listTemplates.find((candidate) => candidate.id === templateId)
      const rootIds = template ? copyListTemplateItemsFromTree(template.items, itemIds).map((item) => item.id) : []
      if (rootIds.length === 0) return []

      commit('delete_list_template_items', { templateId, itemIds: rootIds }, (state) =>
        updateListTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: deleteListTemplateItems(template.items, rootIds),
        })),
      )
      return rootIds
    },

    pasteListTemplateItems(templateId: Id, itemsToPaste: ListTemplateItem[], targetId: Id | null, placement: 'after' | 'replace') {
      if (itemsToPaste.length === 0) return []
      const pastedItems = cloneListTemplateItemsForPaste(itemsToPaste)
      commit('paste_list_template_items', { templateId, targetId, placement, items: pastedItems }, (state) =>
        updateListTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: pasteListTemplateItemsIntoTree(template.items, pastedItems, targetId, placement),
        })),
      )
      return pastedItems.map((item) => item.id)
    },

    moveListTemplateItemsWithinLevel(templateId: Id, itemIds: Id[], direction: 'up' | 'down') {
      commit('move_list_template_items_within_level', { templateId, itemIds, direction }, (state) =>
        updateListTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: moveListTemplateItemsWithinLevelInTree(template.items, itemIds, direction),
        })),
      )
    },

    indentListTemplateItems(templateId: Id, itemIds: Id[]) {
      commit('indent_list_template_items', { templateId, itemIds }, (state) =>
        updateListTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: indentListTemplateItemsInTree(template.items, itemIds),
        })),
      )
    },

    outdentListTemplateItems(templateId: Id, itemIds: Id[]) {
      commit('outdent_list_template_items', { templateId, itemIds }, (state) =>
        updateListTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: outdentListTemplateItemsInTree(template.items, itemIds),
        })),
      )
    },

    moveListTemplateItem(templateId: Id, sourceId: Id, targetId: Id, placement: 'before' | 'after' | 'inside') {
      commit('move_list_template_item', { templateId, sourceId, targetId, placement }, (state) =>
        updateListTemplate(state, templateId, (template) => {
          const items = moveListTemplateItem(template.items, sourceId, targetId, placement)
          return items === template.items ? template : { ...template, updatedAt: nowISO(), items }
        }),
      )
    },

    moveListTemplateItemWithinLevel(templateId: Id, itemId: Id, direction: 'up' | 'down') {
      commit('move_list_template_item_within_level', { templateId, itemId, direction }, (state) =>
        updateListTemplate(state, templateId, (template) => {
          const items = moveListTemplateItemWithinLevel(template.items, itemId, direction)
          return items === template.items ? template : { ...template, updatedAt: nowISO(), items }
        }),
      )
    },

    outdentListTemplateItem(templateId: Id, itemId: Id) {
      commit('outdent_list_template_item', { templateId, itemId }, (state) =>
        updateListTemplate(state, templateId, (template) => {
          const items = outdentListTemplateItemInTree(template.items, itemId)
          return items === template.items ? template : { ...template, updatedAt: nowISO(), items }
        }),
      )
    },

    // ---- List instances (reuse PlanItem tree functions) ----

    ensureListForDate(listTemplateId: Id, date: string): Id | null {
      const current = get(store)
      const existing = current.lists.find((list) => list.listTemplateId === listTemplateId && list.date === date)
      if (existing) return existing.id

      const template = current.listTemplates.find((candidate) => candidate.id === listTemplateId)
      if (!template) return null

      const generated = generateListFromTemplate(template, date)
      commit('generate_list', { listTemplateId, date, generated }, (state) => {
        if (state.lists.some((list) => list.listTemplateId === listTemplateId && list.date === date)) return state
        return { ...state, lists: [...state.lists, generated] }
      })

      return generated.id
    },

    addRootListItem(listId: Id) {
      const item = createPlanItem()
      commit('add_list_item', { listId, parentId: null, item }, (state) =>
        updateList(state, listId, (list) => ({ ...list, items: addPlanItem(list.items, null, item) })),
      )
    },

    addListChild(listId: Id, parentId: Id) {
      const item = createPlanItem()
      commit('add_list_item', { listId, parentId, item }, (state) =>
        updateList(state, listId, (list) => ({ ...list, items: addPlanItem(list.items, parentId, item) })),
      )
    },

    patchListItem(listId: Id, itemId: Id, patch: Partial<Omit<PlanItem, 'id' | 'children'>>, options: TextChangeOptions = {}) {
      const isTextPatch = 'text' in patch || 'html' in patch
      const mergeOptions =
        options.mergeKey && options.mergeHistory !== false
          ? { mergeKey: options.mergeKey, mergeWindowMs: options.mergeWindowMs ?? TEXT_MERGE_WINDOW_MS }
          : isTextPatch && options.mergeHistory !== false
            ? { mergeKey: `list-item-text:${listId}:${itemId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS }
            : {}
      commit('patch_list_item', { listId, itemId, patch }, (state) =>
        updateList(state, listId, (list) => {
          const items = updatePlanItem(list.items, itemId, (item) => applyPatch(item, patch))
          return items === list.items ? list : { ...list, items }
        }),
        mergeOptions,
      )
    },

    splitListItem(
      listId: Id,
      itemId: Id,
      before: Partial<Omit<PlanItem, 'id' | 'children'>>,
      after: { html: string; text: string },
    ) {
      let placement = splitPlacementForBeforeText(before)
      const patch = placement === 'before' ? after : before
      const inserted = placement === 'before' ? before : after
      let moveChildrenToNewItem = shouldMoveChildrenToSplitItem(before, after)

      const newItem = { ...createPlanItem(inserted.text ?? ''), html: inserted.html ?? '' }

      commit('split_list_item', { listId, itemId, patch, newItem, placement, moveChildrenToNewItem }, (state) =>
        updateList(state, listId, (list) => {
          const items = splitPlanItem(list.items, itemId, patch, newItem, placement, moveChildrenToNewItem)
          return items === list.items ? list : { ...list, items }
        }),
      )

      return newItem.id
    },

    deleteListItem(listId: Id, itemId: Id) {
      commit('delete_list_item', { listId, itemId }, (state) =>
        updateList(state, listId, (list) => ({ ...list, items: deletePlanItem(list.items, itemId) })),
      )
    },

    backspaceListItemAtStart(listId: Id, itemId: Id) {
      const list = get(store).lists.find((candidate) => candidate.id === listId)
      if (!list) return null

      const result = backspacePlanItemAtStartInTree(list.items, itemId)
      if (!result) return null

      commit('backspace_list_item_at_start', { listId, itemId, ...result.operation }, (state) =>
        updateList(state, listId, (candidate) =>
          candidate.id === list.id ? { ...candidate, items: result.items } : candidate,
        ),
      )

      return { focusItemId: result.focusItemId, focusOffset: result.focusOffset }
    },

    moveListItem(listId: Id, sourceId: Id, targetId: Id, placement: 'before' | 'after' | 'inside') {
      commit('move_list_item', { listId, sourceId, targetId, placement }, (state) =>
        updateList(state, listId, (list) => ({ ...list, items: movePlanItem(list.items, sourceId, targetId, placement) })),
      )
    },

    moveListItemWithinLevel(listId: Id, itemId: Id, direction: 'up' | 'down') {
      commit('move_list_item_within_level', { listId, itemId, direction }, (state) =>
        updateList(state, listId, (list) => ({ ...list, items: movePlanItemWithinLevel(list.items, itemId, direction) })),
      )
    },

    outdentListItem(listId: Id, itemId: Id) {
      commit('outdent_list_item', { listId, itemId }, (state) =>
        updateList(state, listId, (list) => {
          const items = outdentPlanItemInTree(list.items, itemId)
          return items === list.items ? list : { ...list, items }
        }),
      )
    },

    // ---- Metrics ----

    addMetric() {
      const metric = createMetric()
      commit('add_metric', { metricId: metric.id }, (state) => ({ ...state, metrics: [...state.metrics, metric] }))
      return metric.id
    },

    deleteMetric(metricId: Id) {
      commit('delete_metric', { metricId }, (state) => ({
        ...state,
        metrics: state.metrics.filter((metric) => metric.id !== metricId),
        metricEntries: state.metricEntries.filter((entry) => entry.metricId !== metricId),
      }))
    },

    renameMetric(metricId: Id, name: string) {
      commit(
        'rename_metric',
        { metricId, name },
        (state) => updateMetric(state, metricId, (metric) => ({ ...metric, name, updatedAt: nowISO() })),
        { mergeKey: `metric-name:${metricId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS },
      )
    },

    addMetricQuestion(metricId: Id) {
      const question = createMetricQuestion('')
      commit('add_metric_question', { metricId, question }, (state) =>
        updateMetric(state, metricId, (metric) => ({
          ...metric,
          updatedAt: nowISO(),
          questions: [...metric.questions, question],
        })),
      )
      return question.id
    },

    patchMetricQuestion(metricId: Id, questionId: Id, patch: Partial<Pick<MetricQuestion, 'prompt' | 'html' | 'type'>>) {
      const isTextPatch = 'prompt' in patch
      commit(
        'patch_metric_question',
        { metricId, questionId, patch },
        (state) =>
          updateMetric(state, metricId, (metric) => {
            let changed = false
            const questions = metric.questions.map((question) => {
              if (question.id !== questionId) return question
              const next = applyPatch(question, patch)
              if (next !== question) changed = true
              return next
            })
            return changed ? { ...metric, updatedAt: nowISO(), questions } : metric
          }),
        isTextPatch ? { mergeKey: `metric-question-text:${metricId}:${questionId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS } : {},
      )
    },

    deleteMetricQuestion(metricId: Id, questionId: Id) {
      commit('delete_metric_question', { metricId, questionId }, (state) =>
        updateMetric(state, metricId, (metric) => ({
          ...metric,
          updatedAt: nowISO(),
          questions: metric.questions.filter((question) => question.id !== questionId),
        })),
      )
    },

    moveMetricQuestion(metricId: Id, questionId: Id, direction: 'up' | 'down') {
      commit('move_metric_question', { metricId, questionId, direction }, (state) =>
        updateMetric(state, metricId, (metric) => {
          const index = metric.questions.findIndex((question) => question.id === questionId)
          if (index === -1) return metric
          const targetIndex = direction === 'up' ? index - 1 : index + 1
          if (targetIndex < 0 || targetIndex >= metric.questions.length) return metric
          const questions = [...metric.questions]
          ;[questions[index], questions[targetIndex]] = [questions[targetIndex], questions[index]]
          return { ...metric, updatedAt: nowISO(), questions }
        }),
      )
    },

    upsertMetricAnswer(metricId: Id, date: string, questionId: Id, value: string) {
      commit(
        'upsert_metric_answer',
        { metricId, date, questionId, value },
        (state) => {
          const existing = state.metricEntries.find((entry) => entry.metricId === metricId && entry.date === date)
          if (!existing) {
            const entry = { ...createMetricEntry(metricId, date), answers: [{ questionId, value }] }
            return { ...state, metricEntries: [...state.metricEntries, entry] }
          }
          const answers = existing.answers.some((answer) => answer.questionId === questionId)
            ? existing.answers.map((answer) => (answer.questionId === questionId ? { questionId, value } : answer))
            : [...existing.answers, { questionId, value }]
          const nextEntry = { ...existing, answers, updatedAt: nowISO() }
          return { ...state, metricEntries: state.metricEntries.map((entry) => (entry === existing ? nextEntry : entry)) }
        },
        { mergeKey: `metric-answer:${metricId}:${date}:${questionId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS },
      )
    },

    bulkImportMetricEntries(metricId: Id, rows: { date: string; answers: { questionId: Id; value: string }[] }[]) {
      if (rows.length === 0) return
      commit('bulk_import_metric_entries', { metricId, count: rows.length }, (state) => {
        let metricEntries = state.metricEntries
        for (const row of rows) {
          const existing = metricEntries.find((entry) => entry.metricId === metricId && entry.date === row.date)
          if (existing) {
            const merged = new Map(existing.answers.map((answer) => [answer.questionId, answer.value]))
            for (const answer of row.answers) merged.set(answer.questionId, answer.value)
            const nextEntry = {
              ...existing,
              answers: [...merged].map(([questionId, value]) => ({ questionId, value })),
              updatedAt: nowISO(),
            }
            metricEntries = metricEntries.map((entry) => (entry === existing ? nextEntry : entry))
          } else {
            const entry = { ...createMetricEntry(metricId, row.date), answers: row.answers.map((answer) => ({ ...answer })) }
            metricEntries = [...metricEntries, entry]
          }
        }
        return metricEntries === state.metricEntries ? state : { ...state, metricEntries }
      })
    },

    async undo() {
      if (isTauri()) {
        await flushOperations()
        const stateJson = await invoke<string | null>('undo_last_operation')
        const parsed = parseStoredState(stateJson)
        if (parsed) {
          lastOperationMergeKey = null
          store.update((current) => ({ ...parsed, historyRevision: current.historyRevision + 1 }))
        }
        return
      }

      let operationToPersist: Operation | null = null

      store.update((state) => {
        const entry = undoStack.pop()
        if (!entry) return state

        redoStack.push(entry)
        lastOperationMergeKey = null
        const next = applyHistorySnapshot(state, entry.before, 'history_undo', entry)
        operationToPersist = next.operations.at(-1) ?? null
        return next
      })

      if (operationToPersist) queueOperationPersistence(operationToPersist)
    },

    async redo() {
      if (isTauri()) {
        await flushOperations()
        const stateJson = await invoke<string | null>('redo_last_operation')
        const parsed = parseStoredState(stateJson)
        if (parsed) {
          lastOperationMergeKey = null
          store.update((current) => ({ ...parsed, historyRevision: current.historyRevision + 1 }))
        }
        return
      }

      let operationToPersist: Operation | null = null

      store.update((state) => {
        const entry = redoStack.pop()
        if (!entry) return state

        undoStack.push(entry)
        lastOperationMergeKey = null
        const next = applyHistorySnapshot(state, entry.after, 'history_redo', entry)
        operationToPersist = next.operations.at(-1) ?? null
        return next
      })

      if (operationToPersist) queueOperationPersistence(operationToPersist)
    },

    async restoreRecoveryEntry(historyId: string): Promise<boolean> {
      if (!isTauri()) return false

      await flushOperations()
      const stateJson = await invoke<string | null>('restore_recovery_entry', { historyId })
      const parsed = parseStoredState(stateJson)
      if (!parsed) return false

      lastOperationMergeKey = null
      store.update((current) => ({ ...parsed, historyRevision: current.historyRevision + 1 }))
      return true
    },

    async reloadFromBackend(): Promise<void> {
      if (!isTauri()) return

      await flushOperations()
      const stored = await invoke<string | null>('read_app_state')
      const parsed = parseStoredState(stored)
      if (!parsed) return

      lastOperationMergeKey = null
      store.update((current) => ({ ...parsed, historyRevision: current.historyRevision + 1 }))
    },
  }
}

function applyPatch<T extends object>(target: T, patch: Partial<Record<keyof T, unknown>>): T {
  const changed = (Object.entries(patch) as Array<[keyof T, unknown]>).some(([key, value]) => target[key] !== value)
  return changed ? ({ ...target, ...patch } as T) : target
}

function applyHistorySnapshot(current: AppState, snapshot: AppState, type: string, entry: HistoryEntry): AppState {
  const sequence = current.localSequence + 1

  return {
    ...snapshot,
    deviceId: current.deviceId,
    localSequence: sequence,
    operations: [
      ...current.operations,
      {
        id: `op_${current.deviceId}_${sequence}`,
        deviceId: current.deviceId,
        sequence,
        type,
        timestamp: nowISO(),
        payload: {
          mergeKey: entry.mergeKey,
          state: snapshot,
        },
      },
    ],
    historyRevision: current.historyRevision + 1,
  }
}

function recordHistory(before: AppState, after: AppState, options: CommitOptions): void {
  const now = Date.now()
  const mergeKey = options.mergeKey ?? null
  const mergeWindowMs = options.mergeWindowMs ?? 0
  const last = undoStack.at(-1)

  if (last && mergeKey && last.mergeKey === mergeKey && now - last.updatedAt <= mergeWindowMs) {
    last.after = after
    last.updatedAt = now
  } else {
    undoStack.push({ before, after, mergeKey, updatedAt: now })
    if (undoStack.length > MAX_HISTORY_ENTRIES) undoStack = undoStack.slice(-MAX_HISTORY_ENTRIES)
  }

  redoStack = []
}

function updatePlan(state: AppState, planId: Id, updater: (plan: DailyPlan) => DailyPlan): AppState {
  let changed = false
  const plans = state.plans.map((plan) => {
    if (plan.id !== planId) return plan
    const nextPlan = updater(plan)
    if (nextPlan !== plan) changed = true
    return nextPlan
  })

  return changed ? { ...state, plans } : state
}

function reconcileChangedGoalCompletions(previous: AppState, next: AppState, forcedDates: string[] = []) {
  if (next.goals !== previous.goals) return reconcileRecentGoalCompletions(next)
  if (next.plans === previous.plans) return next.goalCompletions

  const forcedDateSet = new Set(forcedDates)
  const previousPlansByDate = new Map(previous.plans.map((plan) => [plan.date, plan]))
  const nextPlansByDate = new Map(next.plans.map((plan) => [plan.date, plan]))
  const changedDates = new Set([...previousPlansByDate.keys(), ...nextPlansByDate.keys()])
  let goalCompletions = next.goalCompletions

  for (const date of changedDates) {
    if (previousPlansByDate.get(date) === nextPlansByDate.get(date)) continue
    goalCompletions = reconcileGoalCompletionsForDate(
      { ...next, goalCompletions },
      date,
      { force: forcedDateSet.has(date) },
    )
  }

  return goalCompletions
}

function updateTemplate(state: AppState, templateId: Id, updater: (template: AppState['templates'][number]) => AppState['templates'][number]): AppState {
  let changed = false
  const templates = state.templates.map((template) => {
    if (template.id !== templateId) return template
    const nextTemplate = updater(template)
    if (nextTemplate !== template) changed = true
    return nextTemplate
  })

  return changed ? { ...state, templates } : state
}

function updateListTemplate(state: AppState, templateId: Id, updater: (template: ListTemplate) => ListTemplate): AppState {
  let changed = false
  const listTemplates = state.listTemplates.map((template) => {
    if (template.id !== templateId) return template
    const nextTemplate = updater(template)
    if (nextTemplate !== template) changed = true
    return nextTemplate
  })

  return changed ? { ...state, listTemplates } : state
}

function updateList(state: AppState, listId: Id, updater: (list: ListInstance) => ListInstance): AppState {
  let changed = false
  const lists = state.lists.map((list) => {
    if (list.id !== listId) return list
    const nextList = updater(list)
    if (nextList !== list) changed = true
    return nextList
  })

  return changed ? { ...state, lists } : state
}

function updateMetric(state: AppState, metricId: Id, updater: (metric: Metric) => Metric): AppState {
  let changed = false
  const metrics = state.metrics.map((metric) => {
    if (metric.id !== metricId) return metric
    const nextMetric = updater(metric)
    if (nextMetric !== metric) changed = true
    return nextMetric
  })

  return changed ? { ...state, metrics } : state
}

function dailyReminderForGeneratedPlan(plans: DailyPlan[], date: string): string {
  const existingPlan = plans.find((plan) => plan.date === date)
  if (existingPlan) return existingPlan.dailyReminder

  const priorPlan = plans
    .filter((plan) => plan.date < date)
    .sort((a, b) => b.date.localeCompare(a.date))[0]

  return priorPlan?.dailyReminder ?? DEFAULT_DAILY_REMINDER
}

export function exportJSON(state: AppState): string {
  return JSON.stringify(
    {
      exportedAt: nowISO(),
      app: 'Balance',
      formatVersion: 1,
      state,
    },
    null,
    2,
  )
}

export function exportHTML(state: AppState): string {
  const plans = [...state.plans].sort((a, b) => a.date.localeCompare(b.date))
  const renderedPlans = plans
    .map(
      (plan) => `
        <section class="plan">
          <h2>${escapeHTML(plan.title)} <span>${escapeHTML(plan.date)}</span></h2>
          ${renderItems(plan.items)}
        </section>
      `,
    )
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Balance Export</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #222; }
    h1 { margin-bottom: 24px; }
    h2 { border-bottom: 1px solid #ddd; padding-bottom: 8px; }
    h2 span { color: #777; font-size: 0.75em; font-weight: 400; }
    .plan { margin-bottom: 32px; }
    ul { list-style: none; padding-left: 20px; }
    li { margin: 6px 0; }
    .time { color: #555; font-variant-numeric: tabular-nums; margin-right: 8px; }
    .done { color: #777; text-decoration: line-through; }
  </style>
</head>
<body>
  <h1>Balance Export</h1>
  ${renderedPlans}
</body>
</html>`
}

function renderItems(items: PlanItem[]): string {
  if (items.length === 0) return '<p>No items.</p>'

  return `<ul>${items
    .map((item) => {
      const time =
        item.startMinutes !== null && item.endMinutes !== null
          ? `<span class="time">${formatMinutes(item.startMinutes)}-${formatMinutes(item.endMinutes)}</span>`
          : ''
      const html = item.html ? sanitizeInlineHTML(item.html) : escapeHTML(item.text)
      const text = `<span class="${item.done ? 'done' : ''}">${item.done ? '[x]' : '[ ]'} ${time}${html}</span>`
      return `<li>${text}${item.children.length > 0 ? renderItems(item.children) : ''}</li>`
    })
    .join('')}</ul>`
}

export const plannerStore = createPlannerStore()

export async function getRecoveryKeyStatus(): Promise<RecoveryKeyStatus | null> {
  if (!isTauri()) return null
  return invoke<RecoveryKeyStatus>('get_recovery_key_status')
}

export async function confirmRecoveryKey(): Promise<void> {
  if (!isTauri()) return
  await invoke('confirm_recovery_key')
}

export async function listRecoveryEntries(): Promise<RecoveryEntry[]> {
  if (!isTauri()) return []
  const raw = await invoke<string>('list_recovery_entries')
  const parsed = JSON.parse(raw) as { entries: RecoveryEntry[] }
  return parsed.entries ?? []
}

// --- Multi-device sync (cr-sqlite engine; see src-tauri/src/sync) -----------

export type SyncSettings = {
  enabled: boolean
  pairingCode: string | null
  relayUrl: string
}

/** Device-local sync configuration from encrypted, non-replicated DB metadata. */
export async function getSyncSettings(): Promise<SyncSettings> {
  if (!isTauri()) return { enabled: false, pairingCode: null, relayUrl: '' }
  return invoke<SyncSettings>('get_sync_settings')
}

/** Persist this device's relay endpoint outside origin-scoped webview storage. */
export async function setSyncRelayUrl(relayUrl: string): Promise<SyncSettings> {
  if (!isTauri()) return { enabled: false, pairingCode: null, relayUrl: relayUrl.trim() }
  return invoke<SyncSettings>('set_sync_relay_url', { relayUrl })
}

/** One-time upgrade path from the old dev/prod-specific localStorage values. */
export async function migrateLegacySyncSettings(
  pairingCode: string | null,
  relayUrl: string | null,
): Promise<SyncSettings> {
  if (!isTauri()) return { enabled: false, pairingCode, relayUrl: relayUrl ?? '' }
  return invoke<SyncSettings>('migrate_legacy_sync_settings', { pairingCode, relayUrl })
}

/** Generate a fresh account sync key and return its QR/pairing code. */
export async function syncNewPairingCode(): Promise<string> {
  if (!isTauri()) return ''
  return invoke<string>('sync_new_pairing_code')
}

/** Enable sync as the primary device — keep this device's data as the baseline. */
export async function syncEnablePrimary(pairingCode: string): Promise<void> {
  if (!isTauri()) return
  await invoke('sync_enable_primary', { pairingCode })
}

/** Enable sync as a joining device — adopt the primary's data (local is backed up). */
export async function syncEnableJoiner(pairingCode: string): Promise<void> {
  if (!isTauri()) return
  await invoke('sync_enable_joiner', { pairingCode })
}

export type SyncPeer = { name: string; address: string }

/** Start the P2P listener + mDNS discovery; returns this device's LAN address. */
export async function syncP2pServe(): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>('sync_p2p_serve')
}

/** Balance devices discovered on the local network. */
export async function syncP2pPeers(): Promise<SyncPeer[]> {
  if (!isTauri()) return []
  return invoke<SyncPeer[]>('sync_p2p_peers')
}

/** Sync directly with a peer at `address` (host:port). Returns new state JSON. */
export async function syncP2pSync(address: string): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>('sync_p2p_sync', { address })
}

/** Pull local changes since `since`, sealed with the device's stored E2EE key. */
export async function syncPullSealed(since: number): Promise<Uint8Array> {
  if (!isTauri()) return new Uint8Array()
  const bytes = await invoke<number[]>('sync_pull_sealed', { since })
  return Uint8Array.from(bytes)
}

/** Apply a peer's sealed changeset. Returns the new app-state JSON (or null). */
export async function syncApplySealed(envelope: Uint8Array): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>('sync_apply_sealed', { envelope: Array.from(envelope) })
}

export type MetadataEntry = {
  key: string
  value: string
}

export async function listMetadata(): Promise<MetadataEntry[]> {
  if (!isTauri()) return []
  const raw = await invoke<string>('list_metadata')
  const parsed = JSON.parse(raw) as { entries: MetadataEntry[] }
  return parsed.entries ?? []
}

export async function inspectDatabase(): Promise<DatabaseInspection | null> {
  if (!isTauri()) return null
  const raw = await invoke<string>('inspect_database')
  const parsed = JSON.parse(raw) as DatabaseInspection
  return {
    operations: parsed.operations ?? [],
    historyEntries: parsed.historyEntries ?? [],
    plans: normalizeState({
      schemaVersion: 1,
      deviceId: '',
      localSequence: 0,
      historyRevision: 0,
      activePlanDate: '',
      templates: [],
      plans: parsed.plans ?? [],
      listTemplates: [],
      lists: [],
      metrics: [],
      metricEntries: [],
      goals: [],
      goalCompletions: [],
      operations: [],
    }).plans,
  }
}

function normalizeState(state: AppState): AppState {
  return {
    ...state,
    goals: (state.goals ?? []).map(normalizeGoal),
    goalCompletions: (state.goalCompletions ?? []).map(normalizeGoalCompletion),
    templates: state.templates.map((template) => ({
      ...template,
      items: normalizeTemplateItems(template.items),
    })),
    plans: state.plans.map((plan) => ({
      ...plan,
      dailyReminder: plan.dailyReminder ?? DEFAULT_DAILY_REMINDER,
      items: normalizePlanItems(plan.items),
    })),
    listTemplates: (state.listTemplates ?? []).map((template) => ({
      ...template,
      maxExpectedWords: template.maxExpectedWords ?? 0,
      items: normalizeListTemplateItems(template.items ?? []),
    })),
    lists: (state.lists ?? []).map((list) => ({
      ...list,
      items: normalizePlanItems(list.items ?? []),
    })),
    metrics: (state.metrics ?? []).map((metric) => ({
      ...metric,
      questions: (metric.questions ?? []).map((question) => ({
        ...question,
        html: sanitizeInlineHTML(question.html ?? escapeHTML(question.prompt ?? '')),
        type: question.type === 'boolean' ? 'boolean' : 'text',
      })),
    })),
    metricEntries: (state.metricEntries ?? []).map((entry) => ({
      ...entry,
      answers: (entry.answers ?? []).map((answer) => ({ ...answer })),
    })),
  }
}

function normalizeListTemplateItems(items: ListTemplateItem[]): ListTemplateItem[] {
  return items.map((item) => {
    const html = sanitizeInlineHTML(item.html ?? escapeHTML(item.text ?? ''))
    return {
      ...item,
      text: item.text ?? htmlToPlainText(html),
      html,
      probability: clampListItemProbability(item.probability ?? 100),
      children: normalizeListTemplateItems(item.children ?? []),
    }
  })
}

function normalizePlanItems(items: PlanItem[]): PlanItem[] {
  return items.map((item) => {
    const html = sanitizeInlineHTML(item.html ?? escapeHTML(item.text ?? ''))

    return {
      ...item,
      text: item.text ?? htmlToPlainText(html),
      html,
      startMinutes: item.startMinutes ?? null,
      endMinutes: item.endMinutes ?? null,
      children: normalizePlanItems(item.children ?? []),
    }
  })
}

function normalizeTemplateItems(items: TemplateItem[]): TemplateItem[] {
  return items.map((item) => ({
    ...item,
    startMinutes: item.startMinutes ?? null,
    endMinutes: item.endMinutes ?? null,
    options: item.options.map((option) => {
      const html = sanitizeInlineHTML(option.html ?? escapeHTML(option.text ?? ''))

      return {
        ...option,
        text: option.text ?? htmlToPlainText(html),
        html,
      }
    }),
    children: normalizeTemplateItems(item.children ?? []),
  }))
}
