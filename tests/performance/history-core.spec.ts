import { expect, test } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { createInitialState } from '../../src/lib/planner'
import { historyDestination } from '../../src/lib/historyNavigation'
import type { AppState } from '../../src/lib/types'

for (const count of [3, 500]) {
  for (const position of ['first', 'last', 'removed'] as const) {
    test(`history destination ${count} notes ${position}`, () => {
      const before: AppState = {
        ...createInitialState(), plans: [], lists: [], listTemplates: [], templates: [],
        notes: Array.from({ length: count }, (_, index) => ({
          id: `note-${index}`, title: 'Synthetic note', createdAt: '', updatedAt: '',
          items: Array.from({ length: 20 }, (_, row) => ({
            id: `row-${index}-${row}`, kind: 'paragraph', text: `Synthetic text ${row}`, html: '',
            done: false, startMinutes: null, endMinutes: null, children: [],
          })),
        })),
      }
      // Native undo/reload produces equal values with fresh object identities.
      const after = structuredClone(before)
      const target = position === 'last' ? count - 1 : 0
      if (position === 'removed') after.notes[0].items = []
      else after.notes[target].items[0].text = 'Changed text'
      expect(historyDestination(before, after)).toMatchObject({
        view: 'notes', entityId: `note-${target}`, removed: position === 'removed',
        itemId: position === 'removed' ? undefined : `row-${target}-0`,
      })
      const run = () => historyDestination(before, after)
      // Three calls left the short cases measuring JIT compilation instead of
      // steady work. Give both revisions enough time and calls to warm up.
      const warmupStart = performance.now()
      let warmupIterations = 0
      do {
        run()
        warmupIterations++
      } while (warmupIterations < 100 || performance.now() - warmupStart < 300)
      const samples: number[] = []
      for (let sample = 0; sample < 9; sample++) {
        const start = performance.now()
        let iterations = 0
        let elapsed = 0
        do {
          run()
          iterations++
          elapsed = performance.now() - start
        } while (elapsed < 80)
        samples.push(elapsed / iterations)
      }
      samples.sort((a, b) => a - b)
      console.log(`PERF ${JSON.stringify({
        scenario: `history-notes-${count}-${position}`, medianMs: samples[Math.floor(samples.length / 2)],
        minMs: samples[0], maxMs: samples.at(-1), warmupIterations,
      })}`)
    })
  }
}
