<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte'
  import type { Id, PlanItem } from './types'

  export let items: PlanItem[]
  export let mobile: boolean
  // Find in current view searches and highlights live DOM ranges.
  export let renderAll: boolean
  export let renderItem: Snippet<[PlanItem]>

  const WINDOW_THRESHOLD = 60
  const OVERSCAN = 420

  let list: HTMLDivElement
  let start = 0
  let end = 24
  let focusedId: Id | undefined
  let pressedId: Id | undefined
  let requestedId: Id | undefined
  let frame: number | undefined
  let wasRenderingAll = false
  const measuredHeights = new Map<Id, number>()

  $: windowed = items.length > WINDOW_THRESHOLD
  $: retainedIds = retainWithNeighbours(items, [focusedId, pressedId, requestedId])
  $: if (list) rememberFindHeights(list, renderAll)

  function measureRows(rows: HTMLCollection, first: number, last: number) {
    for (let index = first; index < Math.min(last, rows.length); index += 1) {
      const row = rows[index] as HTMLElement
      if (row.firstElementChild) {
        measuredHeights.set(row.dataset.ideaTrashRoot!, row.getBoundingClientRect().height / (row.currentCSSZoom || 1))
      }
    }
  }

  function rememberFindHeights(node: HTMLElement, all: boolean) {
    if (wasRenderingAll && !all && windowed) {
      // Keep the search result in view as its preceding rows become placeholders.
      measureRows(node.children, 0, node.children.length)
      void updateWindow()
    }
    wasRenderingAll = all
  }

  function retainWithNeighbours(items: PlanItem[], ids: (Id | undefined)[]) {
    const retained = new Set<Id>()
    for (const id of ids) {
      if (!id) continue
      const index = items.findIndex((item) => item.id === id)
      if (index === -1) continue
      for (const item of items.slice(Math.max(0, index - 1), index + 2)) retained.add(item.id)
    }
    return retained
  }

  // Programmatic focus and links can target an idea outside the viewport.
  export function include(rootId: Id) {
    requestedId = rootId
  }

  function rootAt(target: EventTarget | null) {
    const row = target instanceof Element ? target.closest<HTMLElement>('[data-idea-trash-root]') : null
    return row?.parentElement === list ? row.dataset.ideaTrashRoot : undefined
  }

  function trackFocus(event: FocusEvent) {
    focusedId = rootAt(event.type === 'focusin' ? event.target : event.relatedTarget)
  }

  function trackPress(event: PointerEvent) {
    if (event.button === 0) pressedId = rootAt(event.target)
  }

  function releasePress() {
    pressedId = undefined
  }

  // Placeholders keep one layout box per root, in list order. Search their
  // positions instead of observing each one or laying out thousands of editors.
  function lowerBound(rows: HTMLCollection, y: number, edge: 'top' | 'bottom') {
    let low = 0
    let high = rows.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (rows[middle]!.getBoundingClientRect()[edge] < y) low = middle + 1
      else high = middle
    }
    return low
  }

  function scheduleWindow() {
    if (!windowed || frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      void updateWindow()
    })
  }

  async function updateWindow() {
    if (!windowed || !list?.isConnected) return
    const scroller = mobile ? document.scrollingElement : list.closest('.workspace')
    if (!scroller) return
    const viewport = mobile ? null : scroller.getBoundingClientRect()
    const top = viewport?.top ?? 0
    const bottom = viewport?.bottom ?? window.innerHeight
    const rows = list.children
    const nextStart = lowerBound(rows, top - OVERSCAN, 'bottom')
    const nextEnd = lowerBound(rows, bottom + OVERSCAN, 'top')
    if (start === nextStart && end === nextEnd) return

    measureRows(rows, start, end)

    const atEnd = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1
    const anchor = rows[lowerBound(rows, top, 'bottom')]
    const anchorTop = anchor?.getBoundingClientRect().top
    start = nextStart
    end = nextEnd
    if (renderAll) return

    await tick()
    if (!list?.isConnected) return
    // Mounting a group of wrapped or nested ideas changes the estimated list
    // height. Keep the viewport stable, even in WebKit and at the very end.
    if (atEnd) scroller.scrollTop = scroller.scrollHeight
    else if (anchor?.isConnected && anchorTop !== undefined) {
      const shift = anchor.getBoundingClientRect().top - anchorTop
      if (shift) scroller.scrollTop += shift / (anchor.currentCSSZoom || 1)
    }
  }

  onMount(() => {
    const resizeObserver = new ResizeObserver(scheduleWindow)
    resizeObserver.observe(list)
    scheduleWindow()
    return () => {
      resizeObserver.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  })
</script>

<svelte:window on:scroll|capture|passive={scheduleWindow} on:resize={scheduleWindow} on:pointerup={releasePress} on:pointercancel={releasePress} />

<!-- svelte-ignore a11y_no_static_element_interactions (tracks presses on the descendant editors) -->
<div bind:this={list} on:focusin={trackFocus} on:focusout={trackFocus} on:pointerdown|capture={trackPress}>
  {#each items as item, index (item.id)}
    {@const visible = renderAll || !windowed || (index >= start && index < end) || retainedIds.has(item.id)}
    <div data-idea-trash-root={item.id} style:min-height={visible ? undefined : `${measuredHeights.get(item.id) ?? 42}px`}>
      {#if visible}
        {@render renderItem(item)}
      {/if}
    </div>
  {/each}
</div>
