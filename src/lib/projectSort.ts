import { isProjectOpen } from './projects'
import type { Project } from './types'

export type Point = [number, number]
export type ProjectSortSlip = {
  id: string
  title: string
  outline?: Point[]
  position?: { x: number; y: number; z: number }
}
export type CutStroke = { id: string; points: Point[] }
export type ProjectSort = {
  id: string
  startedAt: string
  savedAt?: string
  slips: ProjectSortSlip[]
  strokes: CutStroke[]
  preview?: string
}

export const PAPER_WIDTH = 570
export const FONT_SIZE = 28
export const FONT = `${FONT_SIZE}px "Sort handwriting", "Bradley Hand", cursive`
export const LINE_HEIGHT = 34
const WRITE_WIDTH = 217
export type TitleBlock = { id: string; center: Point; lines: string[]; width: number; height: number }
export type Sheet = { blocks: TitleBlock[]; height: number }
export type Measure = (s: string) => number

// Keep pen lettering at its written size. Even a single unbroken word can wrap.
function wrapTitle(title: string, measure: Measure) {
  const lines: string[] = []
  let line = ''
  for (const word of title.trim().split(/\s+/u)) {
    const joined = line ? line + ' ' + word : word
    if (measure(joined) <= WRITE_WIDTH) {
      line = joined
      continue
    }
    if (line) lines.push(line)
    line = ''
    for (const char of word) {
      if (line && measure(line + char) > WRITE_WIDTH) {
        lines.push(line)
        line = ''
      }
      line += char
    }
  }
  lines.push(line)
  return lines
}

export function layoutSheet(slips: ProjectSortSlip[], measure: Measure): Sheet {
  let y = 29
  const blocks: TitleBlock[] = []
  for (let start = 0; start < slips.length; start += 2) {
    const row = slips.slice(start, start + 2).map((slip, column): TitleBlock => {
      const lines = wrapTitle(slip.title, measure)
      const width = Math.max(8, ...lines.map(measure))
      const height = lines.length * LINE_HEIGHT
      return { id: slip.id, lines, width, height, center: [35 + column * 282 + width / 2, y + height / 2] }
    })
    blocks.push(...row)
    y += Math.max(...row.map((block) => block.height)) + 48
  }
  return { blocks, height: Math.max(710, y + 4) }
}

export function standardOutline(block: Pick<TitleBlock, 'width' | 'height'>): Point[] {
  const x = block.width / 2 + 15,
    y = block.height / 2 + 9
  return [
    [-x - 1, -y + 1],
    [x * 0.1, -y - 1],
    [x + 2, -y + 1],
    [x, y],
    [x * -0.34, y + 1.4],
    [-x, y - 1],
  ]
}

export function syncSortProjects(sort: ProjectSort, projects: Project[], measure: Measure): ProjectSort {
  if (sort.savedAt) return sort
  const open = new Map(projects.filter(isProjectOpen).map((p) => [p.id, p.name]))
  let changed = false
  const slips: ProjectSortSlip[] = []
  for (const slip of sort.slips) {
    const title = open.get(slip.id)
    if (title === undefined) {
      changed = true
      continue
    }
    open.delete(slip.id)
    if (title === slip.title) {
      slips.push(slip)
      continue
    }
    changed = true
    const next = { ...slip, title }
    if (slip.outline) {
      const a = layoutSheet([slip], measure).blocks[0],
        b = layoutSheet([next], measure).blocks[0]
      next.outline = slip.outline.map(([x, y]) => [
        (x * (b.width + 28)) / (a.width + 28),
        (y * (b.height + 18)) / (a.height + 18),
      ])
    }
    slips.push(next)
  }
  if (!changed && !open.size) return sort
  const before = layoutSheet(sort.slips, measure)
  for (const [id, title] of open) slips.push({ id, title })
  const after = layoutSheet(slips, measure)
  // A partial stroke belongs to the sheet on which it was drawn. Translate it
  // with its nearest surviving title if edits change the rows or columns.
  const newBlocks = new Map(after.blocks.map((block) => [block.id, block]))
  const strokes = sort.strokes.flatMap((stroke) => {
    if (!stroke.points.length) return []
    const [x, y] = stroke.points[Math.floor(stroke.points.length / 2)]
    const anchor = before.blocks.reduce<TitleBlock | undefined>(
      (best, b) =>
        !best ||
        Math.hypot(x - b.center[0], y - b.center[1]) < Math.hypot(x - best.center[0], y - best.center[1])
          ? b
          : best,
      undefined,
    )
    const next = anchor && newBlocks.get(anchor.id)
    if (!anchor || !next) return []
    const dx = next.center[0] - anchor.center[0] - (next.width - anchor.width) / 2
    const dy = next.center[1] - anchor.center[1] - (next.height - anchor.height) / 2
    return dx || dy
      ? [{ ...stroke, points: stroke.points.map(([x, y]): Point => [x + dx, y + dy]) }]
      : [stroke]
  })
  return { ...sort, slips, strokes }
}

