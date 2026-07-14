<script lang="ts">
  import type { Id, MovePlacement } from './types'

  type TreeItemRowKind = 'plan' | 'day-template' | 'list-template'

  export let kind: TreeItemRowKind
  export let itemId: Id
  export let containerId: Id
  export let depth = 0
  export let ariaLabel: string
  export let dragLabel = 'Drag to move item'
  export let selected = false
  export let done = false
  export let selectionDragging = false
  export let interactive = true
  export let moveItem: (containerId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  export let onSelectionPointerDown: (itemId: Id, event: PointerEvent) => void = () => {}
  export let onSelectionPointerMove: (event: PointerEvent) => void = () => {}
  export let onSelectionPointerEnter: (itemId: Id) => void = () => {}
  export let onRowClick: (event: MouseEvent) => void = () => {}

  let dragging = false
  let activeDropRow: HTMLElement | null = null

  $: rowSelector =
    kind === 'plan'
      ? '[data-plan-item-id]'
      : kind === 'day-template'
        ? '[data-template-item-id]'
        : '[data-list-template-item-id]'

  function rowItemId(row: HTMLElement): Id | null {
    if (kind === 'plan') return row.dataset.planItemId ?? null
    if (kind === 'day-template') return row.dataset.templateItemId ?? null
    return row.dataset.listTemplateItemId ?? null
  }

  function placementForRow(row: HTMLElement, clientY: number): MovePlacement {
    const rect = row.getBoundingClientRect()
    const y = clientY - rect.top
    if (y < rect.height * 0.28) return 'before'
    if (y > rect.height * 0.72) return 'after'
    return 'inside'
  }

  function clearDropMarker() {
    activeDropRow?.classList.remove('drop-before', 'drop-inside', 'drop-after')
    activeDropRow = null
  }

  function markDropTarget(row: HTMLElement, placement: MovePlacement) {
    if (activeDropRow !== row) clearDropMarker()
    activeDropRow = row
    row.classList.remove('drop-before', 'drop-inside', 'drop-after')
    row.classList.add(`drop-${placement}`)
  }

  function startPointerDrag(event: PointerEvent) {
    event.preventDefault()
    event.stopPropagation()
    dragging = true
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function continuePointerDrag(event: PointerEvent) {
    if (!dragging) return
    const hovered = document.elementFromPoint(event.clientX, event.clientY)
    const row = hovered instanceof Element ? hovered.closest<HTMLElement>(rowSelector) : null
    if (!row || rowItemId(row) === itemId) {
      clearDropMarker()
      return
    }
    markDropTarget(row, placementForRow(row, event.clientY))
  }

  function endPointerDrag(event: PointerEvent) {
    if (!dragging) return
    const row = activeDropRow
    const targetId = row ? rowItemId(row) : null
    const placement = row ? placementForRow(row, event.clientY) : null
    clearDropMarker()
    dragging = false
    if (targetId && targetId !== itemId && placement) moveItem(containerId, itemId, targetId, placement)
  }
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
    class:done
    class:selected
    data-plan-item-id={kind === 'plan' ? itemId : undefined}
    data-plan-item-depth={kind === 'plan' ? depth : undefined}
    data-template-item-id={kind === 'day-template' ? itemId : undefined}
    data-template-item-depth={kind === 'day-template' ? depth : undefined}
    data-list-template-item-id={kind === 'list-template' ? itemId : undefined}
    data-list-template-item-depth={kind === 'list-template' ? depth : undefined}
    role="listitem"
    aria-label={ariaLabel}
    on:click={onRowClick}
    on:pointerenter={() => {
      if (selectionDragging) onSelectionPointerEnter(itemId)
    }}
  >
    {#if interactive}
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

      <button
        class="drag-handle"
        class:dragging
        type="button"
        title={dragLabel}
        aria-label={dragLabel}
        on:pointerdown={startPointerDrag}
        on:pointermove={continuePointerDrag}
        on:pointerup={endPointerDrag}
        on:pointercancel={() => {
          dragging = false
          clearDropMarker()
        }}
      >
        <span class="handle-dots" aria-hidden="true"></span>
      </button>
    {/if}

    <slot></slot>
  </div>

  <slot name="children"></slot>
</div>
