<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { Id, MovePlacement } from './types'

  type TreeItemRowKind = 'plan' | 'day-template' | 'list-template' | 'metric' | 'note'

  export let kind: TreeItemRowKind
  export let itemId: Id
  export let containerId: Id
  export let depth = 0
  export let ariaLabel: string
  export let dragLabel = 'Drag to move item'
  export let selected = false
  export let done = false
  export let selectionDragging = false
  export let wholeRowSelection = false
  export let interactive = true
  export let showSelectionHandle = true
  export let moveItem: (containerId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  // Set only where dropping into a *different* container is meaningful (the
  // side-by-side day comparison). Left null everywhere else, so a drag that
  // wanders outside its own container is simply ignored, as before. `targetId`
  // is null when the drop lands on a container's empty tail zone.
  export let moveItemAcrossContainers:
    | ((sourceContainerId: Id, sourceId: Id, targetContainerId: Id, targetId: Id | null, placement: MovePlacement) => void)
    | null = null
  export let onSelectionPointerDown: (itemId: Id, event: PointerEvent) => void = () => {}
  export let onSelectionPointerMove: (event: PointerEvent) => void = () => {}
  export let onSelectionPointerEnter: (itemId: Id) => void = () => {}
  export let onWholeRowSelectionToggle: (itemId: Id) => void = () => {}
  export let onRowClick: (event: MouseEvent) => void = () => {}

  type DropTarget = { element: HTMLElement; containerId: Id; targetId: Id | null; placement: MovePlacement }

  let dragging = false
  let dragPointerId: number | null = null
  let activeDropTarget: DropTarget | null = null
  let dragPointer: { x: number; y: number } | null = null
  let dragScrollContainer: HTMLElement | null = null
  let autoScrollFrame: number | null = null

  const AUTO_SCROLL_EDGE = 44
  const AUTO_SCROLL_MAX_SPEED = 2

  $: rowSelector =
    kind === 'plan'
      ? '[data-plan-item-id]'
      : kind === 'day-template'
        ? '[data-template-item-id]'
        : kind === 'list-template'
          ? '[data-list-template-item-id]'
          : kind === 'metric'
            ? '[data-metric-question-id]'
          : '[data-note-item-id]'

  function rowItemId(row: HTMLElement): Id | null {
    if (kind === 'plan') return row.dataset.planItemId ?? null
    if (kind === 'day-template') return row.dataset.templateItemId ?? null
    if (kind === 'list-template') return row.dataset.listTemplateItemId ?? null
    if (kind === 'metric') return row.dataset.metricQuestionId ?? null
    return row.dataset.noteItemId ?? null
  }

  function rowContainerId(row: HTMLElement): Id {
    return row.dataset.itemContainerId ?? containerId
  }

  // Resolves what is under the pointer: a row in this or another container, or a
  // container's tail drop zone (which appends to the end of that container).
  function dropTargetAt(clientX: number, clientY: number): DropTarget | null {
    const hovered = document.elementFromPoint(clientX, clientY)
    if (!(hovered instanceof Element)) return null

    const row = hovered.closest<HTMLElement>(rowSelector)
    if (row) {
      const targetId = rowItemId(row)
      if (!targetId || targetId === itemId) return null
      return { element: row, containerId: rowContainerId(row), targetId, placement: placementForRow(row, clientY) }
    }

    const zone = moveItemAcrossContainers ? hovered.closest<HTMLElement>('[data-item-drop-zone]') : null
    const zoneContainerId = zone?.dataset.itemDropZone
    if (!zone || !zoneContainerId || zoneContainerId === containerId) return null

    return { element: zone, containerId: zoneContainerId, targetId: null, placement: 'after' }
  }

  function placementForRow(row: HTMLElement, clientY: number): MovePlacement {
    const rect = row.getBoundingClientRect()
    const y = clientY - rect.top
    if (kind === 'metric') return y < rect.height / 2 ? 'before' : 'after'
    if (y < rect.height * 0.28) return 'before'
    if (y > rect.height * 0.72) return 'after'
    return 'inside'
  }

  function clearDropMarker() {
    activeDropTarget?.element.classList.remove('drop-before', 'drop-inside', 'drop-after', 'drop-into-container')
    activeDropTarget = null
  }

  function markDropTarget(target: DropTarget) {
    if (activeDropTarget?.element !== target.element) clearDropMarker()
    activeDropTarget = target
    target.element.classList.remove('drop-before', 'drop-inside', 'drop-after', 'drop-into-container')
    target.element.classList.add(target.targetId ? `drop-${target.placement}` : 'drop-into-container')
  }

  function startPointerDrag(event: PointerEvent) {
    event.preventDefault()
    event.stopPropagation()
    const focusedElement = document.activeElement
    if ((event.pointerType === 'touch' || usesMobileLayout()) && focusedElement instanceof HTMLElement) {
      // Preventing the drag handle's default focus change can otherwise leave a
      // contenteditable focused, keeping Android's soft keyboard on screen.
      document.getSelection()?.removeAllRanges()
      focusedElement.blur()
    }
    dragging = true
    dragPointerId = event.pointerId
    dragPointer = { x: event.clientX, y: event.clientY }
    dragScrollContainer = nearestScrollContainer(event.currentTarget as HTMLElement)
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    window.addEventListener('pointermove', continuePointerDrag)
    window.addEventListener('pointerup', endPointerDrag)
    window.addEventListener('pointercancel', cancelPointerDrag)
  }

  function continuePointerDrag(event: PointerEvent) {
    if (!dragging || event.pointerId !== dragPointerId) return
    dragPointer = { x: event.clientX, y: event.clientY }
    scheduleAutoScroll()
    updateDropTarget(event.clientX, event.clientY)
  }

  function updateDropTarget(clientX: number, clientY: number) {
    const target = dropTargetAt(clientX, clientY)
    if (!target || (target.containerId !== containerId && !moveItemAcrossContainers)) {
      clearDropMarker()
      return
    }
    markDropTarget(target)
  }

  function scheduleAutoScroll() {
    if (!usesMobileLayout() || autoScrollFrame !== null) return
    autoScrollFrame = requestAnimationFrame(autoScroll)
  }

  function autoScroll() {
    autoScrollFrame = null
    if (!dragging || !dragPointer) return

    const scrollContainer = dragScrollContainer
    if (!scrollContainer) return

    const bounds = scrollBounds(scrollContainer)
    const delta = autoScrollDelta(dragPointer.y, bounds.top, bounds.bottom)
    if (delta === 0) return

    const previousScrollTop = scrollContainer.scrollTop
    scrollContainer.scrollBy({ top: delta, left: 0, behavior: 'instant' })
    if (scrollContainer.scrollTop !== previousScrollTop) updateDropTarget(dragPointer.x, dragPointer.y)
    scheduleAutoScroll()
  }

  function autoScrollDelta(clientY: number, top: number, bottom: number) {
    if (clientY < top + AUTO_SCROLL_EDGE) {
      return -Math.ceil(
        AUTO_SCROLL_MAX_SPEED * (1 - Math.max(0, clientY - top) / AUTO_SCROLL_EDGE),
      )
    }
    if (clientY > bottom - AUTO_SCROLL_EDGE) {
      return Math.ceil(
        AUTO_SCROLL_MAX_SPEED * (1 - Math.max(0, bottom - clientY) / AUTO_SCROLL_EDGE),
      )
    }
    return 0
  }

  function nearestScrollContainer(start: HTMLElement) {
    let candidate = start.parentElement
    while (candidate) {
      const overflowY = getComputedStyle(candidate).overflowY
      if (/(auto|scroll|overlay)/.test(overflowY) && candidate.scrollHeight > candidate.clientHeight) return candidate
      candidate = candidate.parentElement
    }
    return document.scrollingElement as HTMLElement | null
  }

  function scrollBounds(scrollContainer: HTMLElement) {
    if (scrollContainer === document.scrollingElement) {
      return { top: 0, bottom: window.visualViewport?.height ?? window.innerHeight }
    }
    const rect = scrollContainer.getBoundingClientRect()
    return {
      top: Math.max(0, rect.top),
      bottom: Math.min(window.visualViewport?.height ?? window.innerHeight, rect.bottom),
    }
  }

  function usesMobileLayout() {
    return window.matchMedia('(max-width: 760px)').matches
  }

  function stopAutoScroll() {
    dragPointer = null
    dragScrollContainer = null
    if (autoScrollFrame === null) return
    cancelAnimationFrame(autoScrollFrame)
    autoScrollFrame = null
  }

  function endPointerDrag(event: PointerEvent) {
    if (!dragging || event.pointerId !== dragPointerId) return
    // Re-resolve at the drop point: the pointer may have moved within the last
    // hovered row, which changes before/inside/after.
    const target = dropTargetAt(event.clientX, event.clientY) ?? activeDropTarget
    clearDropMarker()
    dragging = false
    removeDragListeners()
    stopAutoScroll()
    if (!target) return

    if (target.containerId !== containerId) {
      moveItemAcrossContainers?.(containerId, itemId, target.containerId, target.targetId, target.placement)
      return
    }

    if (target.targetId && target.targetId !== itemId) {
      moveItem(containerId, itemId, target.targetId, target.placement)
    }
  }

  function cancelPointerDrag(event: PointerEvent) {
    if (event.pointerId !== dragPointerId) return
    dragging = false
    clearDropMarker()
    removeDragListeners()
    stopAutoScroll()
  }

  function removeDragListeners() {
    dragPointerId = null
    window.removeEventListener('pointermove', continuePointerDrag)
    window.removeEventListener('pointerup', endPointerDrag)
    window.removeEventListener('pointercancel', cancelPointerDrag)
  }

  onDestroy(() => {
    removeDragListeners()
    stopAutoScroll()
    clearDropMarker()
  })

</script>

<div
  class:item-shell={kind === 'plan'}
  class:template-item={kind !== 'plan'}
  style={`--depth: ${depth}`}
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div
    class:plan-row={kind === 'plan'}
    class:template-main={kind !== 'plan'}
    class:whole-row-selection={wholeRowSelection}
    class:done
    class:selected
    data-item-container-id={containerId}
    data-plan-item-id={kind === 'plan' ? itemId : undefined}
    data-plan-item-depth={kind === 'plan' ? depth : undefined}
    data-template-item-id={kind === 'day-template' ? itemId : undefined}
    data-template-item-depth={kind === 'day-template' ? depth : undefined}
    data-list-template-item-id={kind === 'list-template' ? itemId : undefined}
    data-list-template-item-depth={kind === 'list-template' ? depth : undefined}
    data-metric-question-id={kind === 'metric' ? itemId : undefined}
    data-note-item-id={kind === 'note' ? itemId : undefined}
    data-note-item-depth={kind === 'note' ? depth : undefined}
    role="listitem"
    aria-label={ariaLabel}
    on:click={onRowClick}
    on:pointerenter={() => {
      if (selectionDragging) onSelectionPointerEnter(itemId)
    }}
  >
    {#if wholeRowSelection}
      <!-- The visible selection toggle remains the accessible control. This
           layer makes the rest of the row one large mobile tap target without
           letting its editor, checkbox, or time button take focus first. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="whole-row-selection-target"
        aria-hidden="true"
        on:pointerdown|preventDefault|stopPropagation
        on:click|preventDefault|stopPropagation={() => onWholeRowSelectionToggle(itemId)}
      ></div>
    {/if}

    {#if interactive && showSelectionHandle}
      <button
        class="select-handle"
        class:selected
        type="button"
        title={selected ? 'Selected' : 'Select item'}
        aria-label={selected ? 'Selected item' : 'Select item'}
        aria-pressed={selected}
        on:pointerdown={(event) => onSelectionPointerDown(itemId, event)}
        on:pointermove={onSelectionPointerMove}
      ></button>
    {/if}

    {#if interactive}
      <button
        class="drag-handle"
        class:dragging
        type="button"
        title={dragLabel}
        aria-label={dragLabel}
        on:pointerdown={startPointerDrag}
      >
        <span class="handle-dots" aria-hidden="true"></span>
      </button>
    {/if}

    <slot></slot>
  </div>

  <slot name="children"></slot>
</div>