export function contains(poly: Point[], [x, y]: Point): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = poly[i],
      [c, d] = poly[j]
    if (b > y !== d > y && x < ((c - a) * (y - b)) / (d - b) + a) inside = !inside
  }
  return inside
}

export const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])
export type Segment = { a: Point; b: Point }
function intersection(p: Segment, q: Segment): { t: number; u: number; point: Point } | null {
  const dx = p.b[0] - p.a[0],
    dy = p.b[1] - p.a[1],
    ex = q.b[0] - q.a[0],
    ey = q.b[1] - q.a[1]
  const det = dx * ey - dy * ex
  if (Math.abs(det) < 1e-7) return null
  const x = q.a[0] - p.a[0],
    y = q.a[1] - p.a[1]
  const t = (x * ey - y * ex) / det,
    u = (x * dy - y * dx) / det
  return t >= -1e-6 && t <= 1.000001 && u >= -1e-6 && u <= 1.000001
    ? { t, u, point: [p.a[0] + t * dx, p.a[1] + t * dy] }
    : null
}
function edges(points: Point[], closed = false): Segment[] {
  const line = closed ? [...points, points[0]] : points
  return line
    .slice(1)
    .map((b, i) => ({ a: line[i], b }))
    .filter(({ a, b }) => distance(a, b) > 0.08)
}
export function sheetBoundary(sheet: Sheet): Point[] {
  return [
    [0, 0],
    [PAPER_WIDTH, 0],
    [PAPER_WIDTH, sheet.height],
    [0, sheet.height],
  ]
}

export function sheetSegments(sort: ProjectSort, sheet: Sheet): Segment[] {
  const all = edges(sheetBoundary(sheet), true)
  for (const stroke of sort.strokes) all.push(...edges(stroke.points))
  for (const [i, slip] of sort.slips.entries()) {
    if (!slip.outline) continue
    const [cx, cy] = sheet.blocks[i].center
    all.push(
      ...edges(
        slip.outline.map(([x, y]) => [x + cx, y + cy]),
        true,
      ),
    )
  }
  return all
}

// Snap to a previous incision or the paper edge within the blade's width.
// The actual path stays continuous and is never quantized to a raster mask.
export function meetEdge(a: Point, b: Point, segments: Segment[], tolerance = 2.6): Point | null {
  let nearest: Point | null = null,
    d = Infinity
  for (const seg of segments) {
    const hit = intersection({ a, b }, seg)
    if (hit && hit.t > 0.002 && distance(b, hit.point) < d) {
      nearest = hit.point
      d = distance(b, hit.point)
      continue
    }
    const dx = seg.b[0] - seg.a[0],
      dy = seg.b[1] - seg.a[1]
    const k = Math.max(
      0,
      Math.min(1, ((b[0] - seg.a[0]) * dx + (b[1] - seg.a[1]) * dy) / (dx * dx + dy * dy)),
    )
    const foot: Point = [seg.a[0] + k * dx, seg.a[1] + k * dy]
    const dist = distance(b, foot)
    if (dist <= tolerance && dist < d && distance(a, foot) > 0.4) {
      nearest = foot
      d = dist
    }
  }
  return nearest
}

function area(poly: Point[]) {
  return (
    poly.reduce((a, p, i) => {
      const q = poly[(i + 1) % poly.length]
      return a + p[0] * q[1] - p[1] * q[0]
    }, 0) / 2
  )
}

