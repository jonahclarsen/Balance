import { expect, test } from '@playwright/test'
import { getProjectSortLayouts, legacyOutline } from '../../src/lib/legacyProjectSort'

test('legacy paper spans become one continuous outline', () => {
  const outline = legacyOutline([[0, 0, 3], [0, 1, 4], [1, 2, 2]], { x: 2, y: 1 })
  expect(outline).toEqual([
    [-2, -1], [1, -1], [1, 0], [2, 0], [2, 1],
    [1, 1], [1, 2], [-1, 2], [-1, 1], [-2, 1],
  ])
})

test('saved legacy layouts keep their link ID, date, preview and slip position', () => {
  const old = {
    id: 'synthetic-sort',
    startedAt: '2026-11-20T20:30:00Z',
    saved: true,
    titles: [{ id: 'synthetic-project', name: 'Paper garden' }],
    cuts: [],
    slips: [{ id: 'synthetic-project', rows: [[1, 8, 82]], center: { x: 45, y: 11 }, place: { x: 0.45, y: 0.6 } }],
    preview: 'data:image/webp;base64,c3ludGhldGlj',
  }
  const [layout] = getProjectSortLayouts({ projectSortLayouts: [], projectSorts: [old] })
  expect(layout).toMatchObject({
    id: old.id,
    startedAt: old.startedAt,
    savedAt: old.startedAt,
    preview: old.preview,
    slips: [{ id: 'synthetic-project', title: 'Paper garden', position: { x: 0.45, y: 0.6, z: 0 } }],
  })
  expect(layout.slips[0].outline?.length).toBeGreaterThan(0)
  expect(getProjectSortLayouts({ projectSortLayouts: [layout], projectSorts: [old] })).toEqual([layout])
})
