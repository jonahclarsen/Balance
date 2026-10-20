import { expect, test } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import {
  backspaceListTemplateItemAtStart,
  backspacePlanItemAtStart,
  backspaceTemplateOptionAtStart,
  copyPlanItems,
  defaultPlanItemTimeRange,
  indentPlanItems,
} from '../../src/lib/planner'
import type { PlanItem, TemplateOption } from '../../src/lib/types'

type Item = PlanItem & {
  probability: number
  options: TemplateOption[]
  children: Item[]
}

function item(id: string, children: Item[] = []): Item {
  return {
    id, text: id, html: id, done: false, startMinutes: null, endMinutes: null,
    probability: 100,
    options: [{ id: `${id}-option`, text: id, html: id, probability: 100 }],
    children,
  }
}

function spine(depth: number, leaves: Item[]): Item[] {
  let items = leaves
  for (let level = 0; level < depth; level += 1) items = [item(`parent-${level}`, items)]
  return items
}

function measure(operation: () => unknown, iterations = 10): { medianMs: number; samplesMs: number[] } {
  for (let index = 0; index < 3; index += 1) operation()
  const samplesMs: number[] = []
  for (let sample = 0; sample < 7; sample += 1) {
    const started = performance.now()
    for (let index = 0; index < iterations; index += 1) operation()
    samplesMs.push((performance.now() - started) / iterations)
  }
  return { medianMs: [...samplesMs].sort((a, b) => a - b)[3], samplesMs }
}

// Retain the previous algorithm here as a differential oracle for generated
// selection shapes; it is never used by the app or the timed candidate runs.
function referenceIndent(items: PlanItem[], selected: Set<string>): PlanItem[] {
  let changed = false
  const recursed = items.map((node) => {
    const children = referenceIndent(node.children, selected)
    if (children === node.children) return node
    changed = true
    return { ...node, children }
  })
  const result: PlanItem[] = []
  for (const node of recursed) {
    const previous = result.at(-1)
    if (selected.has(node.id) && previous && !selected.has(previous.id)) {
      result[result.length - 1] = { ...previous, children: [...previous.children, node] }
      changed = true
    } else {
      result.push(node)
    }
  }
  return changed ? result : items
}

test('bulk indentation matches previous behavior and reference sharing on generated selections', () => {
  let seed = 0x71c2
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  for (let sample = 0; sample < 64; sample += 1) {
    const nodes = Array.from({ length: 180 }, (_, index) => item(`item-${index}`))
    const roots: Item[] = []
    for (let index = 0; index < nodes.length; index += 1) {
      if (index > 0 && random() < 0.8) {
        nodes[Math.floor(random() * index)].children.push(nodes[index])
      } else {
        roots.push(nodes[index])
      }
    }
    for (const node of nodes) {
      Object.freeze(node.children)
      Object.freeze(node)
    }
    Object.freeze(roots)
    const ids = nodes.filter(() => random() < sample / 64).map(({ id }) => id)
    const expected = referenceIndent(roots, new Set(ids))
    const actual = indentPlanItems(roots, ids)
    expect(actual).toEqual(expected)
    expect(actual === roots).toBe(expected === roots)
    const originals = new Map(nodes.map((node) => [node.id, node]))
    const compareReferences = (actualNodes: PlanItem[], expectedNodes: PlanItem[]) => {
      for (let index = 0; index < actualNodes.length; index += 1) {
        const a = actualNodes[index]
        const b = expectedNodes[index]
        const original = originals.get(a.id)!
        expect(a === original).toBe(b === original)
        expect(a.children === original.children).toBe(b.children === original.children)
        compareReferences(a.children, b.children)
      }
    }
    compareReferences(actual, expected)
  }
})

