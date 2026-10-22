// Synthetic Balance workspaces for Android emulator tests. Never user data.
import { syntheticState } from './android-sync-profile-helpers.mjs'

export function lifecycleFixture(count = 40) {
  const state = syntheticState()
  const day = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10)
  state.activePlanDate = day
  state.plans = [{ ...state.plans[0], id: 'lifecycle-plan', date: day,
    items: Array.from({ length: count }, (_, i) => ({ ...state.plans[0].items[0],
      id: `lifecycle-item-${i}`, text: `Synthetic lifecycle task ${i}`, html: `Synthetic lifecycle task ${i}`, done: false,
    })) }]
  return state
}

// A synthetic workspace with `days` of history, 20 tasks a day, and daily lists.
export function historyFixture(days) {
  const state = lifecycleFixture()
  const today = state.plans[0]
  for (let day = 1; day <= days; day++) {
    state.plans.push({...today, id: `history-plan-${day}`,
      date: new Date(Date.parse(today.date) - day * 86400000).toISOString().slice(0, 10),
      items: Array.from({length: 20}, (_, i) => ({...today.items[0],
        id: `history-item-${day}-${i}`, text: `Synthetic historical task ${day} ${i}`,
        html: `Synthetic <strong>historical</strong> task ${day} ${i}`, done: i % 3 === 0,
      })),
    })
  }
  state.listTemplates = [{id: 'history-list-template', name: 'Synthetic routine',
    maxExpectedWords: 0, archivedItems: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    items: today.items.map(item => ({...item, probability: 100})),
  }]
  state.lists = state.plans.map((plan, day) => ({id: `history-list-${day}`, date: plan.date,
    listTemplateId: 'history-list-template', createdAt: new Date().toISOString(),
    items: today.items.map((item, i) => ({...item, id: `history-list-item-${day}-${i}`,
      text: `Synthetic daily routine ${i}`, html: `Synthetic <em>daily routine</em> ${i}`})),
  }))
  state.ideaBuckets = [{id: 'history-bucket', kind: 'proposition', items:
    Array.from({length: 100}, (_, i) => ({...today.items[0], id: `history-idea-${i}`,
      text: `Synthetic saved idea ${i}`, html: `Synthetic saved idea ${i}`}))}]
  state.notes = Array.from({length: 50}, (_, i) => ({id: `history-note-${i}`,
    title: `Synthetic note ${i}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    items: Array.from({length: 20}, (_, j) => ({id: `history-note-${i}-${j}`, kind: 'paragraph',
      text: 'Synthetic paragraph for startup testing.', html: 'Synthetic paragraph for <em>startup testing</em>.', children: []})),
  }))
  return state
}
