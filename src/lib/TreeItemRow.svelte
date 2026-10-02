<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { dragAutoScroll } from './dragAutoScroll'
  import { vibrateSteps } from './haptics'
  import { captureTreeEditorSelection, restoreTreeEditorSelection, type TreeEditorSelection } from './treeEditorSelection'
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
  export let onSelectionPointerDown: (itemId: Id, event: PointerEvent) => void = () => {}
  export let onSelectionPointerMove: (event: PointerEvent) => void = () => {}
  export let onSelectionPointerEnter: (itemId: Id) => void = () => {}
  export let onWholeRowSelectionToggle: (itemId: Id) => void = () => {}
  export let onRowClick: (event: MouseEvent) => void = () => {}

  type DropTarget = { element: HTMLElement; containerId: Id; targetId: Id; placement: MovePlacement }

  let dragSelection: TreeEditorSelection | null = null

  async function restoreDragSelection(saved: TreeEditorSelection | null) {
    if (!saved) return
    await tick()
    restoreTreeEditorSelection(saved)
  }

  let dragging = false
  let dragPointerId: number | null = null
  let activeDropTarget: DropTarget | null = null
  let dragPointer: { x: number; y: number } | null = null
  const autoScroller = dragAutoScroll(() => {
    if (dragging && dragPointer) updateDropTarget(dragPointer.x, dragPointer.y)
  })

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

  function dropTargetAt(clientX: number, clientY: number): DropTarget | null {
    const hovered = document.elementFromPoint(clientX, clientY)
    if (!(hovered instanceof Element)) return null

    const row = hovered.closest<HTMLElement>(rowSelector)
    if (row) {
      const targetId = rowItemId(row)
      if (!targetId || targetId === itemId) return null
      return { element: row, containerId: rowContainerId(row), targetId, placement: placementForRow(row, clientY) }
    }

    return null
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
    activeDropTarget?.element.classList.remove('drop-before', 'drop-inside', 'drop-after')
    activeDropTarget = null
  }

  function markDropTarget(target: DropTarget) {
    if (activeDropTarget?.element !== target.element) clearDropMarker()
    activeDropTarget = target
    target.element.classList.remove('drop-before', 'drop-inside', 'drop-after')
    target.element.classList.add(`drop-${target.placement}`)
  }

  function startPointerDrag(event: PointerEvent) {
    event.preventDefault()
    event.stopPropagation()
    dragSelection = captureTreeEditorSelection((event.currentTarget as HTMLElement).closest('.item-shell, .template-item'))
    const focusedElement = document.activeElement
    if ((event.pointerType === 'touch' || usesMobileLayout()) && focusedElement instanceof HTMLElement) {
      // Preventing the drag handle's default focus change can otherwise leave a
      // contenteditable focused, keeping Android's soft keyboard on screen.
      document.getSelection()?.removeAllRanges()
      focusedElement.blur()
    }
    // Buzz on contact so the handle feels grabbed immediately instead of
    // waiting for the platform's long-press haptic.
    if (event.pointerType === 'touch') vibrateSteps()
    dragging = true
    dragPointerId = event.pointerId
    dragPointer = { x: event.clientX, y: event.clientY }
    if (usesMobileLayout()) autoScroller.start(event.currentTarget as HTMLElement, event.clientX, event.clientY)
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    window.addEventListener('pointermove', continuePointerDrag)
    window.addEventListener('pointerup', endPointerDrag)
    window.addEventListener('pointercancel', cancelPointerDrag)
  }

  function continuePointerDrag(event: PointerEvent) {
    if (!dragging || event.pointerId !== dragPointerId) return
    dragPointer = { x: event.clientX, y: event.clientY }
    autoScroller.move(event.clientX, event.clientY)
    updateDropTarget(event.clientX, event.clientY)
  }

  function updateDropTarget(clientX: number, clientY: number) {
    const target = dropTargetAt(clientX, clientY)
    if (!target || target.containerId !== containerId) {
      clearDropMarker()
      return
    }
    markDropTarget(target)
  }

  function usesMobileLayout() {
    return window.matchMedia('(max-width: 760px)').matches
  }

  function stopAutoScroll() {
    dragPointer = null
    autoScroller.stop()
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
    const savedSelection = dragSelection
    dragSelection = null
    if (target && target.containerId === containerId && target.targetId !== itemId) {
      moveItem(containerId, itemId, target.targetId, target.placement)
    }
    void restoreDragSelection(savedSelection)
  }

  function cancelPointerDrag(event: PointerEvent) {
    if (event.pointerId !== dragPointerId) return
    dragging = false
    clearDropMarker()
    removeDragListeners()
    stopAutoScroll()
    const savedSelection = dragSelection
    dragSelection = null
    void restoreDragSelection(savedSelection)
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
        on:contextmenu|preventDefault
      >
        <span class="handle-dots" aria-hidden="true"></span>
      </button>
    {/if}

    <slot></slot>
  </div>

  <slot name="children"></slot>
</div>
