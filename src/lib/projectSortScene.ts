import {
  FONT,
  LINE_HEIGHT,
  PAPER_WIDTH,
  contains,
  distance,
  layoutSheet,
  sheetBoundary,
  standardOutline,
  type Point,
  type ProjectSort,
  type ProjectSortSlip,
  type Sheet,
  type TitleBlock,
} from './projectSort'
import { drawScissors } from './sortScissors'

export const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v))
type Pose = { x: number; y: number; scale: number; angle: number }
export type Drag = { id: string; origin: Point; cursor: Point; offset: Point; fromPile: boolean }
type Flight = { id: string; from: Pose; start: number }
const ease = (v: number) => 1 - (1 - v) ** 3
const blend = (a: number, b: number, t: number) => a + (b - a) * t
function hash(s: string) {
  let value = 17
  for (const c of s) value = (Math.imul(value, 31) + c.charCodeAt(0)) | 0
  return value >>> 0
}
function bounds(points: Point[]) {
  let x = Infinity,
    y = Infinity,
    r = -Infinity,
    b = -Infinity
  for (const p of points) {
    x = Math.min(x, p[0])
    y = Math.min(y, p[1])
    r = Math.max(r, p[0])
    b = Math.max(b, p[1])
  }
  return { x, y, r, b }
}
function surface(fill: [number, number, number], variation: number) {
  const tile = document.createElement('canvas')
  tile.width = tile.height = 184
  const ctx = tile.getContext('2d')!,
    data = ctx.createImageData(tile.width, tile.height)
  let seed = 48713
  for (let i = 0; i < data.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const value = (seed / 4294967296 - 0.5) * variation
    for (let k = 0; k < 3; k++) data.data[i + k] = fill[k] + value
    data.data[i + 3] = 255
  }
  ctx.putImageData(data, 0, 0)
  return tile
}

