// A synthetic workspace for website and docs screenshots. Every name, task and
// answer here is invented; never replace it with real planner data.
import {
  createInitialState,
  createListTemplate,
  createListTemplateItem,
  createListTemplateItemAlternative,
  createMetric,
  createMetricEntry,
  createMetricQuestion,
  createNote,
  createNoteItem,
  createPlanItem,
  createTemplateItem,
  createTemplateOption,
  createId,
  formatPlanTitle,
  generateListFromTemplate,
  shiftCalendarDateISO,
} from '../../src/lib/planner'
import { createGoal, reconcileGoalCompletionsForDate } from '../../src/lib/goals'
import type { AppState, DailyTemplate, NoteItem, NoteItemKind, PlanItem, TemplateItem } from '../../src/lib/types'

// Deterministic so reruns produce the same pictures.
function random(seed: number) {
  let value = seed
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296
    return value / 4294967296
  }
}

function time(hours: number, minutes = 0) {
  return hours * 60 + minutes
}

function task(text: string, done = false, range?: [number, number], children: PlanItem[] = []): PlanItem {
  return {
    ...createPlanItem(text),
    done,
    startMinutes: range?.[0] ?? null,
    endMinutes: range?.[1] ?? null,
    children,
  }
}

function templateRow(options: Array<[string, number]>, range?: [number, number], children: TemplateItem[] = []): TemplateItem {
  return {
    ...createTemplateItem(),
    startMinutes: range?.[0] ?? null,
    endMinutes: range?.[1] ?? null,
    options: options.map(([text, probability]) => createTemplateOption(text, probability)),
    children,
  }
}

function noteLine(text: string, kind: NoteItemKind = 'paragraph', done = false, children: NoteItem[] = []): NoteItem {
  return { ...createNoteItem(text, kind), done, children }
}

function weekdayTemplate(): DailyTemplate {
  const now = new Date().toISOString()
  return {
    id: createId('template'),
    name: 'Weekday',
    createdAt: now,
    updatedAt: now,
    items: [
      templateRow([['Wake up, glass of water', 100]], [time(7), time(7, 15)]),
      templateRow([['Run 5k', 40], ['Swim', 30], ['Yoga', 30]], [time(7, 30), time(8, 15)]),
      templateRow([['Breakfast and journal', 100]]),
      templateRow([['Deep work', 100]], [time(9), time(12)], [
        templateRow([['Pick the hardest task first', 100]]),
        templateRow([['Phone in another room', 100]]),
      ]),
      templateRow([['Lunch walk', 70], ['Lunch with a friend', 30]], [time(12, 30), time(13, 15)]),
      templateRow([['2 goals', 100]]),
      templateRow([['Admin and email', 100]], [time(14), time(15)]),
      templateRow([['Read 20 pages', 80]]),
      templateRow([['Cook dinner', 60], ['Leftovers', 40]], [time(18, 30), time(19, 30)]),
      templateRow([['Evening reset', 100]], [time(21, 30), time(22)]),
    ],
  }
}

function weekendTemplate(): DailyTemplate {
  const now = new Date().toISOString()
  return {
    id: createId('template'),
    name: 'Weekend',
    createdAt: now,
    updatedAt: now,
    items: [
      templateRow([['Slow breakfast', 100]]),
      templateRow([['Long run', 50], ['Bike ride', 50]], [time(9), time(10, 30)]),
      templateRow([['Farmers market', 60]]),
      templateRow([['3 goals', 100]]),
      templateRow([['Call family', 50]]),
    ],
  }
}

