import { invoke, isTauri } from '@tauri-apps/api/core'
import { get, writable, type Writable } from 'svelte/store'
import {
  addPlanItem,
  addTemplateItem,
  createId,
  createInitialState,
  createDailyTemplate,
  createPlanItem,
  createTemplateItem,
  createTemplateOption,
  DEFAULT_DAILY_REMINDER,
  backspacePlanItemAtStart as backspacePlanItemAtStartInTree,
  backspaceTemplateOptionAtStart as backspaceTemplateOptionAtStartInTree,
  calendarDateISO,
  deletePlanItem,
  deletePlanItemPreservingChildren,
  deletePlanItems,
  deleteTemplateItem,
  deleteTemplateItemPreservingChildren,
  copyTemplateItems as copyTemplateItemsFromTree,
  deleteTemplateItems,
  cloneTemplateItemsForPaste,
  pasteTemplateItems as pasteTemplateItemsIntoTree,
  moveTemplateItemsWithinLevel as moveTemplateItemsWithinLevelInTree,
  indentTemplateItems as indentTemplateItemsInTree,
  outdentTemplateItems as outdentTemplateItemsInTree,
  escapeHTML,
  findPlanItem,
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
  completePlanItemAncestors,
  completePlanItemDescendants,
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
  deleteListTemplateItemPreservingChildren,
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
  backspaceListTemplateItemAtStart as backspaceListTemplateItemAtStartInTree,
  createListTemplate,
  createListTemplateItem,
  clampListItemProbability,
  generateListFromTemplate,
  createMetric,
  createMetricQuestion,
  createMetricEntry,
  createNote,
  createNoteItem,
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
  ArchivedListTemplateItem,
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
  Note,
  NoteItem,
  NoteItemKind,
  Operation,
  MoveDirection,
  MovePlacement,
  PlanItem,
  ReplicatedPreferences,
  TemplateItem,
  TemplateOption,
} from './types'
import { normalizeReplicatedPreferences } from './preferences'
import { isNoteTrashExpired } from './noteTrash'

const STORAGE_KEY = 'balance.appState.v1'
const TEXT_MERGE_WINDOW_MS = 1200
const MAX_HISTORY_ENTRIES = 200
const PERSIST_DEBOUNCE_MS = 500
const ENTITY_COLLECTIONS = [
  'goals',
  'goalCompletions',
  'listTemplates',
  'lists',
  'metrics',
  'metricEntries',
  'notes',
] as const
type EntityCollection = (typeof ENTITY_COLLECTIONS)[number]
type EntityUpsert = { collection: EntityCollection; key: string; position: number; value: unknown }
type EntityDelete = { collection: EntityCollection; key: string }
type EntityChanges = { version: 1; upserts: EntityUpsert[]; deletes: EntityDelete[] }
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
  operationId: string
  before: AppState
  after: AppState
  mergeKey: string | null
  updatedAt: number
}

type BackendHistoryResult = {
  operationId: string
  localSequence: number
  state: AppState | null
}

export type RecoveryKeyStatus = {
  confirmed: boolean
  recoveryKey: string | null
  databasePath: string
}

export type RecoveryKeyRotationResult = {
  recoveryKeyStatus: RecoveryKeyStatus
  archivedKeyAccount: string
}