// Build the planar faces only when a stroke reconnects. A sweep on x prunes
// intersection pairs. Following the clockwise successor around each vertex
// gives exact paper silhouettes for edge-to-edge cuts and closed loops alike.
function cutFaces(segments: Segment[]): Point[][] {
  const sorted = segments
    .map(({ a, b }) => ({
      a,
      b,
      stops: [
        { t: 0, point: a },
        { t: 1, point: b },
      ],
      left: Math.min(a[0], b[0]),
      right: Math.max(a[0], b[0]),
      top: Math.min(a[1], b[1]),
      bottom: Math.max(a[1], b[1]),
    }))
    .sort((p, q) => p.left - q.left)
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]
    for (let j = i + 1; j < sorted.length && sorted[j].left <= p.right + 0.001; j++) {
      const q = sorted[j]
      if (q.bottom < p.top - 0.001 || q.top > p.bottom + 0.001) continue
      const hit = intersection(p, q)
      if (hit) {
        p.stops.push({ t: hit.t, point: hit.point })
        q.stops.push({ t: hit.u, point: hit.point })
      }
    }
  }
  const nodes: Point[] = [],
    adjacent: Set<number>[] = [],
    ids = new Map<string, number>()
  function vertex(p: Point) {
    const key = Math.round(p[0] * 100) + ',' + Math.round(p[1] * 100)
    let id = ids.get(key)
    if (id === undefined) {
      id = nodes.length
      ids.set(key, id)
      nodes.push(p)
      adjacent.push(new Set())
    }
    return id
  }
  for (const { stops } of sorted) {
    stops.sort((a, b) => a.t - b.t)
    let prev = vertex(stops[0].point)
    for (const stop of stops.slice(1)) {
      const next = vertex(stop.point)
      if (next !== prev) {
        adjacent[prev].add(next)
        adjacent[next].add(prev)
        prev = next
      }
    }
  }
  const neighbors = adjacent.map((set, i) =>
    [...set].sort(
      (a, b) =>
        Math.atan2(nodes[a][1] - nodes[i][1], nodes[a][0] - nodes[i][0]) -
        Math.atan2(nodes[b][1] - nodes[i][1], nodes[b][0] - nodes[i][0]),
    ),
  )
  const visited = new Set<string>(),
    faces: Point[][] = []
  for (const [i, ns] of neighbors.entries())
    for (const j of ns) {
      const poly: Point[] = []
      let from = i,
        to = j
      while (!visited.has(from + ',' + to)) {
        visited.add(from + ',' + to)
        poly.push(nodes[from])
        const exits = neighbors[to],
          index = exits.indexOf(from)
        from = to
        to = exits[(index + exits.length - 1) % exits.length]
      }
      if (poly.length >= 3 && area(poly) > 30) faces.push(poly)
    }
  return faces.sort((a, b) => area(a) - area(b))
}

export function detachWithStroke(sort: ProjectSort, sheet: Sheet, points: Point[], id: string): ProjectSort {
  const faces = cutFaces([...sheetSegments(sort, sheet), ...edges(points)])
  const pending = sort.slips.filter((s) => !s.outline)
  const released = new Map<string, Point[]>()
  for (const face of faces) {
    // The exterior sheet ring can surround a disconnected loop as well.
    if (area(face) >= PAPER_WIDTH * sheet.height - 0.1) continue
    const titles = sheet.blocks.filter((b) => contains(face, b.center))
    if (titles.length !== 1) continue
    const b = titles[0]
    if (released.has(b.id) || !pending.some((s) => s.id === b.id)) continue
    const [cx, cy] = b.center
    const halfW = b.width / 2 - 2,
      halfH = b.height / 2 - 3
    if (![-1, 1].every((sx) => [-1, 1].every((sy) => contains(face, [cx + sx * halfW, cy + sy * halfH]))))
      continue
    // The very last piece often contains most of the blank page. Keep the
    // actual final edge for a slip-sized remainder; trim a page-sized offcut.
    const finalRemainder = released.size > 0 && released.size + 1 === pending.length
    const fitsSlip = area(face) <= (b.width + 45) * (b.height + 32) * 2.8
    released.set(
      b.id,
      finalRemainder && !fitsSlip ? standardOutline(b) : face.map(([x, y]) => [x - cx, y - cy]),
    )
  }
  if (released.size && pending.length - released.size === 1) {
    const last = pending.find((s) => !released.has(s.id))!
    released.set(last.id, standardOutline(sheet.blocks.find((b) => b.id === last.id)!))
  }
  const slips = sort.slips.map((s) => (released.has(s.id) ? { ...s, outline: released.get(s.id) } : s))
  return { ...sort, slips, strokes: slips.every((s) => s.outline) ? [] : [...sort.strokes, { id, points }] }
}

export function keyboardCut(sort: ProjectSort, sheet: Sheet): ProjectSort {
  const pending = sort.slips.filter((s) => !s.outline)
  const ids = new Set(pending.slice(0, pending.length === 2 ? 2 : 1).map((s) => s.id))
  const slips = sort.slips.map((s, i) =>
    ids.has(s.id) ? { ...s, outline: standardOutline(sheet.blocks[i]) } : s,
  )
  return { ...sort, slips, strokes: slips.every((s) => s.outline) ? [] : sort.strokes }
}
