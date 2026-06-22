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

// A list-template item has no competing options; it carries a single appearance
// probability (50-100) = the chance it shows up in a generated list instance.
export type ListTemplateItem = {
  id: Id
  text: string
  html: string
  probability: number
  children: ListTemplateItem[]
}

export type ListTemplate = {
  id: Id
  name: string
  // Cap on the probability-weighted "expected word count" of the whole list.
  // 0 means unlimited.
  maxExpectedWords: number
  items: ListTemplateItem[]
  createdAt: string
  updatedAt: string
}

// A per-day generated checklist. Reuses PlanItem so it renders through the same
// PlanItemEditor and planner tree functions as daily plans.
export type ListInstance = {
  id: Id
  date: string
  listTemplateId: Id
  createdAt: string
  items: PlanItem[]
}

export type MetricQuestionType = 'text' | 'boolean'

export type MetricQuestion = {
  id: Id
  prompt: string
  html: string
  type: MetricQuestionType
}

export type Metric = {
  id: Id
  name: string
  questions: MetricQuestion[]
  createdAt: string
  updatedAt: string
}

export type MetricAnswer = {
  questionId: Id
  // Booleans stored as 'y' | 'n'; text/number answers stored verbatim.
  value: string
}

// One filled-out instance of a metric, stored relative to the day it was taken.
export type MetricEntry = {
  id: Id
  metricId: Id
  date: string
  answers: MetricAnswer[]
  createdAt: string
  updatedAt: string
}

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
  // 0–100 lightness control; 50 is the neutral baseline (no shift from the
  // designed colors). Renders as a ±25pp shift applied to every goal color.
  lightness: number
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
  listTemplates: ListTemplate[]
  lists: ListInstance[]
  metrics: Metric[]
  metricEntries: MetricEntry[]
  goals: Goal[]
  goalCompletions: GoalCompletion[]
  operations: Operation[]
}
