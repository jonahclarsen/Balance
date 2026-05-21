import type {
  AppState,
  DailyPlan,
  DailyTemplate,
  Id,
  MoveDirection,
  MovePlacement,
  PlanItem,
  TemplateItem,
  TemplateOption,
} from './types'

export function createId(prefix = 'id'): Id {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`
  }

  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
}

export function todayISO(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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

export function createInitialState(): AppState {
  return {
    schemaVersion: 1,
    deviceId: createId('device'),
    localSequence: 0,
    activePlanDate: todayISO(),
    templates: [createDefaultTemplate()],
    plans: [],
    operations: [],
  }
}

export function createTemplateOption(text = '', probability = 100): TemplateOption {
  return {
    id: createId('option'),
    text,
    probability,
  }
}

export function createTemplateItem(text = ''): TemplateItem {
  return {
    id: createId('template_item'),
    options: [createTemplateOption(text, 100)],
    children: [],
  }
}

export function createPlanItem(text = ''): PlanItem {
  return {
    id: createId('plan_item'),
    text,
    done: false,
    startMinutes: null,
    endMinutes: null,
    children: [],
  }
}

export function generatePlanFromTemplate(template: DailyTemplate, date: string): DailyPlan {
  return {
    id: createId('plan'),
    date,
    title: formatPlanTitle(date),
    generatedFromTemplateId: template.id,
    createdAt: nowISO(),
    items: generatePlanItems(template.items),
  }
}

function generatePlanItems(items: TemplateItem[]): PlanItem[] {
  return items.flatMap((item) => {
    const option = pickOption(item.options)
    if (!option || option.text.trim() === '(skip)') {
      return []
    }

    return [
      {
        ...createPlanItem(option.text),
        children: generatePlanItems(item.children),
      },
    ]
  })
}

function pickOption(options: TemplateOption[]): TemplateOption | null {
  if (options.length === 0) return null
  if (options.length === 1) return options[0]

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
  return items.map((item) => {
    if (item.id === itemId) return updater(item)
    return {
      ...item,
      children: updatePlanItem(item.children, itemId, updater),
    }
  })
}

export function addPlanItem(items: PlanItem[], parentId: Id | null, item = createPlanItem()): PlanItem[] {
  if (!parentId) return [...items, item]

  return updatePlanItem(items, parentId, (parent) => ({
    ...parent,
    children: [...parent.children, item],
  }))
}

export function deletePlanItem(items: PlanItem[], itemId: Id): PlanItem[] {
  return items
    .filter((item) => item.id !== itemId)
    .map((item) => ({
      ...item,
      children: deletePlanItem(item.children, itemId),
    }))
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

function findPlanItem(items: PlanItem[], itemId: Id): PlanItem | null {
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
  return items.map((item) => {
    if (item.id === itemId) return updater(item)
    return {
      ...item,
      children: updateTemplateItem(item.children, itemId, updater),
    }
  })
}

export function addTemplateItem(items: TemplateItem[], parentId: Id | null, item = createTemplateItem()): TemplateItem[] {
  if (!parentId) return [...items, item]

  return updateTemplateItem(items, parentId, (parent) => ({
    ...parent,
    children: [...parent.children, item],
  }))
}

export function deleteTemplateItem(items: TemplateItem[], itemId: Id): TemplateItem[] {
  return items
    .filter((item) => item.id !== itemId)
    .map((item) => ({
      ...item,
      children: deleteTemplateItem(item.children, itemId),
    }))
}

export function formatMinutes(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440
  const hours = Math.floor(normalized / 60)
  const mins = normalized % 60
  const suffix = hours >= 12 ? 'pm' : 'am'
  const hour12 = hours % 12 || 12
  return mins === 0 ? `${hour12}${suffix}` : `${hour12}:${String(mins).padStart(2, '0')}${suffix}`
}

export function clampMinutes(minutes: number): number {
  return Math.max(0, Math.min(1439, minutes))
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