export type DatabaseLoadProgress = {
  percent: number
  stage: string
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

export type RecoverySearchMatch = {
  historyId: string
  operationType: string | null
  createdAtMs: number
  timestamp: string | null
  preview: string
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

export type DatabaseCompactionResult = {
  beforeBytes: number
  afterBytes: number
  reclaimedBytes: number
  operationsRemoved: number
  historyEntriesRemoved: number
  backupPath: string | null
  checkpointCreated: boolean
}

export type DatabaseMaintenanceStatus = {
  due: boolean
  lastCompletedAt: string | null
  checkpointCoordinator: boolean
  databaseBytes: number
  reclaimableBytes: number
  reclaimablePercent: number
  operationCount: number
  operationBytes: number
  checkpointRecommended: boolean
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
let localMutationRevision = 0
const persistedOperationListeners = new Set<() => void>()

export const persistenceError = writable('')
export const databaseLoadError = writable('')
export const databaseLoadPending = writable(isTauri())
export const databaseLoadProgress = writable<DatabaseLoadProgress>({
  percent: 0,
  stage: 'Starting Balance',
})

export function onPersistedOperation(listener: () => void): () => void {
  persistedOperationListeners.add(listener)
  return () => persistedOperationListeners.delete(listener)
}

function notifyPersistedOperation(): void {
  for (const listener of persistedOperationListeners) listener()
}

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
    // Keep startup on one command/response path. Emitting progress events from
    // the blocking native database task can stall Android error delivery while
    // its WebView is starting, leaving recovery failures stuck at 0%.
    databaseLoadProgress.set({ percent: 15, stage: 'Opening encrypted database' })
    const stored = await invoke<string | null>('read_app_state')
    databaseLoadProgress.set({ percent: 95, stage: 'Restoring workspace' })
    const parsed = parseStoredState(stored)
    persistenceTarget = 'tauri'

    if (parsed) {
      store.set(parsed)
    } else {
      await invoke('initialize_app_state', { stateJson: JSON.stringify(get(store)) })
    }
    databaseLoadProgress.set({ percent: 100, stage: 'Ready' })
    databaseLoadError.set('')
  } catch (error) {
    if (isTauri()) {
      const message = error instanceof Error ? error.message : String(error)
      databaseLoadError.set(message)
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
    databaseLoadPending.set(false)
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
  localMutationRevision += 1
  if (persistenceTarget === 'localStorage') return

  pendingOperations.set(operation.id, operation)
  if (!persistenceReady || persistenceTarget !== 'tauri') return

  scheduleOperationFlush()
}

function entityKeys(collection: EntityCollection, values: unknown[]): string[] {
  const occurrences = new Map<string, number>()
  return values.map((value, index) => {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const base = collection === 'goalCompletions'
      ? `${String(record.goalId ?? '')}\u001f${String(record.date ?? '')}`
      : String(record.id ?? `missing-id-${index}`)
    const occurrence = occurrences.get(base) ?? 0
    occurrences.set(base, occurrence + 1)
    return collection === 'goalCompletions' ? `${base}\u001f${occurrence}` : base
  })
}

function entityChangesBetween(before: AppState, after: AppState): EntityChanges | null {
  const upserts: EntityUpsert[] = []
  const deletes: EntityDelete[] = []

  for (const collection of ENTITY_COLLECTIONS) {
    const beforeValues = before[collection] as unknown[]
    const afterValues = after[collection] as unknown[]
    if (beforeValues === afterValues) continue

    const beforeKeys = entityKeys(collection, beforeValues)
    const afterKeys = entityKeys(collection, afterValues)
    const beforeByKey = new Map(beforeKeys.map((key, index) => [key, { value: beforeValues[index], position: index }]))
    const afterKeySet = new Set(afterKeys)

    afterValues.forEach((value, position) => {
      const key = afterKeys[position]
      const previous = beforeByKey.get(key)
      if (
        !previous ||
        previous.position !== position ||
        (previous.value !== value && JSON.stringify(previous.value) !== JSON.stringify(value))
      ) {
        upserts.push({ collection, key, position, value })
      }
    })
    beforeKeys.forEach((key) => {
      if (!afterKeySet.has(key)) deletes.push({ collection, key })
    })
  }

  return upserts.length > 0 || deletes.length > 0 ? { version: 1, upserts, deletes } : null
}

function operationEntityChanges(operation: Operation | undefined): EntityChanges | null {
  if (!operation?.payload || typeof operation.payload !== 'object') return null
  const changes = (operation.payload as Record<string, unknown>).entityChanges
  if (!changes || typeof changes !== 'object') return null
  const candidate = changes as Partial<EntityChanges>
  return candidate.version === 1 && Array.isArray(candidate.upserts) && Array.isArray(candidate.deletes)
    ? candidate as EntityChanges
    : null
}

function composeEntityChanges(previous: EntityChanges | null, latest: EntityChanges | null): EntityChanges | null {
  if (!previous) return latest
  if (!latest) return previous

  const actions = new Map<string, { upsert?: EntityUpsert; deletion?: EntityDelete }>()
  const actionKey = (collection: EntityCollection, key: string) => `${collection}\u0000${key}`
  for (const upsert of previous.upserts) actions.set(actionKey(upsert.collection, upsert.key), { upsert })
  for (const deletion of previous.deletes) actions.set(actionKey(deletion.collection, deletion.key), { deletion })
  for (const upsert of latest.upserts) actions.set(actionKey(upsert.collection, upsert.key), { upsert })
  for (const deletion of latest.deletes) actions.set(actionKey(deletion.collection, deletion.key), { deletion })

  const upserts: EntityUpsert[] = []
  const deletes: EntityDelete[] = []
  for (const action of actions.values()) {
    if (action.upsert) upserts.push(action.upsert)
    if (action.deletion) deletes.push(action.deletion)
  }
  return { version: 1, upserts, deletes }
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
          // Once an id has reached the database it is immutable for sync. Text
          // coalescing may continue only while an operation is still pending.
          lastOperationMergeKey = null
          notifyPersistedOperation()
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

function moveById<T extends { id: Id }>(
  items: T[],
  sourceId: Id,
  targetId: Id,
  placement: 'before' | 'after',
): T[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId)
  const targetIndex = items.findIndex((item) => item.id === targetId)
  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return items

  const moved = [...items]
  const [source] = moved.splice(sourceIndex, 1)
  const remainingTargetIndex = moved.findIndex((item) => item.id === targetId)
  moved.splice(remainingTargetIndex + (placement === 'after' ? 1 : 0), 0, source)

  return moved.every((item, index) => item === items[index]) ? items : moved
}

function createPlannerStore() {
  const store = writable<AppState>(readInitialState())
  let backendReloadPromise: Promise<void> | null = null
  let backendReloadRequestRevision = 0
  store.subscribe((state) => {
    if (persistenceReady && persistenceTarget === 'localStorage') persistLocalState(state)
  })
  const ready = hydratePersistence(store)

  async function waitForLocalMutationQuietPeriod(): Promise<void> {
    let observedRevision = localMutationRevision
    while (true) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, PERSIST_DEBOUNCE_MS))
      if (observedRevision === localMutationRevision) return
      observedRevision = localMutationRevision
    }
  }

  async function reloadFromBackendWhenStable(): Promise<void> {
    let waitForQuiet = false

    while (true) {
      if (waitForQuiet) await waitForLocalMutationQuietPeriod()
      await flushOperations()

      const mutationRevisionBeforeRead = localMutationRevision
      const requestRevisionBeforeRead = backendReloadRequestRevision
      const stored = await invoke<string | null>('read_app_state')
      const mutationChanged = mutationRevisionBeforeRead !== localMutationRevision

      if (mutationChanged || requestRevisionBeforeRead !== backendReloadRequestRevision) {
        // The backend result predates an edit or a newer refresh request. Never
        // replace the live workspace with it. A quiet period prevents a slow
        // mobile database from being reread after every keystroke.
        waitForQuiet = mutationChanged
        continue
      }

      const parsed = parseStoredState(stored)
      if (!parsed) return

      lastOperationMergeKey = null
      undoStack = []
      redoStack = []
      store.update((current) => ({ ...parsed, historyRevision: current.historyRevision + 1 }))
      return
    }
  }

  function requestStableBackendReload(): Promise<void> {
    backendReloadRequestRevision += 1
    if (!backendReloadPromise) {
      backendReloadPromise = reloadFromBackendWhenStable().finally(() => {
        backendReloadPromise = null
      })
    }
    return backendReloadPromise
  }

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
      const entityChanges = composeEntityChanges(
        canMergeOperation ? operationEntityChanges(lastOperation) : null,
        entityChangesBetween(state, next),
      )
      const operationPayload = entityChanges
        ? {
            ...(payload && typeof payload === 'object' ? payload : { value: payload }),
            entityChanges,
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

      if (options.undoable !== false) {
        recordHistory(state, committed, operation.id, options)
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

    patchPreferences(patch: Partial<ReplicatedPreferences>) {
      commit('patch_preferences', { patch }, (state) => {
        const preferences = normalizeReplicatedPreferences({ ...state.preferences, ...patch })
        return JSON.stringify(preferences) === JSON.stringify(state.preferences)
          ? state
          : { ...state, preferences }
      }, { undoable: false, reconcileGoals: false })
    },

    // Generating normally moves the app onto the generated day. The side-by-side
    // comparison fills its second pane instead, so it passes the date to stay on.
    generatePlan(templateId: Id, date: string, replaceExisting: boolean, activePlanDate = date) {
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

      commit('generate_plan', { templateId, date, replaceExisting, activePlanDate, generatedPlan: generated }, (state) => {
        const plans = replaceExisting ? state.plans.filter((plan) => plan.date !== date) : state.plans

        return {
          ...state,
          activePlanDate,
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

    patchPlanItem(
      planId: Id,
      itemId: Id,
      patch: Partial<Omit<PlanItem, 'id' | 'children'>>,
      options: TextChangeOptions = {},
    ) {
      const isTextPatch = 'text' in patch || 'html' in patch
      let goalMatchesChanged = false
      const completedParentIds: Id[] = []
      const completedDescendantIds: Id[] = []
      const mergeOptions =
        options.mergeKey && options.mergeHistory !== false
          ? { mergeKey: options.mergeKey, mergeWindowMs: options.mergeWindowMs ?? TEXT_MERGE_WINDOW_MS }
          : isTextPatch && options.mergeHistory !== false
            ? { mergeKey: `plan-item-text:${planId}:${itemId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS }
            : {}
      commit('patch_plan_item', { planId, itemId, patch, completedParentIds, completedDescendantIds }, (state) => updatePlan(state, planId, (plan) => {
        let items = updatePlanItem(plan.items, itemId, (item) => {
          const nextItem = applyPatch(item, patch)
          goalMatchesChanged = planItemGoalMatchesChanged(state.goals, plan.date, item, nextItem, { force: true })
          return nextItem
        })
        if (patch.done === true) {
          const completedDescendants = completePlanItemDescendants(items, [itemId])
          items = completedDescendants.items
          completedDescendantIds.push(...completedDescendants.completedDescendantIds)
          for (const descendantId of completedDescendants.completedDescendantIds) {
            const previousDescendant = findPlanItem(plan.items, descendantId)
            const completedDescendant = findPlanItem(items, descendantId)
            if (
              previousDescendant &&
              completedDescendant &&
              planItemGoalMatchesChanged(state.goals, plan.date, previousDescendant, completedDescendant, { force: true })
            ) {
              goalMatchesChanged = true
            }
          }
          const completed = completePlanItemAncestors(items, [itemId])
          items = completed.items
          completedParentIds.push(...completed.completedParentIds)
          for (const parentId of completed.completedParentIds) {
            const previousParent = findPlanItem(plan.items, parentId)
            const completedParent = findPlanItem(items, parentId)
            if (
              previousParent &&
              completedParent &&
              planItemGoalMatchesChanged(state.goals, plan.date, previousParent, completedParent, { force: true })
            ) {
              goalMatchesChanged = true
            }
          }
        }
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
      const completedParentIds: Id[] = []
      const completedDescendantIds: Id[] = []

      commit('patch_plan_items_done', { planId, itemIds, done, completedParentIds, completedDescendantIds }, (state) => updatePlan(state, planId, (plan) => {
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

        if (done) {
          const completedDescendants = completePlanItemDescendants(items, itemIds)
          items = completedDescendants.items
          completedDescendantIds.push(...completedDescendants.completedDescendantIds)
          for (const descendantId of completedDescendants.completedDescendantIds) {
            const previousDescendant = findPlanItem(plan.items, descendantId)
            const completedDescendant = findPlanItem(items, descendantId)
            if (
              previousDescendant &&
              completedDescendant &&
              planItemGoalMatchesChanged(state.goals, plan.date, previousDescendant, completedDescendant, { force: true })
            ) {
              goalMatchesChanged = true
            }
          }
          const completed = completePlanItemAncestors(items, itemIds)
          items = completed.items
          completedParentIds.push(...completed.completedParentIds)
          for (const parentId of completed.completedParentIds) {
            const previousParent = findPlanItem(plan.items, parentId)
            const completedParent = findPlanItem(items, parentId)
            if (
              previousParent &&
              completedParent &&
              planItemGoalMatchesChanged(state.goals, plan.date, previousParent, completedParent, { force: true })
            ) {
              goalMatchesChanged = true
            }
          }
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
      const emptyItem = !(before.text ?? '').trim() && !after.text.trim()
      let placement = emptyItem ? 'after' : splitPlacementForBeforeText(before)
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

    deletePlanItemPreservingChildren(planId: Id, itemId: Id) {
      commit('delete_plan_item_preserving_children', { planId, itemId }, (state) =>
        updatePlan(state, planId, (plan) => ({
          ...plan,
          items: deletePlanItemPreservingChildren(plan.items, itemId),
        })),
      )
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

    // Cross-day move, used by the side-by-side day comparison. The whole subtree
    // travels with the item, so it ships in the payload and lands in the target
    // plan the same way a paste would; the source plan just drops it.
    movePlanItemToPlan(
      sourcePlanId: Id,
      targetPlanId: Id,
      itemId: Id,
      targetId: Id | null,
      placement: 'before' | 'after' | 'inside',
    ) {
      if (sourcePlanId === targetPlanId) return

      const current = get(store)
      const sourcePlan = current.plans.find((plan) => plan.id === sourcePlanId)
      const targetPlan = current.plans.find((plan) => plan.id === targetPlanId)
      if (!sourcePlan || !targetPlan) return

      const item = findPlanItem(sourcePlan.items, itemId)
      if (!item) return
      if (targetId && !findPlanItem(targetPlan.items, targetId)) return

      commit(
        'move_plan_item_to_plan',
        { sourcePlanId, targetPlanId, itemId, targetId, placement, item },
        (state) => ({
          ...state,
          plans: state.plans.map((plan) => {
            if (plan.id === sourcePlanId) return { ...plan, items: deletePlanItem(plan.items, itemId) }
            if (plan.id === targetPlanId) {
              return { ...plan, items: pastePlanItemsIntoTree(plan.items, [item], targetId, placement) }
            }
            return plan
          }),
        }),
      )
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

    addGoal(name: string, cadenceDays: number, matchTerms: string[], hue: number, lightness = 50, matchTermsHtml?: string) {
      const goal = createGoal(name, cadenceDays, matchTerms, hue, lightness, todayISO(), createId('goal'), matchTermsHtml)
      commit('replace_goal_data', { action: 'add_goal', goalId: goal.id }, (state) => ({
        ...state,
        goals: [...state.goals, goal],
      }))
      return goal.id
    },

    patchGoal(goalId: Id, patch: Partial<Pick<Goal, 'name' | 'nameHtml' | 'cadenceDays' | 'matchTerms' | 'matchTermsHtml' | 'hue' | 'lightness'>>) {
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
              nameHtml: patch.nameHtml ?? (patch.name != null ? escapeHTML(patch.name.trim()) : goal.nameHtml),
              matchTerms: patch.matchTerms ? normalizeMatchTerms(patch.matchTerms) : goal.matchTerms,
              matchTermsHtml:
                patch.matchTermsHtml ??
                (patch.matchTerms ? escapeHTML(normalizeMatchTerms(patch.matchTerms).join(', ')) : goal.matchTermsHtml),
              updatedAt: nowISO(),
            })
            if (JSON.stringify(next) !== JSON.stringify(goal)) changed = true
            return next
          })

          return changed ? { ...state, goals } : state
        },
        {
          mergeKey: `goal:${goalId}`,
          mergeWindowMs: TEXT_MERGE_WINDOW_MS,
          // Names and colors do not affect which checked plan items satisfy a
          // goal. Avoid rescanning every saved plan on each character/color
          // input; matching-term edits still reconcile immediately.
          reconcileGoals: 'matchTerms' in patch,
        },
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
      commit(
        'rename_template',
        { templateId, name },
        (state) => ({
          ...state,
          templates: state.templates.map((template) =>
            template.id === templateId ? { ...template, name, updatedAt: nowISO() } : template,
          ),
        }),
        { mergeKey: `day-template-name:${templateId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS },
      )
    },

    addTemplate() {
      const template = createDailyTemplate()
      commit('add_template', { template }, (state) => ({
        ...state,
        templates: [...state.templates, template],
      }))
      return template.id
    },

    deleteTemplate(templateId: Id) {
      commit('delete_template', { templateId }, (state) => {
        if (state.templates.length <= 1 || !state.templates.some((template) => template.id === templateId)) {
          return state
        }
        return {
          ...state,
          templates: state.templates.filter((template) => template.id !== templateId),
        }
      })
    },

    moveTemplate(sourceId: Id, targetId: Id, placement: 'before' | 'after') {
      if (sourceId === targetId) return

      commit('move_template', { sourceId, targetId, placement }, (state) => {
        const templates = moveById(state.templates, sourceId, targetId, placement)
        return templates === state.templates ? state : { ...state, templates }
      })
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
      const template = get(store).templates.find((candidate) => candidate.id === templateId)
      const probability = findTemplateOption(template?.items ?? [], optionId)?.probability ?? 100
      const placement = splitPlacementForBeforeText(before)
      const patch = placement === 'before' ? after : before
      const inserted = placement === 'before' ? before : after
      const newItem = {
        ...createTemplateItem(inserted.text ?? ''),
        options: [
          {
            ...createTemplateOption(inserted.text ?? '', probability),
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

    backspaceTemplateOptionAtStart(templateId: Id, itemId: Id, optionId: Id) {
      const template = get(store).templates.find((candidate) => candidate.id === templateId)
      if (!template) return null

      const result = backspaceTemplateOptionAtStartInTree(template.items, itemId, optionId)
      if (!result) return null

      commit(
        'backspace_template_option_at_start',
        { templateId, itemId, optionId, ...result.operation },
        (state) =>
          updateTemplate(state, templateId, (candidate) =>
            candidate.id === template.id
              ? { ...candidate, updatedAt: nowISO(), items: result.items }
              : candidate,
          ),
      )

      return { focusOptionId: result.focusOptionId, focusOffset: result.focusOffset }
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

    deleteTemplateItemPreservingChildren(templateId: Id, itemId: Id) {
      commit('delete_template_item_preserving_children', { templateId, itemId }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: deleteTemplateItemPreservingChildren(template.items, itemId),
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
        const listTemplates = moveById(state.listTemplates, sourceId, targetId, placement)
        if (listTemplates === state.listTemplates) return state
        return { ...state, listTemplates }
      })
    },

    // ---- Notes (reuse the plan-item tree and shared rich-text editor) ----

    addNote() {
      const note = createNote()
      commit('add_note', { noteId: note.id }, (state) => ({ ...state, notes: [note, ...state.notes] }))
      return note.id
    },

    trashNote(noteId: Id) {
      const deletedAt = nowISO()
      commit('trash_note', { noteId, deletedAt }, (state) =>
        updateNote(state, noteId, (note) => note.deletedAt ? note : { ...note, deletedAt }),
      )
    },

    restoreNote(noteId: Id) {
      commit('restore_note', { noteId }, (state) =>
        updateNote(state, noteId, (note) => note.deletedAt ? { ...note, deletedAt: null } : note),
      )
    },

    permanentlyDeleteNote(noteId: Id) {
      commit(
        'permanently_delete_note',
        { noteId },
        (state) => ({ ...state, notes: state.notes.filter((note) => note.id !== noteId) }),
      )
    },

    emptyNoteTrash() {
      commit(
        'empty_note_trash',
        {},
        (state) => {
          const notes = state.notes.filter((note) => !note.deletedAt)
          return notes.length === state.notes.length ? state : { ...state, notes }
        },
      )
    },

    purgeExpiredNotes(now = Date.now()) {
      commit(
        'purge_expired_notes',
        { now },
        (state) => {
          const notes = state.notes.filter((note) => !isNoteTrashExpired(note, now))
          return notes.length === state.notes.length ? state : { ...state, notes }
        },
        { undoable: false },
      )
    },

    renameNote(noteId: Id, title: string) {
      commit(
        'rename_note',
        { noteId, title },
        (state) => updateNote(state, noteId, (note) => ({ ...note, title, updatedAt: nowISO() })),
        { mergeKey: `note-title:${noteId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS },
      )
    },

    addRootNoteItem(noteId: Id, kind: NoteItemKind = 'paragraph') {
      const item = createNoteItem('', kind)
      commit('add_note_item', { noteId, item }, (state) =>
        updateNote(state, noteId, (note) => ({
          ...note,
          updatedAt: nowISO(),
          items: [...note.items, item],
        })),
      )
      return item.id
    },

    patchNoteItem(noteId: Id, itemId: Id, patch: Partial<NoteItem>, options: TextChangeOptions = {}) {
      const isTextPatch = 'text' in patch || 'html' in patch
      const mergeOptions =
        isTextPatch && options.mergeHistory !== false
          ? { mergeKey: `note-item-text:${noteId}:${itemId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS }
          : {}
      commit('patch_note_item', { noteId, itemId, patch }, (state) =>
        updateNote(state, noteId, (note) => {
          const items = updatePlanItem(note.items, itemId, (item) => applyPatch(item, patch)) as NoteItem[]
          return items === note.items ? note : { ...note, updatedAt: nowISO(), items }
        }), mergeOptions)
    },

    splitNoteItem(noteId: Id, itemId: Id, before: { html: string; text: string }, after: { html: string; text: string }) {
      const note = get(store).notes.find((candidate) => candidate.id === noteId)
      const source = note ? findPlanItem(note.items, itemId) as NoteItem | null : null
      const emptyListItem =
        (source?.kind === 'bullet' || source?.kind === 'numbered') &&
        !before.text.trim() &&
        !after.text.trim()
      const placement = emptyListItem ? 'after' : splitPlacementForBeforeText(before)
      const patch = placement === 'before' ? after : before
      const inserted = placement === 'before' ? before : after
      const nextKind = source?.kind === 'heading' && placement === 'after' ? 'paragraph' : (source?.kind ?? 'paragraph')
      const newItem = { ...createNoteItem(inserted.text, nextKind), html: inserted.html }
      commit('split_note_item', { noteId, itemId, patch, newItem, placement }, (state) =>
        updateNote(state, noteId, (candidate) => ({
          ...candidate,
          updatedAt: nowISO(),
          items: splitPlanItem(candidate.items, itemId, patch, newItem, placement) as NoteItem[],
        })),
      )
      return newItem.id
    },

    deleteNoteItem(noteId: Id, itemId: Id) {
      commit('delete_note_item', { noteId, itemId }, (state) =>
        updateNote(state, noteId, (note) => ({
          ...note,
          updatedAt: nowISO(),
          items: deletePlanItem(note.items, itemId) as NoteItem[],
        })),
      )
    },

    deleteNoteItemPreservingChildren(noteId: Id, itemId: Id) {
      commit('delete_note_item_preserving_children', { noteId, itemId }, (state) =>
        updateNote(state, noteId, (note) => ({
          ...note,
          updatedAt: nowISO(),
          items: deletePlanItemPreservingChildren(note.items, itemId) as NoteItem[],
        })),
      )
    },

    backspaceNoteItemAtStart(noteId: Id, itemId: Id) {
      const note = get(store).notes.find((candidate) => candidate.id === noteId)
      if (!note) return null
      const result = backspacePlanItemAtStartInTree(note.items, itemId)
      if (!result) return null
      commit('backspace_note_item_at_start', { noteId, itemId, ...result.operation }, (state) =>
        updateNote(state, noteId, (candidate) => ({
          ...candidate,
          updatedAt: nowISO(),
          items: result.items as NoteItem[],
        })),
      )
      return { focusItemId: result.focusItemId, focusOffset: result.focusOffset }
    },

    moveNoteItem(noteId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) {
      commit('move_note_item', { noteId, sourceId, targetId, placement }, (state) =>
        updateNote(state, noteId, (note) => ({
          ...note,
          updatedAt: nowISO(),
          items: movePlanItem(note.items, sourceId, targetId, placement) as NoteItem[],
        })),
      )
    },

    moveNoteItemWithinLevel(noteId: Id, itemId: Id, direction: MoveDirection) {
      commit('move_note_item_within_level', { noteId, itemId, direction }, (state) =>
        updateNote(state, noteId, (note) => ({
          ...note,
          updatedAt: nowISO(),
          items: movePlanItemWithinLevel(note.items, itemId, direction) as NoteItem[],
        })),
      )
    },

    outdentNoteItem(noteId: Id, itemId: Id) {
      commit('outdent_note_item', { noteId, itemId }, (state) =>
        updateNote(state, noteId, (note) => ({
          ...note,
          updatedAt: nowISO(),
          items: outdentPlanItemInTree(note.items, itemId) as NoteItem[],
        })),
      )
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
      const template = get(store).listTemplates.find((candidate) => candidate.id === templateId)
      const probability = findListTemplateItemLocation(template?.items ?? [], itemId)?.item.probability ?? 100
      const placement: 'before' | 'after' = splitPlacementForBeforeText(before) === 'before' ? 'before' : 'after'
      const patch = placement === 'before' ? after : before
      const inserted = placement === 'before' ? before : after
      const newItem = { ...createListTemplateItem(inserted.text ?? ''), html: inserted.html ?? '', probability }

      commit('split_list_template_item', { templateId, itemId, patch, newItem, placement }, (state) =>
        updateListTemplate(state, templateId, (template) => {
          const items = splitListTemplateItem(template.items, itemId, patch, newItem, placement)
          return items === template.items ? template : { ...template, updatedAt: nowISO(), items }
        }),
      )

      return newItem.id
    },

    deleteListTemplateItem(templateId: Id, itemId: Id) {
      const archivedAt = nowISO()
      const archivedDate = calendarDateISO()
      const archiveId = createId('archived_list_item')
      commit('delete_list_template_item', { templateId, itemId, archiveId, archivedAt, archivedDate }, (state) =>
        updateListTemplate(state, templateId, (template) => ({
          ...archiveListTemplateItem(template, itemId, false, archiveId, archivedAt, archivedDate),
          updatedAt: archivedAt,
        })),
      )
    },

    deleteListTemplateItemPreservingChildren(templateId: Id, itemId: Id) {
      const archivedAt = nowISO()
      const archivedDate = calendarDateISO()
      const archiveId = createId('archived_list_item')
      commit('delete_list_template_item_preserving_children', { templateId, itemId, archiveId, archivedAt, archivedDate }, (state) =>
        updateListTemplate(state, templateId, (template) => ({
          ...archiveListTemplateItem(template, itemId, true, archiveId, archivedAt, archivedDate),
          updatedAt: archivedAt,
        })),
      )
    },

    backspaceListTemplateItemAtStart(templateId: Id, itemId: Id) {
      const template = get(store).listTemplates.find((candidate) => candidate.id === templateId)
      if (!template) return null

      const result = backspaceListTemplateItemAtStartInTree(template.items, itemId)
      if (!result) return null

      commit('backspace_list_template_item_at_start', { templateId, itemId, ...result.operation }, (state) =>
        updateListTemplate(state, templateId, (candidate) =>
          candidate.id === template.id
            ? { ...candidate, updatedAt: nowISO(), items: result.items }
            : candidate,
        ),
      )

      return { focusItemId: result.focusItemId, focusOffset: result.focusOffset }
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
      commit('cut_list_template_items', { templateId, itemIds: rootIds }, (state) =>
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

      const archivedAt = nowISO()
      const archivedDate = calendarDateISO()
      const archiveIds = rootIds.map(() => createId('archived_list_item'))
      commit('delete_list_template_items', { templateId, itemIds: rootIds, archiveIds, archivedAt, archivedDate }, (state) =>
        updateListTemplate(state, templateId, (template) => {
          const archivedItems = rootIds.flatMap((itemId, index) => {
            const location = findListTemplateItemLocation(template.items, itemId)
            if (!location || !listTemplateItemHasArchiveContent(location.item)) return []
            return [{
              id: archiveIds[index],
              item: location.item,
              parentId: location.parentId,
              position: location.position,
              archivedAt,
              archivedDate,
            } satisfies ArchivedListTemplateItem]
          })
          return {
            ...template,
            updatedAt: archivedAt,
            items: deleteListTemplateItems(template.items, rootIds),
            archivedItems: [...template.archivedItems, ...archivedItems],
          }
        }),
      )
      return rootIds
    },

    pasteListTemplateItems(templateId: Id, itemsToPaste: ListTemplateItem[], targetId: Id | null, placement: 'after' | 'replace') {
      if (itemsToPaste.length === 0) return []
      const pastedItems = cloneListTemplateItemsForPaste(itemsToPaste)
      const archivedAt = nowISO()
      const archivedDate = calendarDateISO()
      const archiveId = createId('archived_list_item')
      commit('paste_list_template_items', { templateId, targetId, placement, items: pastedItems, archiveId, archivedAt, archivedDate }, (state) =>
        updateListTemplate(state, templateId, (template) => {
          const archivedTemplate = placement === 'replace' && targetId
            ? archiveListTemplateItemSnapshot(template, targetId, archiveId, archivedAt, archivedDate)
            : template
          return {
            ...archivedTemplate,
            updatedAt: archivedAt,
            items: pasteListTemplateItemsIntoTree(template.items, pastedItems, targetId, placement),
          }
        }),
      )
      return pastedItems.map((item) => item.id)
    },

    restoreArchivedListTemplateItem(templateId: Id, archiveId: Id) {
      commit('restore_archived_list_template_item', { templateId, archiveId }, (state) =>
        updateListTemplate(state, templateId, (template) => {
          const archived = template.archivedItems.find((entry) => entry.id === archiveId)
          if (!archived) return template

          const restoredItem = listTemplateItemIdExists(template.items, archived.item.id)
            ? cloneListTemplateItemWithFreshIds(archived.item)
            : archived.item
          const items = insertListTemplateItemAt(
            template.items,
            archived.parentId,
            archived.position,
            restoredItem,
          )
          return {
            ...template,
            updatedAt: nowISO(),
            items,
            archivedItems: template.archivedItems.filter((entry) => entry.id !== archiveId),
          }
        }),
      )
    },

    permanentlyDeleteArchivedListTemplateItem(templateId: Id, archiveId: Id) {
      commit('delete_archived_list_template_item', { templateId, archiveId }, (state) =>
        updateListTemplate(state, templateId, (template) => {
          if (!template.archivedItems.some((entry) => entry.id === archiveId)) return template
          return {
            ...template,
            updatedAt: nowISO(),
            archivedItems: template.archivedItems.filter((entry) => entry.id !== archiveId),
          }
        }),
      )
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

    deleteListItemPreservingChildren(listId: Id, itemId: Id) {
      commit('delete_list_item_preserving_children', { listId, itemId }, (state) =>
        updateList(state, listId, (list) => ({
          ...list,
          items: deletePlanItemPreservingChildren(list.items, itemId),
        })),
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
        const expected = undoStack.at(-1)
        const resultJson = await invoke<string | null>('undo_last_operation', {
          expectedOperationId: expected?.operationId ?? null,
        })
        const result = parseBackendHistoryResult(resultJson)
        if (!result) {
          undoStack = []
          redoStack = []
          return
        }

        lastOperationMergeKey = null
        if (expected && result.operationId === expected.operationId && result.state === null) {
          undoStack.pop()
          redoStack.push(expected)
          store.update((current) => stateFromNativeHistoryEntry(current, expected.before, result.localSequence))
        } else if (result.state) {
          const parsed = parseStoredState(JSON.stringify(result.state))
          if (parsed) {
            undoStack = []
            redoStack = []
            store.update((current) => ({ ...parsed, historyRevision: current.historyRevision + 1 }))
          }
        }
        notifyPersistedOperation()
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
        const expected = redoStack.at(-1)
        const resultJson = await invoke<string | null>('redo_last_operation', {
          expectedOperationId: expected?.operationId ?? null,
        })
        const result = parseBackendHistoryResult(resultJson)
        if (!result) {
          undoStack = []
          redoStack = []
          return
        }

        lastOperationMergeKey = null
        if (expected && result.operationId === expected.operationId && result.state === null) {
          redoStack.pop()
          undoStack.push(expected)
          store.update((current) => stateFromNativeHistoryEntry(current, expected.after, result.localSequence))
        } else if (result.state) {
          const parsed = parseStoredState(JSON.stringify(result.state))
          if (parsed) {
            undoStack = []
            redoStack = []
            store.update((current) => ({ ...parsed, historyRevision: current.historyRevision + 1 }))
          }
        }
        notifyPersistedOperation()
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
      undoStack = []
      redoStack = []
      store.update((current) => ({ ...parsed, historyRevision: current.historyRevision + 1 }))
      notifyPersistedOperation()
      return true
    },

    async reloadFromBackend(): Promise<void> {
      if (!isTauri()) return
      await requestStableBackendReload()
    },
  }
}

function parseBackendHistoryResult(raw: string | null): BackendHistoryResult | null {
  if (!raw) return null
  try {
    const result = JSON.parse(raw) as Partial<BackendHistoryResult>
    if (
      typeof result.operationId !== 'string' ||
      typeof result.localSequence !== 'number' ||
      !Number.isSafeInteger(result.localSequence) ||
      (result.state !== null && (typeof result.state !== 'object' || result.state === undefined))
    ) {
      return null
    }
    return result as BackendHistoryResult
  } catch {
    return null
  }
}

function stateFromNativeHistoryEntry(current: AppState, snapshot: AppState, localSequence: number): AppState {
  return {
    ...snapshot,
    deviceId: current.deviceId,
    localSequence,
    // Preferences are intentionally not undoable and may have changed after
    // this history entry was recorded. Native undo never rewinds them.
    preferences: current.preferences,
    operations: [],
    historyRevision: current.historyRevision + 1,
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

function recordHistory(before: AppState, after: AppState, operationId: string, options: CommitOptions): void {
  const now = Date.now()
  const mergeKey = options.mergeKey ?? null
  const mergeWindowMs = options.mergeWindowMs ?? 0
  const last = undoStack.at(-1)
  // Native history operations are already durable in SQLite. Keeping their
  // ever-growing in-memory operation arrays would turn the snapshot cache into
  // quadratic memory use during a long session.
  const historyBefore = isTauri() ? { ...before, operations: [] } : before
  const historyAfter = isTauri() ? { ...after, operations: [] } : after

  if (last && mergeKey && last.mergeKey === mergeKey && now - last.updatedAt <= mergeWindowMs) {
    last.after = historyAfter
    last.operationId = operationId
    last.updatedAt = now
  } else {
    undoStack.push({ operationId, before: historyBefore, after: historyAfter, mergeKey, updatedAt: now })
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

function findTemplateOption(items: TemplateItem[], optionId: Id): TemplateOption | null {
  for (const item of items) {
    const option = item.options.find((candidate) => candidate.id === optionId)
    if (option) return option
    const child = findTemplateOption(item.children, optionId)
    if (child) return child
  }
  return null
}

type ListTemplateItemLocation = {
  item: ListTemplateItem
  parentId: Id | null
  position: number
}

function findListTemplateItemLocation(
  items: ListTemplateItem[],
  itemId: Id,
  parentId: Id | null = null,
): ListTemplateItemLocation | null {
  for (let position = 0; position < items.length; position += 1) {
    const item = items[position]
    if (item.id === itemId) return { item, parentId, position }
    const child = findListTemplateItemLocation(item.children, itemId, item.id)
    if (child) return child
  }
  return null
}

function listTemplateItemHasArchiveContent(item: ListTemplateItem): boolean {
  return item.text.trim() !== '' || htmlToPlainText(item.html).trim() !== '' || item.children.length > 0
}

function archiveListTemplateItemSnapshot(
  template: ListTemplate,
  itemId: Id,
  archiveId: Id,
  archivedAt: string,
  archivedDate: string,
  preserveChildren = false,
): ListTemplate {
  const location = findListTemplateItemLocation(template.items, itemId)
  if (!location) return template

  const snapshot = preserveChildren ? { ...location.item, children: [] } : location.item
  if (!listTemplateItemHasArchiveContent(snapshot)) return template

  const archived: ArchivedListTemplateItem = {
    id: archiveId,
    item: snapshot,
    parentId: location.parentId,
    position: location.position,
    archivedAt,
    archivedDate,
  }
  return { ...template, archivedItems: [...template.archivedItems, archived] }
}

function archiveListTemplateItem(
  template: ListTemplate,
  itemId: Id,
  preserveChildren: boolean,
  archiveId: Id,
  archivedAt: string,
  archivedDate: string,
): ListTemplate {
  const archived = archiveListTemplateItemSnapshot(
    template,
    itemId,
    archiveId,
    archivedAt,
    archivedDate,
    preserveChildren,
  )
  return {
    ...archived,
    items: preserveChildren
      ? deleteListTemplateItemPreservingChildren(template.items, itemId)
      : deleteListTemplateItem(template.items, itemId),
  }
}

function listTemplateItemIdExists(items: ListTemplateItem[], itemId: Id): boolean {
  return items.some((item) => item.id === itemId || listTemplateItemIdExists(item.children, itemId))
}

function cloneListTemplateItemWithFreshIds(item: ListTemplateItem): ListTemplateItem {
  return {
    ...item,
    id: createId('list_item'),
    children: item.children.map(cloneListTemplateItemWithFreshIds),
  }
}

function insertListTemplateItemAt(
  items: ListTemplateItem[],
  parentId: Id | null,
  position: number,
  item: ListTemplateItem,
): ListTemplateItem[] {
  if (!parentId) {
    const insertion = Math.min(Math.max(0, position), items.length)
    return [...items.slice(0, insertion), item, ...items.slice(insertion)]
  }

  const nested = insertListTemplateItemAtExistingParent(items, parentId, position, item)
  return nested === items ? [...items, item] : nested
}

function insertListTemplateItemAtExistingParent(
  items: ListTemplateItem[],
  parentId: Id,
  position: number,
  item: ListTemplateItem,
): ListTemplateItem[] {
  for (let index = 0; index < items.length; index += 1) {
    const candidate = items[index]
    if (candidate.id === parentId) {
      const insertion = Math.min(Math.max(0, position), candidate.children.length)
      return [
        ...items.slice(0, index),
        {
          ...candidate,
          children: [
            ...candidate.children.slice(0, insertion),
            item,
            ...candidate.children.slice(insertion),
          ],
        },
        ...items.slice(index + 1),
      ]
    }

    const children = insertListTemplateItemAtExistingParent(candidate.children, parentId, position, item)
    if (children !== candidate.children) {
      return [
        ...items.slice(0, index),
        { ...candidate, children },
        ...items.slice(index + 1),
      ]
    }
  }
  return items
}

function updateNote(state: AppState, noteId: Id, updater: (note: Note) => Note): AppState {
  let changed = false
  const notes = state.notes.map((note) => {
    if (note.id !== noteId) return note
    const nextNote = updater(note)
    if (nextNote !== note) changed = true
    return nextNote
  })
  return changed ? { ...state, notes } : state
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
        item.timeHidden !== true && item.startMinutes !== null && item.endMinutes !== null
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

export async function confirmRecoveryKey(recoveryKey: string): Promise<void> {
  if (!isTauri()) return
  await invoke('confirm_recovery_key', { recoveryKey })
}

export async function rotateDatabaseRecoveryKey(): Promise<RecoveryKeyRotationResult | null> {
  if (!isTauri()) return null
  return invoke<RecoveryKeyRotationResult>('rotate_database_recovery_key')
}

export async function recoverDatabaseWithKey(recoveryKey: string): Promise<void> {
  if (!isTauri()) return
  await invoke('recover_database_with_key', { recoveryKey })
  cachedSyncSettings = null
  pendingSyncSettings = null
}

export async function listRecoveryEntries(): Promise<RecoveryEntry[]> {
  if (!isTauri()) return []
  const raw = await invoke<string>('list_recovery_entries')
  const parsed = JSON.parse(raw) as { entries: RecoveryEntry[] }
  return parsed.entries ?? []
}

export async function searchRecoveryHistory(query: string): Promise<RecoverySearchMatch[]> {
  if (!isTauri() || !query.trim()) return []
  const raw = await invoke<string>('search_recovery_history', { query: query.trim() })
  const parsed = JSON.parse(raw) as { entries: RecoverySearchMatch[] }
  return parsed.entries ?? []
}

// --- Multi-device sync (cr-sqlite engine; see src-tauri/src/sync) -----------

export type SyncSettings = {
  enabled: boolean
  pairingCode: string | null
  relayUrl: string
}

let cachedSyncSettings: SyncSettings | null = null
let pendingSyncSettings: Promise<SyncSettings> | null = null

function rememberSyncSettings(settings: SyncSettings): SyncSettings {
  cachedSyncSettings = settings
  return settings
}

/** Device-local sync configuration from encrypted, non-replicated DB metadata. */
export async function getSyncSettings(): Promise<SyncSettings> {
  if (!isTauri()) return { enabled: false, pairingCode: null, relayUrl: '' }
  if (cachedSyncSettings) return cachedSyncSettings
  if (!pendingSyncSettings) {
    pendingSyncSettings = invoke<SyncSettings>('get_sync_settings')
      .then(rememberSyncSettings)
      .finally(() => {
        pendingSyncSettings = null
      })
  }
  return pendingSyncSettings
}

/** Persist this device's relay endpoint outside origin-scoped webview storage. */
export async function setSyncRelayUrl(relayUrl: string): Promise<SyncSettings> {
  if (!isTauri()) return { enabled: false, pairingCode: null, relayUrl: relayUrl.trim() }
  return invoke<SyncSettings>('set_sync_relay_url', { relayUrl }).then(rememberSyncSettings)
}

/** Generate a fresh account sync key and return its QR/pairing code. */
export async function syncNewPairingCode(): Promise<string> {
  if (!isTauri()) return ''
  return invoke<string>('sync_new_pairing_code')
}

/** Enable sync as the primary device — keep this device's data as the baseline. */
export async function syncEnablePrimary(pairingCode: string): Promise<void> {
  if (!isTauri()) return
  await flushOperations()
  await invoke('sync_enable_primary', { pairingCode })
  if (cachedSyncSettings) cachedSyncSettings = { ...cachedSyncSettings, enabled: true, pairingCode }
}

/** Enable sync as a joining device — adopt the primary's data (local is backed up). */
export async function syncEnableJoiner(pairingCode: string): Promise<void> {
  if (!isTauri()) return
  await flushOperations()
  await invoke('sync_enable_joiner', { pairingCode })
  if (cachedSyncSettings) cachedSyncSettings = { ...cachedSyncSettings, enabled: true, pairingCode }
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
  await flushOperations()
  return invoke<string | null>('sync_p2p_sync', { address })
}

export type SyncPassResult = {
  pulledOperations: number
  pushedOperations: number
  stateChanged: boolean
  checkpointCommitted: boolean
  epoch: string
  latestSequence: number
}

export async function syncRelayOnce(reason: string): Promise<SyncPassResult> {
  await flushOperations()
  return invoke<SyncPassResult>('sync_relay_once', { reason })
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
      preferences: normalizeReplicatedPreferences(null),
      templates: [],
      plans: parsed.plans ?? [],
      listTemplates: [],
      lists: [],
      metrics: [],
      metricEntries: [],
      notes: [],
      goals: [],
      goalCompletions: [],
      operations: [],
    }).plans,
  }
}

export async function compactDatabase(): Promise<DatabaseCompactionResult | null> {
  if (!isTauri()) return null
  await flushOperations()
  return invoke<DatabaseCompactionResult>('compact_database')
}

export async function getDatabaseMaintenanceStatus(): Promise<DatabaseMaintenanceStatus | null> {
  if (!isTauri()) return null
  return invoke<DatabaseMaintenanceStatus>('get_database_maintenance_status')
}

export async function runDatabaseMaintenanceIfNeeded(): Promise<DatabaseCompactionResult | null> {
  if (!isTauri()) return null
  await flushOperations()
  return invoke<DatabaseCompactionResult | null>('run_database_maintenance_if_needed')
}

export async function completeDatabaseMaintenanceStartup(): Promise<void> {
  if (!isTauri()) return
  await invoke('complete_database_maintenance_startup')
}

function normalizeState(state: AppState): AppState {
  return {
    ...state,
    preferences: normalizeReplicatedPreferences(state.preferences),
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
      archivedItems: (template.archivedItems ?? []).map(normalizeArchivedListTemplateItem),
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
    notes: (state.notes ?? []).map((note) => ({
      ...note,
      title: note.title ?? '',
      deletedAt: typeof note.deletedAt === 'string' && Number.isFinite(Date.parse(note.deletedAt)) ? note.deletedAt : null,
      items: normalizeNoteItems(note.items ?? []),
    })),
  }
}

function normalizeArchivedListTemplateItem(entry: ArchivedListTemplateItem): ArchivedListTemplateItem {
  const archivedAt = typeof entry.archivedAt === 'string' && Number.isFinite(Date.parse(entry.archivedAt))
    ? entry.archivedAt
    : nowISO()
  const archivedDate = /^\d{4}-\d{2}-\d{2}$/.test(entry.archivedDate ?? '')
    ? entry.archivedDate
    : archivedAt.slice(0, 10)

  return {
    ...entry,
    parentId: entry.parentId ?? null,
    position: Math.max(0, Math.round(entry.position) || 0),
    archivedAt,
    archivedDate,
    item: normalizeListTemplateItems([entry.item])[0] ?? createListTemplateItem(),
  }
}

function normalizeNoteItems(items: NoteItem[]): NoteItem[] {
  const kinds = new Set<NoteItemKind>(['paragraph', 'heading', 'bullet', 'numbered', 'checklist'])
  return items.map((item) => {
    const html = sanitizeInlineHTML(item.html ?? escapeHTML(item.text ?? ''))

    return {
      ...item,
      text: item.text ?? htmlToPlainText(html),
      html,
      startMinutes: item.startMinutes ?? null,
      endMinutes: item.endMinutes ?? null,
      kind: kinds.has(item.kind) ? item.kind : 'paragraph',
      children: normalizeNoteItems(item.children ?? []),
    }
  })
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
      timeHidden: item.timeHidden === true || undefined,
      children: normalizePlanItems(item.children ?? []),
    }
  })
}

function normalizeTemplateItems(items: TemplateItem[]): TemplateItem[] {
  return items.map((item) => ({
    ...item,
    startMinutes: item.startMinutes ?? null,
    endMinutes: item.endMinutes ?? null,
    timeHidden: item.timeHidden === true || undefined,
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
