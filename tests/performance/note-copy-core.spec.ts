import { expect, test } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { copyNoteItemsWithNewIds } from '../../src/lib/noteVersions'
import type { NoteItem } from '../../src/lib/types'

function item(index: number, children: NoteItem[] = []): NoteItem {
  return {
    id: `item-${index}`, kind: 'paragraph', text: `Synthetic line ${index}`, html: `Synthetic line ${index}`,
    done: false, startMinutes: null, endMinutes: null, children,
  }
}

for (const [shape, count] of [['flat', 5], ['flat', 500], ['deep', 200]] as const) {
  test(`copy ${shape} note ${count}`, () => {
    let items: NoteItem[] = []
    if (shape === 'flat') items = Array.from({ length: count }, (_, index) => item(index))
    else for (let index = count - 1; index >= 0; index--) items = [item(index, items)]
    const before = structuredClone(items)
    const run = () => copyNoteItemsWithNewIds(items)
    const copy = run()
    const flatten = (entries: NoteItem[]): NoteItem[] => entries.flatMap((entry) => [entry, ...flatten(entry.children)])
    const copied = flatten(copy)
    expect(copied).toHaveLength(count)
    expect(new Set(copied.map((entry) => entry.id)).size).toBe(count)
    expect(copied.map((entry) => entry.text)).toEqual(flatten(items).map((entry) => entry.text))
    for (let index = 0; index < 3; index++) run()
    const samples: number[] = []
    for (let sample = 0; sample < 9; sample++) {
      const start = performance.now()
      for (let iteration = 0; iteration < 3; iteration++) run()
      samples.push((performance.now() - start) / 3)
    }
    samples.sort((a, b) => a - b)
    console.log(`PERF ${JSON.stringify({
      scenario: `note-copy-${shape}-${count}`, medianMs: samples[Math.floor(samples.length / 2)],
    })}`)
    expect(items).toEqual(before)
  })
}
