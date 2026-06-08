export type Id = string

export type TemplateOption = {
  id: Id
  text: string
  html: string
  probability: number
}

export type TemplateItem = {
  id: Id
  startMinutes: number | null
  endMinutes: number | null
  options: TemplateOption[]
  children: TemplateItem[]
}

export type PlanItem = {
  id: Id
  text: string
  html: string
  done: boolean
  startMinutes: number | null
  endMinutes: number | null
  children: PlanItem[]
}

export type MovePlacement = 'before' | 'after' | 'inside'

export type MoveDirection = 'up' | 'down'

export type DailyPlan = {
  id: Id
  date: string
  title: string
  dailyReminder: string
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

export type GoalActivityPeriod = {
  startDate: string
  endDate: string | null
}

export type Goal = {
  id: Id
  name: string
  cadenceDays: number
  matchTerms: string[]
  hue: number
  neutral?: boolean
  activityPeriods: GoalActivityPeriod[]
  createdAt: string
  updatedAt: string
}

export type GoalCompletion = {
  goalId: Id
  date: string
  itemIds: Id[]
  matchedTerms: string[]
  computedAt: string
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
  historyRevision: number
  activePlanDate: string
  templates: DailyTemplate[]
  plans: DailyPlan[]
  goals: Goal[]
  goalCompletions: GoalCompletion[]
  operations: Operation[]
}