export function createScreenshotState(today: string): AppState {
  const state = createInitialState()
  const roll = random(42)
  const weekday = weekdayTemplate()
  const weekend = weekendTemplate()
  state.templates = [weekday, weekend]
  state.activePlanDate = today

  const start = shiftCalendarDateISO(today, -120)
  const goal = (name: string, cadence: number, terms: string[], hue: number) =>
    createGoal(name, cadence, terms, hue, 50, start, createId('goal'))
  state.goals = [
    goal('Exercise', 2, ['run', 'swim', 'yoga', 'bike'], 160),
    goal('Read', 1, ['read'], 275),
    goal('Practice piano', 3, ['piano'], 330),
    goal('Call family', 7, ['call'], 30),
    goal('Meditate', 2, ['meditate'], 200),
    goal('Deep clean', 14, ['clean'], 95),
  ]

  // Past days: varied, mostly finished plans so Goal Rhythm has history.
  const pastTasks: Array<[string, number]> = [
    ['Run 5k', 0.45], ['Yoga', 0.2], ['Swim', 0.15], ['Read 20 pages', 0.8],
    ['Practice piano', 0.4], ['Meditate 10 min', 0.55], ['Call Grandma', 0.12],
    ['Clean the kitchen', 0.08], ['Deep work', 0.9], ['Admin and email', 0.7],
  ]
  for (let offset = -110; offset < 0; offset += 1) {
    const date = shiftCalendarDateISO(today, offset)
    const items = pastTasks
      .filter(([, chance]) => roll() < chance)
      .map(([text]) => task(text, roll() < 0.88))
    state.plans.push({
      id: createId('plan'),
      date,
      title: formatPlanTitle(date),
      dailyReminder: 'This shouldn’t be aspirational',
      generatedFromTemplateId: weekday.id,
      createdAt: new Date().toISOString(),
      items,
    })
  }

  state.plans.push({
    id: createId('plan'),
    date: today,
    title: formatPlanTitle(today),
    dailyReminder: 'This shouldn’t be aspirational',
    generatedFromTemplateId: weekday.id,
    createdAt: new Date().toISOString(),
    items: [
      task('Wake up, glass of water', true, [time(7), time(7, 15)]),
      task('Run 5k', true, [time(7, 30), time(8, 15)]),
      task('Breakfast and journal', true),
      task('Deep work', true, [time(9), time(12)], [
        task('Draft the garden plan', true),
        task('Review chapter two edits', true),
      ]),
      task('Lunch walk', true, [time(12, 30), time(13, 15)]),
      task('Practice piano', false),
      task('Meditate 10 min', true),
      task('Admin and email', false, [time(14), time(15)], [
        task('Renew library card', true),
        task('Reply to Sam about Saturday', false),
      ]),
      task('Groceries', false, undefined, [
        task('Oats', false),
        task('Spinach', false),
        task('Lemons', false),
      ]),
      task('Read 20 pages', false),
      task('Cook dinner', false, [time(18, 30), time(19, 30)]),
      task('Evening reset', false, [time(21, 30), time(22)]),
    ],
  })

  for (const plan of state.plans) {
    state.goalCompletions = reconcileGoalCompletionsForDate(state, plan.date, { force: true })
  }

  const evening = createListTemplate('Evening reset')
  const stretch = createListTemplateItem('Stretch for five minutes')
  stretch.alternatives = [createListTemplateItemAlternative('Foam roll', 40)]
  evening.items = [
    createListTemplateItem('Tidy desk'),
    createListTemplateItem('Lay out tomorrow’s clothes'),
    createListTemplateItem('Write tomorrow’s first task'),
    { ...createListTemplateItem('Phone on the charger outside the bedroom'), probability: 90 },
    stretch,
  ]
  const packing = createListTemplate('Weekend trip packing')
  packing.items = [
    { ...createListTemplateItem('Clothes'), children: [createListTemplateItem('Rain jacket'), createListTemplateItem('Hiking socks')] },
    createListTemplateItem('Chargers'),
    createListTemplateItem('Water bottle'),
    { ...createListTemplateItem('Book'), probability: 70 },
  ]
  state.listTemplates = [evening, packing]
  const eveningToday = generateListFromTemplate(evening, today)
  eveningToday.items = eveningToday.items.map((item, index) => ({ ...item, done: index < 2 }))
  state.lists = [eveningToday]

  const checkIn = createMetric('Daily check-in')
  checkIn.questions = [
    createMetricQuestion('Hours of sleep', 'number'),
    createMetricQuestion('Energy, 1 to 10', 'number'),
    createMetricQuestion('Went outside?', 'boolean'),
    createMetricQuestion('One good thing', 'text'),
  ]
  state.metrics = [checkIn]
  const goodThings = ['Sunny lunch walk', 'Finished a chapter', 'Great soup', 'Long call with Grandma', 'New piano piece clicked', 'Quiet morning']
  for (let offset = -40; offset <= 0; offset += 1) {
    if (roll() < 0.15) continue
    const entry = createMetricEntry(checkIn.id, shiftCalendarDateISO(today, offset))
    const sleep = 6 + Math.round(roll() * 4 * 2) / 2
    entry.answers = [
      { questionId: checkIn.questions[0].id, value: String(sleep) },
      { questionId: checkIn.questions[1].id, value: String(Math.min(10, Math.max(3, Math.round(sleep - 1 + roll() * 3)))) },
      { questionId: checkIn.questions[2].id, value: roll() < 0.75 ? 'y' : 'n' },
      { questionId: checkIn.questions[3].id, value: goodThings[Math.floor(roll() * goodThings.length)] },
    ]
    state.metricEntries.push(entry)
  }

  const project = (name: string, description: string, color: string) => {
    const now = new Date().toISOString()
    return { id: createId('project'), name, description, color, archived: false, createdAt: now, updatedAt: now }
  }
  state.projects = [
    project('Learn piano', 'Play three pieces from memory by spring.', '#7b5bd6'),
    project('Garden redesign', 'Native plants and a small vegetable bed.', '#46b887'),
    project('Short story', 'Finish a 5,000-word draft.', '#f0a23e'),
  ]
  for (const [index, item] of state.projects.entries()) {
    let progress = 5 + index * 8
    for (let week = 10; week >= 0; week -= 1) {
      progress = Math.min(95, progress + Math.round(roll() * 9))
      const createdAt = new Date(`${shiftCalendarDateISO(today, -week * 7)}T18:00:00`).toISOString()
      state.projectCheckIns.push({
        id: createId('project_check_in'),
        projectId: item.id,
        progress,
        heart: Math.round(55 + roll() * 40),
        createdAt,
      })
    }
  }

  const ideas = (texts: string[]) => texts.map((text) => ({ ...createPlanItem(text), bucketedAt: new Date().toISOString() }))
  state.ideaBuckets = [
    { id: 'bucket_proposition', kind: 'proposition', items: ideas(['Learn to bake sourdough', 'Start a book club', 'Build a bird feeder']) },
    { id: 'bucket_genuine', kind: 'genuine', items: ideas(['Plan a camping weekend', 'Take a pottery class']) },
    { id: 'bucket_possible', kind: 'possible', items: ideas(['Learn Spanish', 'Run a half marathon']) },
    { id: 'bucket_afterlife', kind: 'afterlife', items: ideas(['Start a podcast']) },
    { id: 'bucket_trash', kind: 'trash', items: [] },
  ]

  const priorityNow = new Date().toISOString()
  state.prioritySessions = [{
    id: createId('priority_session'),
    createdAt: priorityNow,
    updatedAt: priorityNow,
    items: [
      { id: createId('priority'), text: 'Finish the short story draft', priority: 9 },
      { id: createId('priority'), text: 'Plant the vegetable bed', priority: 7 },
      { id: createId('priority'), text: 'Learn the second piano piece', priority: 6 },
      { id: createId('priority'), text: 'Sort the garage', priority: 3 },
      { id: createId('priority'), text: 'Repaint the fence' },
    ],
  }]

  const trip = createNote('Camping weekend')
  trip.items = [
    noteLine('Campsite', 'heading'),
    noteLine('Lakeside site, two nights. Arrive before sunset.'),
    noteLine('Bring', 'heading'),
    noteLine('Tent and footprint', 'checklist', true),
    noteLine('Sleeping bags', 'checklist', true),
    noteLine('Camp stove', 'checklist'),
    noteLine('Headlamps', 'checklist'),
    noteLine('Meals', 'heading'),
    noteLine('Friday: pasta', 'bullet'),
    noteLine('Saturday: tacos', 'bullet', false, [noteLine('Tortillas, beans, salsa', 'bullet')]),
    noteLine('Leave no trace.', 'quote'),
  ]
  const reading = createNote('Reading list')
  reading.items = [
    noteLine('Now', 'heading'),
    noteLine('The Overstory', 'numbered'),
    noteLine('Next', 'heading'),
    noteLine('Braiding Sweetgrass', 'numbered'),
    noteLine('Four Thousand Weeks', 'numbered'),
  ]
  state.notes = [trip, reading]

  return state
}
