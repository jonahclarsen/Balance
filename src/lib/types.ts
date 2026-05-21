export type Id = string

export type TemplateOption = {
  id: Id
  text: string
  probability: number
}

export type TemplateItem = {
  id: Id
  options: TemplateOption[]
  children: TemplateItem[]
}

export type PlanItem = {
  id: Id
  text: string
  done: boolean
  startMinutes: number | null
  endMinutes: number | null
  children: PlanItem[]
}

export type MovePlacement = 'before' | 'after' | 'inside'

export type DailyPlan = {
  id: Id
  date: string
  title: string
  generatedFromTemplateId: Id | null
  createdAt: string
  items: PlanItem[]
}

export type DailyTemplate = {
  id: Id
  name: string
  items: TemplateItem[]
  createdAt: string
  updatedAt: string
}

export type Operation = {
  id: Id
  deviceId: Id
  sequence: number
  type: string
  timestamp: string
  payload: unknown
}

export type AppState = {
  schemaVersion: 1
  deviceId: Id
  localSequence: number
  activePlanDate: string
  templates: DailyTemplate[]
  plans: DailyPlan[]
  operations: Operation[]
}
