import { expect, test } from '@playwright/test'
import {
  createGoal,
  goalsNeedingDoabilityReview,
  reconcileGoalCompletionsForDate,
} from '../../src/lib/goals'
import {
  createDailyTemplate,
  createInitialState,
  createTemplateItem,
  generatePlanFromTemplate,
} from '../../src/lib/planner'
import type { DailyPlan, Goal, GoalCompletion } from '../../src/lib/types'

const CURRENT_DATE = '2026-08-31'
const TIMESTAMP = '2026-08-01T12:00:00.000Z'

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal_creative',
    name: 'Make art',
    nameHtml: 'Make art',
    cadenceDays: 1,
    matchTerms: ['photoshop'],
    matchTermsHtml: 'photoshop',
    hue: 190,
    lightness: 50,
    activityPeriods: [{ startDate: '2026-08-01', endDate: null }],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  }
}

function presentedPlan(date: string, goalId = 'goal_creative'): DailyPlan {
  return {
    id: `plan_${date}`,
    date,
    title: date,
    dailyReminder: '',
    generatedFromTemplateId: 'template_goals',
    generatedGoalIds: [goalId],
    createdAt: `${date}T08:00:00.000Z`,
    items: [],
  }
}

function completion(date: string): GoalCompletion {
  return {
    goalId: 'goal_creative',
    date,
    itemIds: [`item_${date}`],
    matchedTerms: ['photoshop'],
    computedAt: `${date}T12:00:00.000Z`,
  }
}

test('legacy goals use overdue calendar days until presentation tracking starts', () => {
  const reviews = goalsNeedingDoabilityReview([goal()], [], [], CURRENT_DATE)

  expect(reviews).toEqual([
    expect.objectContaining({ days: 30, reason: 'legacy-overdue' }),
  ])
})

test('existing overdue goals keep the legacy fallback until tracked history has a completion baseline', () => {
  const existingGoal = goal({
    presentationTrackingStartedAt: '2026-08-25T08:00:00.000Z',
  })
  const plans = [
    presentedPlan('2026-08-25'),
    presentedPlan('2026-08-26'),
    presentedPlan('2026-08-27'),
  ]

  expect(goalsNeedingDoabilityReview([existingGoal], [], plans, CURRENT_DATE)).toEqual([
    expect.objectContaining({ days: 30, reason: 'legacy-overdue' }),
  ])
  expect(goalsNeedingDoabilityReview(
    [existingGoal],
    [completion('2026-08-27')],
    [...plans, presentedPlan('2026-08-28'), presentedPlan('2026-08-29')],
    CURRENT_DATE,
  )).toEqual([])
})

test('tracked goals appear after four distinct missed presentation days', () => {
  const trackedGoal = goal({ presentationTrackingStartedAt: TIMESTAMP })
  const plans = [
    presentedPlan('2026-08-25'),
    presentedPlan('2026-08-26'),
    presentedPlan('2026-08-27'),
    presentedPlan('2026-08-28'),
    presentedPlan(CURRENT_DATE),
  ]

  expect(goalsNeedingDoabilityReview([trackedGoal], [], plans.slice(0, 3), CURRENT_DATE)).toEqual([])
  expect(goalsNeedingDoabilityReview([trackedGoal], [], plans, CURRENT_DATE)).toEqual([
    expect.objectContaining({ days: 4, reason: 'missed-presentations' }),
  ])
})

test('a completion resets earlier missed presentation days, including when completed today', () => {
  const trackedGoal = goal({ presentationTrackingStartedAt: TIMESTAMP })
  const plans = [
    presentedPlan('2026-08-25'),
    presentedPlan('2026-08-26'),
    presentedPlan('2026-08-27'),
    presentedPlan('2026-08-28'),
  ]

  expect(goalsNeedingDoabilityReview([trackedGoal], [completion(CURRENT_DATE)], plans, CURRENT_DATE)).toEqual([])
})

test('goal template expansion records provenance and checking the row completes its source goal', () => {
  const sourceGoal = goal({ cadenceDays: 3, activityPeriods: [{ startDate: CURRENT_DATE, endDate: null }] })
  const template = {
    ...createDailyTemplate('Goals'),
    id: 'template_goals',
    items: [createTemplateItem('1 goals')],
  }
  const generated = generatePlanFromTemplate(template, CURRENT_DATE, '', [sourceGoal], [])

  expect(generated.generatedGoalIds).toEqual([sourceGoal.id])
  expect(generated.items[0]).toEqual(expect.objectContaining({
    text: sourceGoal.name,
    generatedGoalId: sourceGoal.id,
  }))

  generated.items[0].done = true
  const state = {
    ...createInitialState(),
    plans: [generated],
    goals: [sourceGoal],
  }
  const completions = reconcileGoalCompletionsForDate(state, CURRENT_DATE, { force: true })

  expect(completions).toEqual([
    expect.objectContaining({ goalId: sourceGoal.id, itemIds: [generated.items[0].id] }),
  ])
})

test('new goals start with presentation tracking enabled', () => {
  const newGoal = goal()
  const created = createGoal(
    newGoal.name,
    newGoal.cadenceDays,
    newGoal.matchTerms,
    newGoal.hue,
    newGoal.lightness,
    CURRENT_DATE,
    newGoal.id,
  )

  expect(created.presentationTrackingStartedAt).toBe(created.createdAt)
})
