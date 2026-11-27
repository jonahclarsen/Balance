<script lang="ts">
  import { onMount, type Snippet } from 'svelte'
  import type { Id, PlanItem } from './types'

  export let items: PlanItem[]
  export let mobile: boolean
  export let renderItem: Snippet<[PlanItem]>

  const INITIAL_ROWS = 24
  const WINDOW_THRESHOLD = 60

  let list: HTMLDivElement
  let mounted = false
  let nearbyIds: Set<Id> | null = null
  let focusedId: Id | undefined
  let pressedId: Id | undefined
  let requestedId: Id | undefined
  const rows = new Map<Id, HTMLElement>()
  const measuredHeights = new WeakMap<Element, number>()
  let intersectionObserver: IntersectionObserver | undefined
  let resizeObserver: ResizeObserver | undefined

  $: windowed = items.length > WINDOW_THRESHOLD && typeof IntersectionObserver !== 'undefined' && typeof ResizeObserver !== 'undefined'
  $: if (mounted) observeWindow(list, mobile, windowed)
  $: retainedIds = retainWithNeighbours(items, [focusedId, pressedId, requestedId])

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

  function trackRow(node: HTMLElement, id: Id) {
    rows.set(id, node)
    intersectionObserver?.observe(node)
    resizeObserver?.observe(node)
    return {
      destroy() {
        rows.delete(id)
        intersectionObserver?.unobserve(node)
        resizeObserver?.unobserve(node)
        // Ignore any observer entries queued before this row was removed.
        nearbyIds?.delete(id)
      },
    }
  }

  function observeWindow(node: HTMLElement, phone: boolean, enabled: boolean) {
    intersectionObserver?.disconnect()
    resizeObserver?.disconnect()
    nearbyIds = null
    if (!enabled) {
      intersectionObserver = undefined
      resizeObserver = undefined
      return
    }

    // Desktop scrolls inside the workspace. On phones the document scrolls.
    const intersection = new IntersectionObserver((entries) => {
      if (intersectionObserver !== intersection) return
      const next = new Set(nearbyIds)
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.ideaTrashRoot!
        if (rows.get(id) !== entry.target) continue
        if (entry.isIntersecting) next.add(id)
        else next.delete(id)
      }
      nearbyIds = next
    }, { root: phone ? null : node.closest('.workspace'), rootMargin: '420px 0px' })
    intersectionObserver = intersection

    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target.firstElementChild) measuredHeights.set(entry.target, entry.contentRect.height)
      }
    })

    for (const row of rows.values()) {
      intersectionObserver.observe(row)
      resizeObserver.observe(row)
    }
  }

  function placeholderHeight(id: Id) {
    const row = rows.get(id)
    return (row ? measuredHeights.get(row) : undefined) ?? 42
  }

  onMount(() => {
    mounted = true
    return () => {
      intersectionObserver?.disconnect()
      resizeObserver?.disconnect()
    }
  })
</script>

<svelte:window on:pointerup={releasePress} on:pointercancel={releasePress} />

<!-- svelte-ignore a11y_no_static_element_interactions (tracks presses on the descendant editors) -->
<div bind:this={list} on:focusin={trackFocus} on:focusout={trackFocus} on:pointerdown|capture={trackPress}>
  {#each items as item, index (item.id)}
    {@const visible = !windowed || (nearbyIds?.has(item.id) ?? index < INITIAL_ROWS) || retainedIds.has(item.id)}
    <div
      data-idea-trash-root={item.id}
      style:min-height={visible ? undefined : `${placeholderHeight(item.id)}px`}
      use:trackRow={item.id}
    >
      {#if visible}
        {@render renderItem(item)}
      {/if}
    </div>
  {/each}
</div>
