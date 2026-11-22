import { layoutSheet, standardOutline, type ProjectSort } from './projectSort'

type Point = [x: number, y: number]

export interface LegacyProjectSort {
  id: string
  startedAt: string
  saved: boolean
  titles: { id: string; name: string }[]
  cuts: number[]
  slips: { id: string; rows: number[][]; center: { x: number; y: number }; place?: { x: number; y: number } }[]
  preview?: string
}

// Old clients stored paper as one-pixel horizontal spans. Join only exposed
// cell edges so old layouts can be drawn as solid vector silhouettes.
export function legacyOutline(rows: number[][], center: { x: number; y: number }): Point[] {
  const cells = new Map<number, Set<number>>()
  for (const [x, y, length] of rows) {
    if (!cells.has(y)) cells.set(y, new Set())
    for (let dx = 0; dx < length; dx++) cells.get(y)!.add(x + dx)
  }

  const edges = new Map<string, { end: Point; direction: number }[]>()
  function add(start: Point, end: Point, direction: number) {
    const key = start.join(',')
    const outgoing = edges.get(key) ?? []
    outgoing.push({ end, direction })
    edges.set(key, outgoing)
  }
  for (const [y, columns] of cells) {
    for (const x of columns) {
      if (!cells.get(y - 1)?.has(x)) add([x, y], [x + 1, y], 0)
      if (!columns.has(x + 1)) add([x + 1, y], [x + 1, y + 1], 1)
      if (!cells.get(y + 1)?.has(x)) add([x + 1, y + 1], [x, y + 1], 2)
      if (!columns.has(x - 1)) add([x, y + 1], [x, y], 3)
    }
  }

  let outline: Point[] = []
  let largestArea = 0
  while (edges.size) {
    const key = edges.keys().next().value!
    const start = key.split(',').map(Number) as Point
    let point = start
    let direction = edges.get(key)![0].direction
    let area = 0
    const loop: Point[] = [start]
    do {
      const vertex = point.join(',')
      const outgoing = edges.get(vertex)
      if (!outgoing) break
      // At a diagonal contact, follow the edge around the occupied cell.
      const turnPriority = [1, 0, 3, 2]
      const next = turnPriority.map(turn => outgoing.findIndex(edge => edge.direction === (direction + turn) % 4)).find(index => index >= 0)!
      const [edge] = outgoing.splice(next, 1)
      if (!outgoing.length) edges.delete(vertex)
      if (direction !== edge.direction) loop.push(point)
      direction = edge.direction
      area += point[0] * edge.end[1] - edge.end[0] * point[1]
      point = edge.end
    } while (point[0] !== start[0] || point[1] !== start[1])
    if (area > largestArea) {
      largestArea = area
      outline = loop
    }
  }
  return outline.map(([x, y]) => [x - center.x, y - center.y])
}

const converted = new WeakMap<LegacyProjectSort, ProjectSort>()

function convert(sort: LegacyProjectSort): ProjectSort {
  const remembered = converted.get(sort)
  if (remembered) return remembered
  const pieces = new Map(sort.slips.map((slip, index) => [slip.id, { slip, index }]))
  const layout: ProjectSort = {
    id: sort.id,
    startedAt: sort.startedAt,
    ...(sort.saved ? { savedAt: sort.startedAt } : {}),
    ...(sort.preview ? { preview: sort.preview } : {}),
    strokes: [],
    slips: sort.titles.map(({ id, name }) => {
      const piece = pieces.get(id)
      if (!piece) return { id, title: name }
      const { slip, index } = piece
      const block = layoutSheet([{ id, title: name }], text => Array.from(text).length * 15).blocks[0]
      const outline = legacyOutline(slip.rows, slip.center)
      const xs = outline.map(([x]) => x)
      const ys = outline.map(([, y]) => y)
      const left = Math.min(...xs), right = Math.max(...xs)
      const top = Math.min(...ys), bottom = Math.max(...ys)
      const xScale = (block.width + 30) / (right - left)
      const yScale = (block.height + 18) / (bottom - top)
      return {
        id,
        title: name,
        outline: outline.length ? outline.map(([x, y]) => [(x - (left + right) / 2) * xScale, (y - (top + bottom) / 2) * yScale]) : standardOutline(block),
        ...(slip.place ? { position: { ...slip.place, z: index } } : {}),
      }
    }),
  }
  converted.set(sort, layout)
  return layout
}

export function getProjectSortLayouts(state: { projectSortLayouts?: ProjectSort[]; projectSorts?: LegacyProjectSort[] }): ProjectSort[] {
  const layouts = state.projectSortLayouts ?? []
  if (!state.projectSorts?.length) return layouts
  const current = new Set(layouts.map(layout => layout.id))
  return [...layouts, ...state.projectSorts.filter(sort => !current.has(sort.id)).map(convert)]
}
