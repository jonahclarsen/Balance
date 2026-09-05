import type { CompletionCelebrationId } from './celebrations'

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
  timeHidden?: boolean | null
  options: TemplateOption[]
  children: TemplateItem[]
}

export type PlanItem = {
  id: Id
  text: string
  html: string
  done: boolean
  // Set when an "n goals" day-template row expands into this item. Keeping the
  // source on the item lets checking it complete the intended goal even when
  // the goal name does not contain one of its matching terms.
  generatedGoalId?: Id
  startMinutes: number | null
  endMinutes: number | null
  timeHidden?: boolean | null
  children: PlanItem[]
}

export type NoteItemKind = 'paragraph' | 'heading' | 'bullet' | 'numbered' | 'checklist'

// Notes intentionally reuse the plan-item text/HTML/tree shape. That keeps
// rich-text editing, splitting, indentation, and tree movement on the same
// code paths as plans and templates while adding only a presentation kind.
export type NoteItem = PlanItem & {
  kind: NoteItemKind
  children: NoteItem[]
}

export type Note = {
  id: Id
  title: string
  items: NoteItem[]
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
}

export type NoteViewState = {
  scrollTop: number
  caret: {
    itemId: Id
    start: number
    end: number
  } | null
}

export type MovePlacement = 'before' | 'after' | 'inside'

export type MoveDirection = 'up' | 'down'

// A list-template item has no competing options; it carries a single appearance
// probability (10-100) = the chance it shows up in a generated list instance.
export type ListTemplateItem = {
  id: Id
  text: string
  html: string
  probability: number
  children: ListTemplateItem[]
}

export type ArchivedListTemplateItem = {
  id: Id
  item: ListTemplateItem
  parentId: Id | null
  position: number
  archivedAt: string
  // Keep the calendar day recorded on the deleting device. Deriving this from
  // archivedAt on another device could move the deletion to an adjacent day.
  archivedDate: string
}

export type ListTemplate = {
  id: Id
  name: string
  // Cap on the probability-weighted "expected word count" of the whole list,
  // including the conditional probability of every item's ancestors.
  // 0 means unlimited.
  maxExpectedWords: number
  items: ListTemplateItem[]
  archivedItems: ArchivedListTemplateItem[]
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

export type MetricQuestionType = 'text' | 'number' | 'boolean'

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
  // Booleans are stored as 'y' | 'n'; text and number answers are stored verbatim.
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
  // Goal IDs presented by an "n goals" expansion. This plan-level snapshot
  // survives item edits/deletion and is used to count skipped presentation days.
  generatedGoalIds?: Id[]
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

export type GoalCadencePeriod = {
  startDate: string
  cadenceDays: number
}

export type Goal = {
  id: Id
  name: string
  nameHtml: string
  cadenceDays: number
  matchTerms: string[]
  matchTermsHtml: string
  hue: number
  // 0–100 lightness control; 50 is the neutral baseline (no shift from the
  // designed colors). Renders as a ±25pp shift applied to every goal color.
  lightness: number
  activityPeriods: GoalActivityPeriod[]
  // Optional so states written before cadence history remain valid. Normalized
  // and newly created goals always populate it.
  cadenceHistory?: GoalCadencePeriod[]
  // Missing on pre-feature goals. The first template generation gives legacy
  // overdue goals one review, then future reviews use tracked presentations.
  presentationTrackingStartedAt?: string
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

export type ReplicatedPreferences = {
  // Legacy appearance fields stay in the replicated envelope so older app
  // versions can replay checkpoints. Current builds migrate them once and then
  // use DeviceAppearancePreferences instead.
  themeId: string
  randomThemeId: string
  randomThemeDate: string
  randomThemeStartDate: string
  completionCelebrationId: CompletionCelebrationId
  doneTintColor: string
  checkboxColor: string
  databaseLoadingMessages: string[]
  iridescentGradient: IridescentGradientPreferences
}

export type DeviceAppearancePreferences = {
  version: 1
  colorScheme: ColorSchemePreference
  themeId: string
  randomThemeStartDate: string
  doneTintColor: string
  checkboxColor: string
  iridescentGradient: IridescentGradientPreferences
}

export type ColorSchemePreference = 'system' | 'light' | 'dark'

export type IridescentGradientColor = {
  hue: number
  saturation: number
  lightness: number
  strength: number
}

export type IridescentGradientPreferences = {
  contrast: number
  backgroundSaturation: number
  backgroundLightness: number
  angle: number
  reach: number
  colors: [IridescentGradientColor, IridescentGradientColor, IridescentGradientColor]
}

export type AppState = {
  schemaVersion: 1
  deviceId: Id
  localSequence: number
  historyRevision: number
  // Device-local navigation; the legacy persisted/wire field is ignored.
  activePlanDate: string
  preferences: ReplicatedPreferences
  templates: DailyTemplate[]
  plans: DailyPlan[]
  listTemplates: ListTemplate[]
  lists: ListInstance[]
  metrics: Metric[]
  metricEntries: MetricEntry[]
  notes: Note[]
  goals: Goal[]
  goalCompletions: GoalCompletion[]
  operations: Operation[]
}
