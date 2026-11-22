<script lang="ts">
  import { getProjectSortLayouts } from './legacyProjectSort'
  import { onMount } from 'svelte'
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { plannerStore } from './store'
  import { createId } from './planner'
  import { navigationURL } from './navigationLinks'
  import {
    FONT,
    detachWithStroke,
    distance,
    keyboardCut,
    layoutSheet,
    meetEdge,
    sheetSegments,
    standardOutline,
    syncSortProjects,
    type Point,
    type ProjectSort,
    type ProjectSortSlip,
    type Segment,
  } from './projectSort'
  import { SortScene, clamp } from './projectSortScene'

  export let linkedId = ''
  export let onBack: () => void
  let canvas: HTMLCanvasElement
  let scene: SortScene | undefined
  let selectedId = ''
  let observedLink: string | undefined
  let library = false
  let message = ''
  let priorPointer: Point | null = null
  let contact: number | null = null
  let gesture: ProjectSort | undefined
  let contactStart: ProjectSort | undefined
  let drawing = false
  let before: ProjectSort[] = []
  let after: ProjectSort[] = []
  let lastWritten: ProjectSort | undefined
  let segmentCache: Segment[] = []
  let contactEdges: Segment[] = []
  let atEdge = false
  let suspendUntilMove = false
  let selectedTitle = ''
  $: sorts = getProjectSortLayouts($plannerStore)
  $: saved = sorts.filter((s) => s.savedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  $: current = sorts.find((s) => s.id === selectedId)
  $: pending = current?.slips.filter((s) => !s.outline).length ?? 0
  $: if (scene && observedLink !== linkedId) {
    observedLink = linkedId
    if (linkedId) select(linkedId)
    else openDraft()
  }
  $: if (scene && current) refresh(scene, current, $plannerStore.projects)
  function refresh(table: SortScene, record: ProjectSort, projects: typeof $plannerStore.projects) {
    const next = syncSortProjects(record, projects, table.measure)
    if (next !== record) {
      write(next, record)
      return
    }
    if (table.sort === record) return
    if (lastWritten !== record) {
      before = []
      after = []
      clearGesture()
    }
    table.update(record)
    segmentCache = table.cutting ? sheetSegments(record, table.sheet) : []
  }
  function clearGesture() {
    if (scene) {
      scene.line = []
      scene.drag = null
      scene.cursor = null
      scene.render()
    }
    gesture = undefined
    drawing = false
    contactStart = undefined
    contact = null
    priorPointer = null
    contactEdges = []
  }
  function select(id: string) {
    finishLine()
    clearGesture()
    before = []
    after = []
    selectedTitle = ''
    message = ''
    library = false
    selectedId = id
    const record = getProjectSortLayouts($plannerStore).find((s) => s.id === id)
    if (record && scene) refresh(scene, record, $plannerStore.projects)
  }
  export function showSaved(id: string) {
    select(id)
  }
  function openDraft() {
    const draft = getProjectSortLayouts($plannerStore).find((s) => !s.savedAt)
    if (draft) {
      select(draft.id)
      return
    }
    if (!scene) return
    const seed: ProjectSort = {
      id: createId('sort'),
      startedAt: new Date().toISOString(),
      slips: [],
      strokes: [],
    }
    const next = syncSortProjects(seed, $plannerStore.projects, scene.measure)
    if (next.slips.length === 1) {
      const block = layoutSheet(next.slips, scene.measure).blocks[0]
      next.slips = [{ ...next.slips[0], outline: standardOutline(block) }]
    }
    select(next.id)
    write(next)
  }
  function write(next: ProjectSort, prev?: ProjectSort) {
    lastWritten = next
    plannerStore.putProjectSort(next, prev)
    // The next coalesced pointer sample may arrive before Svelte flushes.
    if (
      scene &&
      selectedId === next.id &&
      getProjectSortLayouts($plannerStore).find((s) => s.id === next.id) === next
    ) {
      scene.update(next)
      segmentCache = scene.cutting ? sheetSegments(next, scene.sheet) : []
    }
  }
  function checkpoint(record: ProjectSort) {
    before = [...before.slice(-39), record]
    after = []
  }
  function stepHistory(redo: boolean) {
    const table = scene
    if (!table?.sort || table.sort.savedAt) return
    if (table.line.length) {
      const alreadyCheckpointed = !!contactStart && before.at(-1) === contactStart
      clearGesture()
      suspendUntilMove = true
      if (!alreadyCheckpointed || redo) return
    }
    const stack = redo ? after : before,
      next = stack.at(-1)
    if (!next) return
    if (redo) {
      after = after.slice(0, -1)
      before = [...before, table.sort]
    } else {
      before = before.slice(0, -1)
      after = [...after, table.sort]
    }
    clearGesture()
    write(next, table.sort)
    suspendUntilMove = true
  }
  onMount(() => {
    let disposed = false
    const observer = new ResizeObserver(() => scene?.resize(canvas.clientWidth, canvas.clientHeight))
    void document.fonts
      .load(FONT)
      .catch(() => {})
      .then(() => {
        if (disposed) return
        scene = new SortScene(canvas)
        scene.resize(canvas.clientWidth, canvas.clientHeight)
        observer.observe(canvas)
      })
    const flush = () => {
      finishLine()
      clearGesture()
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('blur', flush)
    return () => {
      disposed = true
      finishLine()
      observer.disconnect()
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('blur', flush)
      scene?.destroy()
    }
  })
  function local(event: PointerEvent): Point {
    const b = canvas.getBoundingClientRect()
    return [
      ((event.clientX - b.left) * canvas.clientWidth) / b.width,
      ((event.clientY - b.top) * canvas.clientHeight) / b.height,
    ]
  }
  function endCut(next: ProjectSort, old: ProjectSort) {
    const start = contactStart ?? gesture ?? old
    if (before.at(-1) !== start) checkpoint(start)
    gesture = undefined
    drawing = false
    if (scene) scene.line = []
    contactEdges = []
    write(next, old)
  }
  function finishLine() {
    const table = scene
    if (!table || !gesture) return
    const points = table.line
    if (table.sort === gesture && points.length >= 2) {
      endCut(detachWithStroke(table.sort, table.sheet, points, createId('cut')), table.sort)
    } else {
      table.line = []
      gesture = undefined
      drawing = false
      contactEdges = []
    }
    table.render()
  }
  function follow(p: Point) {
    const t = scene
    if (!t?.sort || !t.cutting || t.sort.savedAt) return
    const prev = priorPointer
    priorPointer = p
    const d = prev ? distance(p, prev) : 0
    const cursor = t.cursor ?? { p, angle: -2.45, travel: 0 }
    if (prev && d > 1) {
      const angle = Math.atan2(p[1] - prev[1], p[0] - prev[0])
      const diff = Math.atan2(Math.sin(angle - cursor.angle), Math.cos(angle - cursor.angle))
      cursor.angle += diff * Math.min(0.72, d / 16)
      cursor.travel += Math.min(d, 32)
    }
    cursor.p = p
    t.cursor = cursor
    t.render()
    const paper = t.toPaper(p)
    if (suspendUntilMove) {
      suspendUntilMove = false
      return
    }
    const ink = t.onPaper(paper)
    if (!gesture) {
      if (!ink) {
        contactStart = undefined
        return
      }
      contactStart ??= t.sort
      gesture = t.sort
      drawing = true
      const entry =
        prev && !t.onPaper(t.toPaper(prev)) ? meetEdge(t.toPaper(prev), paper, segmentCache) : null
      t.line = [entry ?? paper]
      contactEdges = []
      atEdge = !!entry
      if (!entry || distance(entry, paper) < 1.2) return
    }
    const last = t.line.at(-1)
    if (!last || distance(last, paper) < 1.2) return
    const near =
      meetEdge(last, paper, segmentCache, ink ? 2.5 : 0) ?? meetEdge(last, paper, contactEdges.slice(0, -5))
    const point = near ?? paper
    if (!ink && !near) {
      finishLine()
      contactStart = undefined
      return
    }
    if (distance(last, point) > 0.1) {
      // Collapse nearly straight samples at sub-pixel tolerance, preserving
      // hand movement without accumulating thousands of redundant vertices.
      const prior = t.line.at(-2)
      const bend = prior
        ? Math.abs(
            (last[0] - prior[0]) * (point[1] - prior[1]) - (last[1] - prior[1]) * (point[0] - prior[0]),
          ) / (distance(prior, point) || 1)
        : 1
      if (prior && bend < 0.18 && distance(prior, point) < 13) {
        t.line.pop()
        contactEdges.pop()
      }
      contactEdges.push({ a: t.line.at(-1)!, b: point })
      t.line.push(point)
    }
    const reconnected = near && !atEdge
    atEdge = !!near
    if (reconnected && t.line.length > 2) {
      const next = detachWithStroke(t.sort, t.sheet, t.line, createId('cut'))
      if (next.slips.some((s, i) => s.outline && !t.sort.slips[i].outline)) {
        endCut(next, t.sort)
        if (!ink) contactStart = undefined
        priorPointer = null
        suspendUntilMove = true
        return
      }
    }
    if (!ink) {
      finishLine()
      contactStart = undefined
    }
  }
  function move(event: PointerEvent) {
    const t = scene
    if (!t || !event.isPrimary || (contact !== null && contact !== event.pointerId)) return
    const p = local(event)
    if (t.drag) {
      t.drag.cursor = p
      t.render()
      return
    }
    if (event.pointerType !== 'mouse' && contact === null) return
    const samples = event.getCoalescedEvents?.()
    if (samples?.length) for (const sample of samples) follow(local(sample))
    else follow(p)
  }
  function down(event: PointerEvent) {
    const t = scene
    if (!t?.sort || !event.isPrimary || event.button !== 0 || t.sort.savedAt) return
    canvas.focus({ preventScroll: true })
    const p = local(event)
    if (t.cutting) {
      if (event.pointerType === 'mouse') return
      contact = event.pointerId
      canvas.setPointerCapture(contact)
      follow(p)
      return
    }
    const slip = t.hit(p)
    if (!slip) return
    contact = event.pointerId
    canvas.setPointerCapture(contact)
    t.selected = slip.id
    selectedTitle = slip.title
    const pose = t.position(slip)
    t.drag = {
      id: slip.id,
      origin: p,
      cursor: p,
      fromPile: !slip.position,
      offset: slip.position ? [(pose.x - p[0]) / pose.scale, (pose.y - p[1]) / pose.scale] : [0, 0],
    }
    t.render()
  }
  function place(s: ProjectSortSlip, x: number, y: number) {
    const t = scene!
    const z = Math.max(0, ...t.sort.slips.map((s) => s.position?.z ?? 0)) + 1
    checkpoint(t.sort)
    write(
      {
        ...t.sort,
        slips: t.sort.slips.map((p) =>
          p.id === s.id ? { ...p, position: { x: clamp(x, 0, 1), y: clamp(y, 0, 1), z } } : p,
        ),
      },
      t.sort,
    )
  }
  function up(event: PointerEvent) {
    if (contact !== event.pointerId || !scene) return
    if (scene.drag) {
      scene.drag.cursor = local(event)
      const slip = scene.sort.slips.find((s) => s.id === scene!.drag!.id)!
      const pose = scene.position(slip),
        moved = distance(scene.drag.origin, local(event))
      scene.drag = null
      if (moved > 3) place(slip, pose.x / scene.w, pose.y / scene.h)
    } else finishLine()
    contact = null
    contactStart = undefined
    priorPointer = null
    scene.cursor = null
    scene.render()
  }
  function leave() {
    if (contact !== null) return
    finishLine()
    contactStart = undefined
    priorPointer = null
    if (scene) {
      scene.cursor = null
      scene.render()
    }
  }
  export function handleKey(event: KeyboardEvent) {
    const t = scene
    if (!t?.sort || library || t.sort.savedAt) return false
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      stepHistory(event.shiftKey)
      return true
    }
    if (event.target !== canvas || event.metaKey || event.ctrlKey || event.altKey) return false
    if (event.code === 'Space' || event.key === 'Enter') {
      event.preventDefault()
      if (t.cutting) {
        finishLine()
        checkpoint(t.sort)
        write(keyboardCut(t.sort, t.sheet), t.sort)
      } else if (t.sort.slips.length) {
        const i = t.sort.slips.findIndex((s) => s.id === t.selected)
        const slip = t.sort.slips[(i + 1) % t.sort.slips.length]
        t.selected = slip.id
        selectedTitle = slip.title
        t.render()
      }
      return true
    }
    if (event.key.startsWith('Arrow') && !t.cutting && t.sort.slips.length) {
      event.preventDefault()
      const s = t.sort.slips.find((s) => s.id === t.selected) ?? t.sort.slips[0],
        pos = s.position ?? { x: 0.5, y: 0.5 }
      const step = event.shiftKey ? 0.08 : 0.025
      place(
        s,
        pos.x + ({ ArrowLeft: -step, ArrowRight: step }[event.key] ?? 0),
        pos.y + ({ ArrowUp: -step, ArrowDown: step }[event.key] ?? 0),
      )
      t.selected = s.id
      selectedTitle = s.title
      return true
    }
    return false
  }
  function save() {
    if (!scene?.sort || scene.cutting || scene.sort.savedAt || !scene.sort.slips.length) return
    const current = scene.sort
    write({ ...current, savedAt: new Date().toISOString(), preview: scene.capture(), strokes: [] }, current)
    before = []
    after = []
    message = 'Saved'
  }
  async function copy() {
    if (!current?.savedAt) return
    const url = navigationURL('project-sort', current.id)
    try {
      if (isTauri())
        await invoke('write_balance_clipboard', { plainText: url, structuredPayload: '' }).catch(() =>
          navigator.clipboard.writeText(url),
        )
      else await navigator.clipboard.writeText(url)
      message = 'Link copied'
    } catch {
      message = 'Couldn’t copy the link'
    }
  }
  function history() {
    if (current?.savedAt) {
      plannerStore.copySortToProjectHistory(current.id)
      message = 'Added to Project History'
    }
  }
  const date = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
</script>

<section
  class="sort-page"
  aria-label="Project sort"
  data-balance-link={current?.savedAt ? navigationURL('project-sort', current.id) : undefined}
>
  <header class="sort-header page-header">
    <button type="button" class="ghost back" aria-label="Back to Projects" on:click={onBack}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="m10 3-5 5 5 5"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>Back
    </button>
    <h2>Project sort</h2>
    <div class="tools">
      {#if saved.length}<button
          type="button"
          class="ghost"
          aria-expanded={library}
          on:click={() => {
            finishLine()
            library = !library
          }}
        >
          Saved sorts
        </button>{/if}
      {#if current?.savedAt}<button class="ghost" type="button" on:click={openDraft}>
          {sorts.some((s) => !s.savedAt) ? 'Resume draft' : 'New sort'}
        </button>{/if}
    </div>
  </header>
  {#if library}
    <div class="library" aria-label="Saved sorts">
      {#each saved as record (record.id)}
        <button type="button" class="ghost" on:click={() => select(record.id)}>
          {#if record.preview}<img src={record.preview} alt="" />{/if}
          <span>{date(record.startedAt)}</span>
        </button>
      {/each}
    </div>
  {/if}
  <div class="sort-content" hidden={library}>
    <div class="caption">
      <div>
        <h3>{current?.savedAt ? 'Saved tabletop' : pending ? 'Cut the paper' : 'Arrange the slips'}</h3>
        {#if current}<time datetime={current.startedAt}>{date(current.startedAt)}</time>{/if}
      </div>
      {#if current?.savedAt}
        <div class="tools">
          <button type="button" class="ghost" on:click={copy}>Copy link</button><button
            type="button"
            class="ghost"
            on:click={history}
          >
            Copy to history
          </button>
        </div>
      {:else}
        <div class="tools">
          <button
            type="button"
            class="ghost"
            disabled={!before.length && !drawing}
            on:click={() => stepHistory(false)}
          >
            Undo
          </button><button
            type="button"
            class="primary"
            disabled={!current?.slips.length || !!pending}
            on:click={save}
          >
            Save
          </button>
        </div>
      {/if}
    </div>
    <div class="mat" class:cutting={!!pending} class:readonly={!!current?.savedAt}>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <canvas
        bind:this={canvas}
        tabindex="0"
        aria-label="Project sort tabletop"
        aria-describedby="sort-help"
        on:pointerdown={down}
        on:pointermove={move}
        on:pointerup={up}
        on:pointerleave={leave}
        on:pointercancel={() => {
          finishLine()
          clearGesture()
        }}
        on:wheel|nonpassive={(e) => {
          if (scene?.cutting) {
            e.preventDefault()
            finishLine()
            scene.pan(e.deltaY)
          }
        }}
      ></canvas>
      {#if current && !current.slips.length}<span class="empty">
          Add an open project to start sorting.
        </span>{/if}
    </div>
    <footer>
      <p id="sort-help">
        {current?.savedAt
          ? 'Saved ' + date(current.savedAt)
          : pending
            ? 'Trace around a title with the scissors. On touchscreens, drag to cut.'
            : 'Drag slips from the pile and arrange them on the table.'}
      </p>
      {#if current && !current.savedAt}<span class="count">
          {pending
            ? `${current.slips.length - pending} / ${current.slips.length} cut`
            : `${current.slips.filter((s) => s.position).length} / ${current.slips.length} placed`}
        </span>{/if}
    </footer>
    <span role="status">{message}</span>
    <span class="sr-only" aria-live="polite">{selectedTitle}</span>
    <ul class="sr-only" aria-label="Project slips">
      {#each current?.slips ?? [] as s (s.id)}<li>
          {s.title} · {s.position ? 'placed' : s.outline ? 'in pile' : 'on sheet'}
        </li>{/each}
    </ul>
  </div>
</section>

<style>
  @font-face {
    font-family: 'Sort handwriting';
    src: url('/fonts/Kalam-Light.ttf') format('truetype');
    font-weight: 400;
    font-display: swap;
  }
  .sort-page {
    width: 100%;
    max-width: 1180px;
    min-width: 0;
  }
  .sort-header,
  .caption,
  .tools,
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .sort-header {
    margin-bottom: 16px;
  }
  .sort-header h2,
  .caption h3,
  footer p {
    margin: 0;
  }
  .sort-header .tools,
  .caption .tools,
  .count {
    margin-left: auto;
  }
  .sort-page button {
    font-size: 14px;
    padding: 6px 11px;
  }
  .back {
    display: inline-flex;
    gap: 3px;
    align-items: center;
  }
  .caption {
    margin-bottom: 10px;
  }
  .caption h3 {
    font-size: 17px;
    font-weight: 600;
  }
  time,
  footer,
  .sort-page [role='status'] {
    color: var(--muted);
    font-size: 13px;
  }
  .count {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .mat {
    position: relative;
    border-radius: 10px;
    overflow: hidden;
    background: #40574e;
    box-shadow: inset 0 0 0 1px #263b32;
    isolation: isolate;
  }
  canvas {
    display: block;
    width: 100%;
    height: clamp(310px, 64dvh, 790px);
    touch-action: none;
    cursor: grab;
    outline-offset: -3px;
  }
  .cutting canvas {
    cursor: none;
  }
  .readonly canvas {
    cursor: default;
  }
  .empty {
    position: absolute;
    inset: 45% 0 auto;
    text-align: center;
    color: #f8f0dc;
    pointer-events: none;
  }
  footer {
    align-items: baseline;
    margin-top: 8px;
  }
  .library {
    display: grid;
    gap: 7px;
    max-width: 560px;
  }
  .library button {
    display: flex;
    text-align: left;
    gap: 12px;
    align-items: center;
  }
  .library img {
    width: 80px;
    height: 50px;
    object-fit: contain;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  @media (max-width: 560px) {
    .sort-page button {
      font-size: 13px;
      padding: 5px 8px;
    }
    .sort-header {
      gap: 5px;
    }
    .sort-header h2 {
      font-size: 20px;
    }
    .caption {
      align-items: end;
    }
    canvas {
      height: clamp(280px, 57dvh, 660px);
    }
  }
</style>
