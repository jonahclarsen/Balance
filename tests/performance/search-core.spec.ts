import { expect, test } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { createInitialState } from '../../src/lib/planner'
import { recoveryMatchesToSearchResults, searchBalanceState } from '../../src/lib/search'
import type { AppState } from '../../src/lib/types'

function fixture(): AppState {
  return { ...createInitialState(), plans: [], lists: [], templates: [], listTemplates: [], notes: [] }
}

function measure(scenario: string, run: () => unknown) {
  for (let index = 0; index < 3; index++) run()
  const samples: number[] = []
  for (let sample = 0; sample < 9; sample++) {
    const start = performance.now()
    for (let iteration = 0; iteration < 3; iteration++) run()
    samples.push((performance.now() - start) / 3)
  }
  samples.sort((a, b) => a - b)
  console.log(`PERF ${JSON.stringify({ scenario, medianMs: samples[Math.floor(samples.length / 2)] })}`)
}

for (const count of [5, 1000]) {
  test(`search saved dates ${count}`, () => {
    const state = fixture()
    state.plans = Array.from({ length: count }, (_, index) => ({
      id: `day-${index}`, date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
      title: 'Synthetic saved day', dailyReminder: 'needle', createdAt: '', generatedFromTemplateId: null, items: [],
    }))
    state.lists = state.plans.map((plan) => ({ id: `list-${plan.id}`, date: plan.date, listTemplateId: 'list', createdAt: '', items: [] }))
    state.listTemplates = [{
      id: 'list', name: 'needle', items: [], archivedItems: [], maxExpectedWords: 0, createdAt: '', updatedAt: '',
    }]
    expect(searchBalanceState(state, 'needle')).toHaveLength(count * 2 + 1)
    expect(searchBalanceState(state, 'absent')).toHaveLength(0)
    measure(`search-dates-${count}-match`, () => searchBalanceState(state, 'needle'))
    measure(`search-dates-${count}-miss`, () => searchBalanceState(state, 'absent'))
  })
}

for (const count of [4, 400]) {
  test(`search note versions ${count}`, () => {
    const state = fixture()
    state.notes = Array.from({ length: count }, (_, index) => ({
      id: `note-${index}`, title: 'needle', items: [],
      versionOf: index === 0 ? undefined : 'note-0',
      createdAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString(),
    }))
    const results = searchBalanceState(state, 'needle')
    expect(results).toHaveLength(count)
    expect(results[0].meta).toBe(`Note · V${count}`)
    expect(results.at(-1)?.meta).toBe('Note · V1')
    measure(`search-versions-${count}`, () => searchBalanceState(state, 'needle'))
  })
}

for (const count of [5, 500]) {
  test(`search recovery dates ${count}`, () => {
    const entries = Array.from({ length: count }, (_, index) => ({
      historyId: `entry-${index}`, operationType: 'patch_note_item', timestamp: null,
      createdAtMs: Date.UTC(2026, 0, 1, 0, index), preview: 'Synthetic earlier text',
    }))
    const results = recoveryMatchesToSearchResults(entries)
    expect(results).toHaveLength(count)
    expect(results[0].title).toBe('Earlier text')
    measure(`search-recovery-${count}`, () => recoveryMatchesToSearchResults(entries))
  })
}