test('planner helpers retain behavior across wide and deep synthetic trees', async ({}, testInfo) => {
  const results: Array<Record<string, unknown>> = []
  for (const size of [4, 32, 512, 4096]) {
    const children = Array.from({ length: size }, (_, index) => item(`selected-${index}`))
    const selectedIds = children.map(({ id }) => id)
    const items = [item('destination', [item('existing')]), ...children, item('untouched')]
    const result = indentPlanItems(items, selectedIds)
    expect(result.map(({ id }) => id)).toEqual(['destination', 'untouched'])
    expect(result[0].children).toEqual([items[0].children[0], ...children])
    expect(result[1]).toBe(items.at(-1))
    expect(items[0].children).toHaveLength(1)
    results.push({ helper: 'indentPlanItems', size, ...measure(() => indentPlanItems(items, selectedIds)) })
  }

  for (const [depth, leafCount] of [[1, 4], [8, 256], [64, 256], [256, 256]]) {
    const leaves = Array.from({ length: leafCount }, (_, index) => item(`leaf-${index}`))
    const items = spine(depth, leaves)
    const ids = leaves.map(({ id }) => id)
    expect(copyPlanItems(items, ids)).toEqual(leaves)
    results.push({ helper: 'copyPlanItems', depth, leaves: leaves.length, ...measure(() => copyPlanItems(items, ids)) })
    for (const [helper, operation] of [
      ['backspacePlanItemAtStart', () => backspacePlanItemAtStart(items, 'missing')],
      ['backspaceListTemplateItemAtStart', () => backspaceListTemplateItemAtStart(items, 'missing')],
      ['backspaceTemplateOptionAtStart', () => backspaceTemplateOptionAtStart(items, 'missing', 'missing')],
    ] as const) {
      expect(operation()).toBeNull()
      results.push({ helper, depth, leaves: leaves.length, ...measure(operation) })
    }
  }

  // A normal editing operation includes lookup, merge, and immutable tree
  // rebuilding; measure it as well as the flatten-only stress cases above.
  const editingItems = [
    ...Array.from({ length: 4 }, (_, root) => item(`root-${root}`,
      Array.from({ length: 3 }, (_, child) => item(`child-${root}-${child}`,
        Array.from({ length: 3 }, (_, leaf) => item(`leaf-${root}-${child}-${leaf}`)),
      )),
    )),
    item('next'),
  ]
  const editingBefore = structuredClone(editingItems)
  for (const [helper, operation] of [
    ['backspacePlanItemAtStart:merge', () => backspacePlanItemAtStart(editingItems, 'next')],
    ['backspaceListTemplateItemAtStart:merge', () => backspaceListTemplateItemAtStart(editingItems, 'next')],
  ] as const) {
    const result = operation()!
    expect(result.focusItemId).toBe('leaf-3-2-2')
    expect(result.items[3].children[2].children[2].text).toBe('leaf-3-2-2next')
    expect(result.items).toHaveLength(4)
    results.push({ helper, depth: 3, leaves: 37, ...measure(operation) })
  }
  const mergeOption = () => backspaceTemplateOptionAtStart(editingItems, 'next', 'next-option')
  const mergedOption = mergeOption()!
  expect(mergedOption.focusOptionId).toBe('leaf-3-2-2-option')
  expect(mergedOption.items[3].children[2].children[2].options[0].text).toBe('leaf-3-2-2next')
  expect(mergedOption.items).toHaveLength(4)
  results.push({ helper: 'backspaceTemplateOptionAtStart:merge', depth: 3, leaves: 37, ...measure(mergeOption) })
  expect(editingItems).toEqual(editingBefore)

  const now = new Date(2026, 8, 5, 14, 38)
  const timed = { ...item('timed'), startMinutes: 600, endMinutes: 660 }
  const task = item('task')
  const smallRanges: Array<{ name: string; items: PlanItem[]; expectedStart: number }> = [
    { name: 'untimed-small', items: [item('parent', [task]), item('untimed')], expectedStart: 870 },
    { name: 'timed-small', items: [timed, task], expectedStart: 660 },
  ]
  for (const { name, items, expectedStart } of smallRanges) {
    const range = () => defaultPlanItemTimeRange(items, task.id, '2026-09-05', now)
    expect(range()).toEqual({ startMinutes: expectedStart, endMinutes: expectedStart + 60 })
    results.push({ helper: `defaultPlanItemTimeRange:${name}`, depth: 1, leaves: 2, ...measure(range) })
  }
  const timedItems = [timed, task, ...spine(128, Array.from({ length: 1024 }, (_, index) => item(`later-${index}`)))]
  const defaultRange = () => defaultPlanItemTimeRange(timedItems, task.id, '2026-09-05', now)
  expect(defaultRange()).toEqual({ startMinutes: 660, endMinutes: 720 })
  results.push({ helper: 'defaultPlanItemTimeRange', depth: 128, leaves: 1024, ...measure(defaultRange) })
  for (const result of results) {
    const { helper, size, depth, leaves } = result
    const scenario = size === undefined
      ? `${helper}:depth=${depth}:leaves=${leaves}`
      : `${helper}:siblings=${size}`
    console.log(`PERF ${JSON.stringify({ scenario, ...result })}`)
  }
  await testInfo.attach('planner-core-performance', {
    body: JSON.stringify({ suite: 'planner-core', results }, null, 2),
    contentType: 'application/json',
  })
})
