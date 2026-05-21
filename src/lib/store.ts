import { writable } from 'svelte/store'
import {
  addPlanItem,
  addTemplateItem,
  createInitialState,
  createPlanItem,
  createTemplateItem,
  createTemplateOption,
  deletePlanItem,
  deleteTemplateItem,
  escapeHTML,
  formatMinutes,
  generatePlanFromTemplate,
  movePlanItem,
  movePlanItemWithinLevel,
  nowISO,
  todayISO,
  updatePlanItem,
  updateTemplateItem,
} from './planner'
import type { AppState, DailyPlan, Id, PlanItem, TemplateItem, TemplateOption } from './types'

const STORAGE_KEY = 'balance.appState.v1'

type Mutator = (state: AppState) => AppState

function readState(): AppState {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return createInitialState()

  try {
    const parsed = JSON.parse(raw) as AppState
    if (parsed.schemaVersion !== 1) return createInitialState()
    return {
      ...parsed,
      activePlanDate: parsed.activePlanDate || todayISO(),
      operations: parsed.operations || [],
    }
  } catch {
    return createInitialState()
  }
}

function persistState(state: AppState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function createPlannerStore() {
  const store = writable<AppState>(readState())
  store.subscribe(persistState)

  function commit(type: string, payload: unknown, mutate: Mutator): void {
    store.update((state) => {
      const next = mutate(state)
      const sequence = state.localSequence + 1

      return {
        ...next,
        localSequence: sequence,
        operations: [
          ...next.operations,
          {
            id: `op_${state.deviceId}_${sequence}`,
            deviceId: state.deviceId,
            sequence,
            type,
            timestamp: nowISO(),
            payload,
          },
        ],
      }
    })
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
      commit('generate_plan', { templateId, date, replaceExisting }, (state) => {
        const template = state.templates.find((candidate) => candidate.id === templateId)
        if (!template) return state

        const generated = generatePlanFromTemplate(template, date)
        const plans = replaceExisting ? state.plans.filter((plan) => plan.date !== date) : state.plans

        return {
          ...state,
          activePlanDate: date,
          plans: [...plans, generated].sort((a, b) => b.date.localeCompare(a.date)),
        }
      })
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
      commit('patch_plan_item', { planId, itemId, patch }, (state) => updatePlan(state, planId, (plan) => ({
        ...plan,
        items: updatePlanItem(plan.items, itemId, (item) => ({ ...item, ...patch })),
      })))
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

    deleteTemplateItem(templateId: Id, itemId: Id) {
      commit('delete_template_item', { templateId, itemId }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: deleteTemplateItem(template.items, itemId),
        })),
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
      commit('patch_template_option', { templateId, itemId, optionId, patch }, (state) =>
        updateTemplate(state, templateId, (template) => ({
          ...template,
          updatedAt: nowISO(),
          items: updateTemplateItem(template.items, itemId, (item) => ({
            ...item,
            options: item.options.map((option) => (option.id === optionId ? { ...option, ...patch } : option)),
          })),
        })),
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
  }
}

function updatePlan(state: AppState, planId: Id, updater: (plan: DailyPlan) => DailyPlan): AppState {
  return {
    ...state,
    plans: state.plans.map((plan) => (plan.id === planId ? updater(plan) : plan)),
  }
}

function updateTemplate(state: AppState, templateId: Id, updater: (template: AppState['templates'][number]) => AppState['templates'][number]): AppState {
  return {
    ...state,
    templates: state.templates.map((template) => (template.id === templateId ? updater(template) : template)),
  }
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
      const text = `<span class="${item.done ? 'done' : ''}">${item.done ? '[x]' : '[ ]'} ${time}${escapeHTML(item.text)}</span>`
      return `<li>${text}${item.children.length > 0 ? renderItems(item.children) : ''}</li>`
    })
    .join('')}</ul>`
}

export const plannerStore = createPlannerStore()
