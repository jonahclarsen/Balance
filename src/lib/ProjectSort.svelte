<script lang="ts">
  import { onMount } from 'svelte'
  import { drawScissors } from './projectScissors'
  import { plannerStore } from './store'
  import { projectHistoryPeriods, projectHistoryNoteDay, projectHistoryNoteId, PROJECT_BACKSTORY_NOTE_ID } from './projects'
  import type { Project, ProjectSortRecord } from './types'
  export let liveProjects: Project[]
  export let initial: ProjectSortRecord | undefined
  export let onSelect: (id: string) => void
  const record = initial
  const id = record?.id ?? crypto.randomUUID()
  const startedAt = record?.startedAt ?? new Date().toISOString()
  let saved = record?.saved ?? false
  let notice = ''
  let timer: ReturnType<typeof setTimeout>
  let dirty = false
  let cursor: Point | null = null, heading = 0, travel = 0
  let projects: ProjectSortRecord['titles'] = []
  let mounted = false
  $: if (!saved)
    reconcile(liveProjects)
  function reconcile(live: Project[]) {
    const old = projects.length ? projects : record?.titles ?? []
    const byId = new Map(live.map(p => [p.id, p]))
    const ids = new Set(old.map(p => p.id))
    const next = [...old.flatMap(p => byId.get(p.id) ?? []), ...live.filter(p => !ids.has(p.id))].map(({ id, name }) => ({ id, name }))
    if (mounted && JSON.stringify(next) === JSON.stringify(projects))
      return
    const indices = new Map(next.map((p, i) => [p.id, i]))
    function mapY(y: number) {
      const i = indices.get(old[Math.floor(y / row)]?.id)
      return i === undefined ? -1 : i * row + y % row
    }
    marks = new Set([...marks].flatMap(n => { const y = mapY(Math.floor(n / width)); return y < 0 ? [] : [y * width + n % width]; }))
    slips = slips.filter(s => indices.has(s.id)).map(s => {
      const y = indices.get(s.id)! * row + row / 2, shift = y - s.center.y
      return { ...s, center: { ...s.center, y }, rows: s.rows.map(([x, b, n]) => [x, b + shift, n]) }
    })
    projects = next
    target = Math.max(0, next.findIndex(p => !slips.some(s => s.id === p.id))) * row
    undo = []
    previous = null
    touching = false
    if (mounted) {
      schedule()
      paint()
    }
  }
  function persist() {
    clearTimeout(timer)
    if (!dirty || saved)
      return
    dirty = false
    plannerStore.putProjectSort({ id, startedAt, saved: false, titles: projects, cuts: [...marks], slips })
  }
  function schedule() { dirty = true; clearTimeout(timer); timer = setTimeout(persist, 500); }
  function save() {
    fly = 0
    cursor = null
    paint()
    const thumb = document.createElement('canvas')
    thumb.width = 320
    thumb.height = Math.max(1, Math.round(320 * viewHeight / viewWidth))
    thumb.getContext('2d')!.drawImage(canvas, 0, 0, thumb.width, thumb.height)
    saved = true
    clearTimeout(timer)
    plannerStore.putProjectSort({ id, startedAt, saved, titles: projects, cuts: [], slips, preview: thumb.toDataURL('image/webp', .8) })
  }
  const url = 'balance://project-sort/' + id
  async function copy() { try {
    await navigator.clipboard.writeText(url)
    notice = 'Copied'
  }
  catch {
    notice = url
  } }
  function history() {
    const days = $plannerStore.projectHistoryNotes.flatMap(n => projectHistoryNoteDay(n.id) ?? [])
    const day = projectHistoryPeriods($plannerStore.projects, days)[0]?.day
    plannerStore.addProjectHistoryNoteItem(day ? projectHistoryNoteId(day) : PROJECT_BACKSTORY_NOTE_ID, url)
    notice = 'Added to history'
  }
  export let onBack: () => void
  type Point = {
    x: number
    y: number
  }
  type Slip = ProjectSortRecord['slips'][number]
  const width = 90, row = 22
  let canvas: HTMLCanvasElement
  let slips: Slip[] = record?.slips ?? []
  let marks = new Set<number>(record?.cuts)
  let previous: Point | null = null
  let touching = false
  let undo: {
    marks: Set<number>
    slips: Slip[]
  }[] = []
  let dragging = ''
  let pickup: Point | null = null
  let pickupScale = 1
  let offset = { x: 0, y: 0 }
  let viewWidth = 1, viewHeight = 1
  let context: CanvasRenderingContext2D
  let camera = 0, frame = 0, target = 0, fly = 0
  if (saved)
    projects = record!.titles
  $: arranged = slips.length >= projects.length
  $: detached = detachedCells(arranged ? [] : slips)
  function detachedCells(pieces: Slip[]) {
    const cells = new Set<number>()
    for (const slip of pieces)
      for (const [x, y, n] of slip.rows) {
        for (let offset = 0; offset < n; offset++)
          cells.add(y * width + x + offset)
      }
    return cells
  }
  function scale() { return Math.min((viewWidth - 32) / width, 6); }
  function origin() { return (viewWidth - width * scale()) / 2; }
  function title(s: string, x: number, y: number, size: number, max: number) {
    context.font = size + 'px "Bradley Hand", "Segoe Print", "Comic Sans MS", cursive'
    context.fillStyle = '#252733'
    context.textBaseline = 'middle'
    context.fillText(s, x, y, max)
  }
  function dimensions() {
    const cols = Math.ceil(Math.sqrt(projects.length * viewWidth / viewHeight))
    return Math.min(1.9, viewWidth / ((cols || 1) * width), viewHeight / ((Math.ceil(projects.length / (cols || 1)) || 1) * row))
  }
  function position(s: Slip): Point {
    return s.place ? { x: s.place.x * viewWidth, y: s.place.y * viewHeight } : { x: Math.min(viewWidth / 2, 20 + width * dimensions() / 2), y: 36 }
  }
  function drawSlip(s: Slip, p: Point, zoom: number) {
    context.save()
    context.translate(p.x, p.y)
    context.scale(zoom, zoom)
    context.translate(-s.center.x, -s.center.y)
    context.fillStyle = '#fff9e7'
    for (const [x, y, n] of s.rows) {
      const fiber = .16 * Math.sin(y * 18.37 + x)
      context.fillRect(x + fiber, y, n - fiber * .5, 1.04)
    }
    title(projects.find(a => a.id === s.id)?.name ?? '', 6, s.center.y, 5.6, width - 12)
    context.restore()
  }
  function paint() {
    cancelAnimationFrame(frame)
    context.fillStyle = '#514a43'
    context.fillRect(0, 0, viewWidth, viewHeight)
    camera += (target - camera) * 0.17
    const z = scale()
    if (!arranged || fly > 0.01) {
      context.save()
      context.translate(origin(), 84 - camera * z)
      context.scale(z, z)
      context.fillStyle = '#ac9f87'
      context.fillRect(.4, .6, width, row * projects.length)
      const paper = context.createLinearGradient(0, 0, width, 0)
      paper.addColorStop(0, '#f0e9d8')
      paper.addColorStop(.2, '#fff9e7')
      paper.addColorStop(1, '#f8f1e3')
      context.fillStyle = paper
      context.fillRect(0, 0, width, row * projects.length)
      const start = Math.max(0, Math.floor((camera - 84 / z) / row))
      for (let i = start; i < Math.min(projects.length, start + Math.ceil(viewHeight / z / row) + 2); i++) {
        title(projects[i].name, 6, i * row + row / 2, 5.6, width - 12)
      }
      context.fillStyle = '#514a43'
      for (const cell of marks)
        context.fillRect(cell % width, Math.floor(cell / width), 1, 1)
      for (const slip of slips)
        for (const [x, y, n] of slip.rows)
          context.fillRect(x, y, n, 1.02)
      context.restore()
    }
    const pile = slips.filter(s => !s.place).slice(-5)
    const visible = [...pile, ...slips.filter(s => s.place)]
    for (const s of visible) {
      const p = position(s)
      const t = s === slips.at(-1) ? fly : 0
      const small = !s.place && dragging !== s.id ? dimensions() * .64 : dimensions() * (s.id === dragging ? pickupScale : 1)
      drawSlip(s, { x: p.x * (1 - t) + (origin() + s.center.x * z) * t, y: p.y * (1 - t) + (84 + (s.center.y - camera) * z) * t }, small + (z - small) * t)
    }
    if (cursor && !arranged)
      drawScissors(context, cursor.x, cursor.y, heading, travel)
    fly *= .91
    if (Math.abs(target - camera) > .02 || fly > .005)
      frame = requestAnimationFrame(paint)
  }
  function cut(touchedRow: number, fresh: number[]) {
    const height = projects.length * row
    // Only a component separated from the remaining visible titles can leave the sheet.
    const cutIds = new Set(slips.map(s => s.id))
    const pending = projects.map((p, i) => ({ p, i })).filter(({ p }) => !cutIds.has(p.id))
    context.font = '5.6px "Bradley Hand", "Segoe Print", "Comic Sans MS", cursive'
    const ends = pending.map(({ p }) => Math.floor(6 + Math.min(width - 12, context.measureText(p.name).width)))
    const seeds = pending.map(({ i }, j) => (i * row + row / 2) * width + Math.floor((6 + ends[j]) / 2))
    const titleCells = new Set(seeds)
    for (const [index, seed] of seeds.entries()) {
      if (Math.abs(pending[index].i - touchedRow) > 1 || marks.has(seed))
        continue
      const cells = new Set([seed]), queue = [seed]
      let large = false
      for (let j = 0; j < queue.length; j++) {
        const n = queue[j], x = n % width
        if (queue.length > width * row * 2 || (n !== seed && titleCells.has(n))) {
          large = true
          break
        }
        for (const next of [x ? n - 1 : -1, x < width - 1 ? n + 1 : -1, n - width, n + width]) {
          if (next >= 0 && next < width * height && !detached.has(next) && !marks.has(next) && !cells.has(next)) {
            cells.add(next)
            queue.push(next)
          }
        }
      }
      if (large)
        continue
      // An earlier cut may have left a separate scrap elsewhere on the table.
      // Release a title only when this stroke separates material on its two sides.
      const separated = fresh.some(n => {
        const neighbors = [n - width, n + width]
        if (n % width > 0)
          neighbors.push(n - 1)
        if (n % width < width - 1)
          neighbors.push(n + 1)
        return neighbors.some(v => cells.has(v)) && neighbors.some(v => v >= 0 && v < width * height && !marks.has(v) && !detached.has(v) && !cells.has(v))
      })
      if (!separated)
        continue
      const { i, p } = pending[index], y = i * row + row / 2
      if (![6, ends[index]].every(x => cells.has(y * width + x)))
        continue
      const rows: number[][] = []
      for (const n of queue.sort((a, b) => a - b)) {
        const last = rows.at(-1), x = n % width, cy = Math.floor(n / width)
        if (last && last[1] === cy && last[0] + last[2] === x)
          last[2]++
        else
          rows.push([x, cy, 1])
      }
      slips = [...slips, { id: p.id, center: { x: width / 2, y }, rows }]
      fly = 1
      const next = projects.findIndex(p => !slips.some(s => s.id === p.id))
      target = (next < 0 ? projects.length : next) * row
      previous = null
      touching = false
      break
    }
  }
  function point(e: PointerEvent) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * viewWidth / r.width, y: (e.clientY - r.top) * viewHeight / r.height }; }
  function move(e: PointerEvent) {
    if (saved)
      return
    const p = point(e)
    if (cursor) {
      const dx = p.x - cursor.x, dy = p.y - cursor.y
      if (dx || dy) {
        heading = Math.atan2(dy, dx)
        travel += Math.hypot(dx, dy)
      }
    }
    cursor = p
    if (dragging) {
      pickupScale = pickup ? .64 + .36 * Math.min(1, Math.hypot(p.x - pickup.x, p.y - pickup.y) / 70) : 1
      schedule()
      const zoom = dimensions()
      const clamp = (v: number, margin: number) => Math.max(margin, Math.min(1 - margin, v))
      const place = {
        x: clamp((p.x - offset.x) / viewWidth, width * zoom / (2 * viewWidth)),
        y: clamp((p.y - offset.y) / viewHeight, row * zoom / (2 * viewHeight)),
      }
      slips = slips.map(s => s.id === dragging ? { ...s, place } : s)
    }
    else if (!arranged && fly < .1) {
      const q = { x: (p.x - origin()) / scale(), y: (p.y - 84) / scale() + camera }
      const from = previous ?? q
      const steps = Math.max(1, Math.ceil(Math.hypot(q.x - from.x, q.y - from.y) * 2))
      const fresh: number[] = []
      for (let i = 1; i <= steps; i++) {
        const x = Math.floor(from.x + (q.x - from.x) * i / steps), y = Math.floor(from.y + (q.y - from.y) * i / steps)
        if (x < 0 || x >= width || y < 0 || y >= projects.length * row) {
          touching = false
          continue
        }
        if (detached.has(y * width + x)) {
          touching = false
          continue
        }
        if (!touching)
          undo.push({ marks: new Set(marks), slips: [...slips] })
        touching = true
        const n = y * width + x
        if (!marks.has(n)) {
          marks.add(n)
          fresh.push(n)
        }
      }
      previous = q
      if (fresh.length) {
        cut(Math.floor(q.y / row), fresh)
        schedule()
      }
    }
    paint()
  }
  function down(e: PointerEvent) {
    if (saved)
      return
    if (!arranged) {
      move(e)
      return
    }
    const p = point(e)
    const s = [...slips].reverse().find(s => { const c = position(s), z = dimensions() * (s.place ? 1 : .64); return s.rows.some(([x, y, n]) => { const a = (p.x - c.x) / z + s.center.x, b = (p.y - c.y) / z + s.center.y; return a >= x && a < x + n && b >= y && b < y + 1; }); })
    if (!s)
      return
    pickup = s.place ? null : p
    dragging = s.id
    const c = position(s)
    offset = { x: p.x - c.x, y: p.y - c.y }
    slips = [...slips.filter(a => a !== s), s]
    canvas.setPointerCapture(e.pointerId)
    move(e)
  }
  onMount(() => {
    context = canvas.getContext('2d')!
    mounted = true
    if (!saved)
      schedule()
    const resize = new ResizeObserver(() => {
      viewWidth = canvas.clientWidth
      viewHeight = canvas.clientHeight
      const d = devicePixelRatio
      canvas.width = Math.round(viewWidth * d)
      canvas.height = Math.round(viewHeight * d)
      context.setTransform(d, 0, 0, d, 0, 0)
      paint()
    })
    resize.observe(canvas)
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const entry = undo.pop()
        if (entry) {
          schedule()
          marks = entry.marks
          slips = entry.slips
          previous = null
          touching = false
          fly = 0
          target = Math.max(0, projects.findIndex(p => !slips.some(s => s.id === p.id))) * row
          paint()
        }
      }
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('pagehide', persist)
    return () => { persist(); window.removeEventListener('pagehide', persist); resize.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('keydown', key, true); }
  })