function traced(points: Point[], seed: number): Path2D {
  const path = new Path2D()
  path.moveTo(...points[0])
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length],
      length = distance(a, b),
      steps = Math.ceil(length / 3.8)
    for (let j = 1; j < steps; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const grain = (seed / 4294967296 - 0.5) * 0.94
      path.lineTo(
        blend(a[0], b[0], j / steps) - ((b[1] - a[1]) / length) * grain,
        blend(a[1], b[1], j / steps) + ((b[0] - a[0]) / length) * grain,
      )
    }
    path.lineTo(...b)
  }
  path.closePath()
  return path
}
type Piece = {
  block: TitleBlock
  path: Path2D
  outline: Point[]
  bounds: ReturnType<typeof bounds>
  angle: number
}
export class SortScene {
  ctx: CanvasRenderingContext2D
  w = 1
  h = 1
  dpr = 1
  sheet: Sheet = { blocks: [], height: 710 }
  pieces = new Map<string, Piece>()
  sort!: ProjectSort
  drag: Drag | null = null
  cursor: { p: Point; angle: number; travel: number } | null = null
  line: Point[] = []
  selected = ''
  camera = 0
  targetCamera = 0
  private paper: CanvasPattern
  private cloth: CanvasPattern
  private sheetPath = new Path2D()
  private flights: Flight[] = []
  private exitStart = 0
  private frame = 0
  private scissors = new Map<number, HTMLCanvasElement>()
  private sheetCache = document.createElement('canvas')
  private dirty = true
  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!
    this.paper = this.ctx.createPattern(surface([247, 240, 219], 8), 'repeat')!
    this.cloth = this.ctx.createPattern(surface([61, 86, 78], 15), 'repeat')!
  }
  measure = (s: string) => {
    this.ctx.font = FONT
    return this.ctx.measureText(s).width
  }
  resize(w: number, h: number) {
    if (w <= 0 || h <= 0) return
    this.w = w
    this.h = h
    const zoom = this.canvas.getBoundingClientRect().width / (w || 1)
    this.dpr = clamp((window.devicePixelRatio || 1) * zoom, 1, 3)
    this.canvas.width = Math.round(w * this.dpr)
    this.canvas.height = Math.round(h * this.dpr)
    this.sheetCache.width = this.canvas.width
    this.sheetCache.height = this.canvas.height
    this.dirty = true
    this.aim()
    this.render()
  }
  get cutting() {
    return this.sort?.slips.some((s) => !s.outline) ?? false
  }
  get sheetScale() {
    return Math.min((this.w - 38) / PAPER_WIDTH, 1.28)
  }
  get left() {
    return (this.w - PAPER_WIDTH * this.sheetScale) / 2
  }
  get top() {
    return (this.h < 365 ? 60 : 88) - this.camera * this.sheetScale
  }
  toPaper(p: Point): Point {
    const y = (p[1] - this.top) / this.sheetScale
    return [(p[0] - this.left) / this.sheetScale - y * 0.012, y / 0.982]
  }
  fromPaper([x, y]: Point): Point {
    return [this.left + (x + y * 0.982 * 0.012) * this.sheetScale, this.top + y * 0.982 * this.sheetScale]
  }
  update(sort: ProjectSort) {
    const prev = this.sort,
      wasCutting = this.cutting,
      same = prev?.id === sort.id
    this.sort = sort
    if (!same) {
      this.flights = []
      this.exitStart = 0
      this.selected = ''
      this.camera = 0
      this.drag = null
      this.line = []
    }
    if (prev?.slips !== sort.slips || !same) {
      this.sheet = layoutSheet(sort.slips, this.measure)
      const pieces = new Map<string, Piece>()
      const old = new Map(prev?.slips.map((s) => [s.id, s]))
      for (const [i, s] of sort.slips.entries()) {
        const block = this.sheet.blocks[i],
          outline = s.outline ?? standardOutline(block)
        const existing = this.pieces.get(s.id),
          unchanged = old.get(s.id)
        const geom =
          existing && unchanged?.title === s.title && unchanged.outline === s.outline
            ? existing
            : {
                path: traced(outline, hash(s.id)),
                outline,
                bounds: bounds(outline),
                angle: ((hash(s.id) % 997) / 997 - 0.5) * 0.092,
              }
        pieces.set(s.id, { ...geom, block })
        if (same && s.outline && unchanged && !unchanged.outline) {
          const [x, y] = this.fromPaper(block.center)
          this.flights.push({
            id: s.id,
            from: { x, y, scale: this.sheetScale, angle: 0 },
            start: performance.now(),
          })
        }
      }
      this.pieces = pieces
      this.sheetPath = traced(sheetBoundary(this.sheet), 321)
      if (same && wasCutting && !this.cutting) this.exitStart = performance.now()
      this.aim()
      if (!same) this.camera = this.targetCamera
    }
    this.dirty = true
    this.render()
  }
  aim() {
    const next = this.sheet.blocks.find((b, i) => !this.sort?.slips[i].outline)
    this.targetCamera = next ? Math.max(0, next.center[1] - next.height / 2 - 65) : this.camera
  }
  pan(delta: number) {
    this.targetCamera = clamp(
      this.targetCamera + delta / this.sheetScale,
      0,
      Math.max(0, this.sheet.height - 90),
    )
    this.render()
  }
  onPaper(p: Point) {
    if (p[0] < 0 || p[0] > PAPER_WIDTH || p[1] < 0 || p[1] > this.sheet.height) return false
    return !this.sort.slips.some((s) => {
      if (!s.outline) return false
      const { block } = this.pieces.get(s.id)!
      return contains(s.outline, [p[0] - block.center[0], p[1] - block.center[1]])
    })
  }
  get pile(): Point {
    return [this.w < 510 ? Math.min(74, this.w * 0.24) : 99, this.h < 365 ? 30 : 40]
  }
  private pilePose(s: ProjectSortSlip): Pose {
    const [x, y] = this.pile,
      h = hash(s.id),
      b = this.pieces.get(s.id)!.bounds
    const scale = Math.min(0.36, 97 / (b.r - b.x), 37 / (b.b - b.y))
    return {
      x: x + ((h % 9) - 4) - ((b.r + b.x) * scale) / 2,
      y: y + ((h % 7) - 3) - ((b.y + b.b) * scale) / 2,
      angle: ((h % 101) / 101 - 0.5) * 0.2,
      scale,
    }
  }
  private deskScale(s: ProjectSortSlip, raised = false) {
    const b = this.pieces.get(s.id)!.bounds
    const count = Math.max(1, this.sort.slips.length)
    const resting = clamp(Math.sqrt((this.w * this.h) / (count * 15600)), 0.27, 0.88)
    return Math.min(raised ? 1.06 : resting, (this.w - 12) / (b.r - b.x), (this.h - 12) / (b.b - b.y))
  }
  private constrain(x: number, y: number, scale: number, b: Piece['bounds']): Point {
    return [
      clamp(x, 5 - b.x * scale, this.w - 5 - b.r * scale),
      clamp(y, 5 - b.y * scale, this.h - 5 - b.b * scale),
    ]
  }
  position(s: ProjectSortSlip): Pose {
    const piece = this.pieces.get(s.id)!,
      d = this.drag
    if (d?.id === s.id) {
      const t = d.fromPile ? ease(clamp(distance(d.origin, d.cursor) / 100, 0, 1)) : 1
      const scale = blend(this.pilePose(s).scale, this.deskScale(s, true), t)
      const [x, y] = this.constrain(
        d.cursor[0] + d.offset[0] * scale,
        d.cursor[1] + d.offset[1] * scale,
        scale,
        piece.bounds,
      )
      return { x, y, scale, angle: piece.angle * 0.48 }
    }
    if (!s.position) return this.pilePose(s)
    const scale = this.deskScale(s),
      [x, y] = this.constrain(s.position.x * this.w, s.position.y * this.h, scale, piece.bounds)
    return { x, y, scale, angle: piece.angle }
  }
  ordered() {
    return this.sort.slips
      .filter((s) => s.outline)
      .sort((a, b) => (a.position?.z ?? -1) - (b.position?.z ?? -1))
  }
  hit(p: Point): ProjectSortSlip | undefined {
    for (const s of this.ordered().reverse()) {
      const pose = this.position(s),
        dx = (p[0] - pose.x) / pose.scale,
        dy = (p[1] - pose.y) / pose.scale
      const c = Math.cos(pose.angle),
        v = Math.sin(pose.angle)
      if (contains(this.pieces.get(s.id)!.outline, [dx * c + dy * v, dy * c - dx * v])) return s
    }
    const pile = this.sort.slips.filter((s) => s.outline && !s.position)
    if (pile.length && Math.abs(p[0] - this.pile[0]) < 59 && Math.abs(p[1] - this.pile[1]) < 27)
      return pile.at(-1)
  }
  private ink(ctx: CanvasRenderingContext2D, block: TitleBlock) {
    ctx.font = FONT
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#24272a'
    const x = -block.width / 2,
      y = -block.height / 2 + LINE_HEIGHT / 2 + 3
    block.lines.forEach((line, i) => ctx.fillText(line, x, y + i * LINE_HEIGHT))
  }
  private drawSlip(ctx: CanvasRenderingContext2D, s: ProjectSortSlip, pose: Pose, lifted: boolean) {
    const piece = this.pieces.get(s.id)!
    ctx.save()
    ctx.translate(pose.x, pose.y)
    ctx.rotate(pose.angle)
    ctx.scale(pose.scale, pose.scale)
    ctx.shadowColor = lifted ? 'rgba(9,24,21,.48)' : 'rgba(13,22,18,.39)'
    ctx.shadowOffsetY = lifted ? 8 : 2
    ctx.shadowOffsetX = lifted ? 3 : 1
    ctx.shadowBlur = lifted ? 12 : 4
    ctx.fillStyle = this.paper
    ctx.fill(piece.path)
    ctx.shadowColor = 'transparent'
    ctx.strokeStyle = 'rgba(121,111,87,.48)'
    ctx.lineWidth = 0.7
    ctx.stroke(piece.path)
    this.ink(ctx, piece.block)
    if (this.selected === s.id && this.canvas.matches(':focus-visible')) {
      ctx.strokeStyle = '#bf692d'
      ctx.lineWidth = 2 / pose.scale
      ctx.stroke(piece.path)
    }
    ctx.restore()
  }
  private makeSheet() {
    const ctx = this.sheetCache.getContext('2d')!
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.w, this.h)
    const sc = this.sheetScale
    ctx.translate(this.left, this.top)
    ctx.transform(sc, 0, sc * 0.982 * 0.012, sc * 0.982, 0, 0)
    ctx.fillStyle = this.paper
    ctx.shadowColor = 'rgba(18,27,20,.42)'
    ctx.shadowBlur = 13
    ctx.shadowOffsetY = 5
    // The slightly tilted sheet has a visible cut-stock edge at the near side.
    ctx.save()
    ctx.translate(0.65, 1.45)
    ctx.fillStyle = '#cbbfa2'
    ctx.fill(this.sheetPath)
    ctx.restore()
    ctx.shadowColor = 'transparent'
    ctx.fill(this.sheetPath)
    const grad = ctx.createLinearGradient(0, 0, PAPER_WIDTH, 65)
    grad.addColorStop(0, 'rgba(255,255,255,.16)')
    grad.addColorStop(1, 'rgba(157,132,90,.08)')
    ctx.fillStyle = grad
    ctx.fill(this.sheetPath)
    for (const s of this.sort.slips) {
      const p = this.pieces.get(s.id)!,
        [x, y] = p.block.center
      ctx.save()
      ctx.translate(x, y)
      if (s.outline) {
        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillStyle = '#000'
        ctx.fill(p.path)
      } else if (
        this.fromPaper([x, y + p.block.height / 2])[1] > -10 &&
        this.fromPaper([x, y - p.block.height / 2])[1] < this.h + 10
      )
        this.ink(ctx, p.block)
      ctx.restore()
    }
    ctx.clip(this.sheetPath)
    for (const stroke of this.sort.strokes) this.drawLine(ctx, stroke.points)
    this.dirty = false
  }
  private drawLine(ctx: CanvasRenderingContext2D, points: Point[]) {
    if (points.length < 2) return
    ctx.beginPath()
    ctx.moveTo(...points[0])
    for (let i = 1; i < points.length; i++) ctx.lineTo(...points[i])
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#827d6b'
    ctx.lineWidth = 1.45
    ctx.stroke()
    ctx.translate(0, -0.8)
    ctx.lineWidth = 0.55
    ctx.strokeStyle = '#fffaea'
    ctx.stroke()
    ctx.translate(0, 0.8)
  }
  private scissor(ctx: CanvasRenderingContext2D) {
    if (!this.cursor) return
    const { p, angle, travel } = this.cursor
    const t = Math.round((1 + Math.sin(travel * 0.095)) * 8)
    let sprite = this.scissors.get(t)
    if (!sprite) {
      sprite = document.createElement('canvas')
      sprite.width = 320
      sprite.height = 190
      const model = sprite.getContext('2d')!
      model.scale(2, 2)
      drawScissors(model, 134, 47, 0, 0.036 + t * 0.011, 1)
      this.scissors.set(t, sprite)
    }
    ctx.save()
    ctx.translate(...p)
    ctx.rotate(angle)
    const scale = this.w < 500 ? 0.84 : 1.04
    ctx.scale(scale, scale)
    ctx.shadowColor = 'rgba(21,27,24,.35)'
    ctx.shadowBlur = 3
    ctx.shadowOffsetX = 2
    ctx.shadowOffsetY = 4
    ctx.drawImage(sprite, -134, -47, 160, 95)
    ctx.restore()
  }
  draw = (now: number) => {
    this.frame = 0
    if (!this.sort) return
    const ctx = this.ctx
    if (!this.line.length && Math.abs(this.targetCamera - this.camera) > 0.16) {
      this.camera = blend(this.camera, this.targetCamera, 0.23)
      this.dirty = true
      this.render()
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.fillStyle = this.cloth
    ctx.fillRect(0, 0, this.w, this.h)
    const lighting = ctx.createRadialGradient(
      this.w * 0.42,
      0,
      0,
      this.w * 0.4,
      this.h * 0.2,
      Math.max(this.w, this.h) * 0.86,
    )
    lighting.addColorStop(0, 'rgba(210,226,198,.11)')
    lighting.addColorStop(1, 'rgba(9,26,22,.26)')
    ctx.fillStyle = lighting
    ctx.fillRect(0, 0, this.w, this.h)
    const leaving = this.exitStart && now - this.exitStart < 440
    if (this.cutting || leaving) {
      if (this.dirty) this.makeSheet()
      ctx.save()
      if (leaving) {
        const t = clamp((now - this.exitStart) / 440, 0, 1)
        ctx.translate(this.w * 0.12 * t * t, this.h * 1.4 * t * t)
        ctx.rotate(0.09 * t)
        this.render()
      }
      ctx.drawImage(this.sheetCache, 0, 0, this.w, this.h)
      ctx.translate(this.left, this.top)
      ctx.transform(this.sheetScale, 0, this.sheetScale * 0.982 * 0.012, this.sheetScale * 0.982, 0, 0)
      this.drawLine(ctx, this.line)
      ctx.restore()
    }
    const airborne = new Set(this.flights.map((f) => f.id))
    for (const s of this.ordered()) {
      if (this.drag?.id === s.id || airborne.has(s.id) || (this.cutting && s.position)) continue
      this.drawSlip(ctx, s, this.position(s), false)
    }
    this.flights = this.flights.filter((f) => now - f.start < 440 && this.pieces.has(f.id))
    for (const f of this.flights) {
      const s = this.sort.slips.find((s) => s.id === f.id)!,
        to = this.pilePose(s),
        t = ease(clamp((now - f.start) / 440, 0, 1))
      this.drawSlip(
        ctx,
        s,
        {
          x: blend(f.from.x, to.x, t),
          y: blend(f.from.y, to.y, t) - Math.sin(t * Math.PI) * 36,
          scale: blend(f.from.scale, to.scale, t),
          angle: blend(0, to.angle, t) + Math.sin(t * Math.PI) * 0.12,
        },
        true,
      )
    }
    if (airborne.size) this.render()
    const drag = this.sort.slips.find((s) => s.id === this.drag?.id)
    if (drag) this.drawSlip(ctx, drag, this.position(drag), true)
    if (this.cutting) this.scissor(ctx)
  }
  render() {
    if (!this.frame) this.frame = requestAnimationFrame(this.draw)
  }
  capture() {
    this.flights = []
    this.exitStart = 0
    this.selected = ''
    this.draw(performance.now())
    const out = document.createElement('canvas')
    out.width = Math.min(400, Math.ceil(this.w))
    out.height = Math.max(1, Math.round((out.width * this.h) / this.w))
    const ctx = out.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(this.canvas, 0, 0, out.width, out.height)
    return out.toDataURL('image/jpeg', 0.76)
  }
  destroy() {
    cancelAnimationFrame(this.frame)
  }
}
