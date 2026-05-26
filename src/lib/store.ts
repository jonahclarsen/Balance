import { invoke, isTauri } from '@tauri-apps/api/core'
import { get, writable, type Writable } from 'svelte/store'
import {
  addPlanItem,
  addTemplateItem,
  createInitialState,
  createPlanItem,
  createTemplateItem,
  createTemplateOption,
  DEFAULT_DAILY_REMINDER,
  deletePlanItem,
  deleteTemplateItem,
  escapeHTML,
  formatMinutes,
  generatePlanFromTemplate,
  htmlToPlainText,
  movePlanItem,
  movePlanItemWithinLevel,
  moveTemplateItem,
  moveTemplateItemWithinLevel,
  nowISO,
  outdentPlanItem as outdentPlanItemInTree,
  outdentTemplateItem as outdentTemplateItemInTree,
  sanitizeInlineHTML,
  splitPlanItem,
  splitTemplateItem,
  todayISO,
  updatePlanItem,
  updateTemplateItem,
} from './planner'
import type { AppState, DailyPlan, Id, Operation, PlanItem, TemplateItem, TemplateOption } from './types'

const STORAGE_KEY = 'balance.appState.v1'
const TEXT_MERGE_WINDOW_MS = 1200
const MAX_HISTORY_ENTRIES = 200
const PERSIST_DEBOUNCE_MS = 500

type Mutator = (state: AppState) => AppState
type CommitOptions = {
  undoable?: boolean
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
        } catch (error) {
          for (const operationToRetry of operations.slice(index)) {
            pendingOperations.set(operationToRetry.id, operationToRetry)
          }
          throw error
        }
      }
    }
  } catch (error) {
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
  void hydratePersistence(store)

  function commit(type: string, payload: unknown, mutate: Mutator, options: CommitOptions = {}): void {
    let operationToPersist: Operation | null = null

    store.update((state) => {
      const next = mutate(state)
      if (next === state) return state

      const now = Date.now()
      const timestamp = nowISO()
      const lastOperation = state.operations.at(-1)
      const canMergeOperation =
        Boolean(options.mergeKey) &&
        lastOperationMergeKey === options.mergeKey &&
        lastOperation !== undefined &&
        now - lastOperationMergeUpdatedAt <= (options.mergeWindowMs ?? 0)
      const sequence = canMergeOperation ? lastOperation.sequence : state.localSequence + 1
      const operation: Operation = canMergeOperation
        ? { ...lastOperation, timestamp, payload }
        : {
            id: `op_${state.deviceId}_${sequence}`,
            deviceId: state.deviceId,
            sequence,
            type,
            timestamp,
            payload,
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
      const generated = generatePlanFromTemplate(template, date, dailyReminderForGeneratedPlan(current.plans, date))

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

    patchPlanItem(planId: Id, itemId: Id, patch: Partial<Omit<PlanItem, 'id' | 'children'>>) {
      const isTextPatch = 'text' in patch || 'html' in patch
      commit('patch_plan_item', { planId, itemId, patch }, (state) => updatePlan(state, planId, (plan) => {
        const items = updatePlanItem(plan.items, itemId, (item) => applyPatch(item, patch))
        return items === plan.items ? plan : { ...plan, items }
      }), isTextPatch ? { mergeKey: `plan-item-text:${planId}:${itemId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS } : {})
    },

    splitPlanItem(
      planId: Id,
      itemId: Id,
      patch: Partial<Omit<PlanItem, 'id' | 'children'>>,
      after: { html: string; text: string },
    ) {
      const newItem = {
        ...createPlanItem(after.text),
        html: after.html,
      }

      commit('split_plan_item', { planId, itemId, patch, newItem }, (state) => updatePlan(state, planId, (plan) => {
        const items = splitPlanItem(plan.items, itemId, patch, newItem)
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

    outdentPlanItem(planId: Id, itemId: Id) {
      commit('outdent_plan_item', { planId, itemId }, (state) => updatePlan(state, planId, (plan) => {
        const items = outdentPlanItemInTree(plan.items, itemId)
        return items === plan.items ? plan : { ...plan, items }
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

    patchTemplateItem(templateId: Id, itemId: Id, patch: Partial<TemplateItem>) {
      commit('patch_template_item', { templateId, itemId, patch }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: updateTemplateItem(template.items, itemId, (item) => ({ ...item, ...patch })),
        })),
      )
    },

    splitTemplateItem(
      templateId: Id,
      itemId: Id,
      optionId: Id,
      patch: Partial<TemplateOption>,
      after: { html: string; text: string },
    ) {
      const newItem = {
        ...createTemplateItem(after.text),
        options: [
          {
            ...createTemplateOption(after.text, 100),
            html: after.html,
          },
        ],
      }

      commit('split_template_item', { templateId, itemId, optionId, patch, newItem }, (state) =>
        updateTemplate(state, templateId, (template) => {
          const items = splitTemplateItem(template.items, itemId, optionId, patch, newItem)
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

    patchTemplateOption(templateId: Id, itemId: Id, optionId: Id, patch: Partial<TemplateOption>) {
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
        isTextPatch ? { mergeKey: `template-option-text:${templateId}:${itemId}:${optionId}`, mergeWindowMs: TEXT_MERGE_WINDOW_MS } : {},
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
        const next = applyHistorySnapshot(state, entry.after, 'history_redo', entry)
        operationToPersist = next.operations.at(-1) ?? null
        return next
      })

      if (operationToPersist) queueOperationPersistence(operationToPersist)
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

function normalizeState(state: AppState): AppState {
  return {
    ...state,
    templates: state.templates.map((template) => ({
      ...template,
      items: normalizeTemplateItems(template.items),
    })),
    plans: state.plans.map((plan) => ({
      ...plan,
      dailyReminder: plan.dailyReminder ?? DEFAULT_DAILY_REMINDER,
      items: normalizePlanItems(plan.items),
    })),
  }
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