</script>
<div class="sort-view">
  <header>
    <button class="ghost" on:click={onBack}>Back</button>
    <h2>Sort</h2>
    {#if saved}
      <button class="ghost" on:click={copy}>Copy link</button>
      <button class="ghost" on:click={history}>Copy to history</button>
      <button class="ghost" on:click={() => onSelect($plannerStore.projectSorts.filter(sort => !sort.saved).at(-1)?.id ?? crypto.randomUUID())}>New sort</button>
    {:else if arranged && projects.length}
      <button class="ghost" on:click={save}>Save</button>
    {/if}
    <span>{saved ? new Date(startedAt).toLocaleString() : !projects.length ? 'No open projects' : arranged ? 'Drag pieces from the pile' : 'Trace around each title'}</span>
  </header>
  {#if notice}<p role="status">{notice}</p>{/if}
  <canvas bind:this={canvas} aria-label="Project sorting tabletop"
    on:pointermove={move} on:pointerdown={down}
    on:pointerleave={() => { previous = null; touching = false; cursor = null; paint() }}
    on:lostpointercapture={() => { dragging = ''; pickup = null; paint() }}>
  </canvas>
  {#if $plannerStore.projectSorts.some(sort => sort.saved && sort.id !== id)}
    <details>
      <summary>Saved sorts</summary>
      {#each $plannerStore.projectSorts.filter(sort => sort.saved && sort.id !== id).reverse() as sort (sort.id)}
        <button class="ghost" on:click={() => onSelect(sort.id)}>{new Date(sort.startedAt).toLocaleString()}</button>
      {/each}
    </details>
  {/if}
</div>
<style>
 header {display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:12px}
 header h2 {margin:0} header span {margin-left:auto;font-size:.85em}
 canvas {display:block;width:100%;height:clamp(320px,72dvh,900px);background:radial-gradient(at 35% 15%,#696056,#433e39);border-radius:10px;touch-action:none;cursor:crosshair}
</style>
