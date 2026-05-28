<script lang="ts">
  import { tick } from 'svelte'
  import AlarmClockIcon from './AlarmClockIcon.svelte'
  import { defaultPlanItemTimeRange } from './planner'
  import RichTextEditor from './RichTextEditor.svelte'
  import TimeRange from './TimeRange.svelte'
  import type { Id, MoveDirection, MovePlacement, PlanItem } from './types'

  export let item: PlanItem
  export let allItems: PlanItem[]
  export let depth = 0
  export let planId: Id
  export let parentId: Id | null = null
  export let patchItem: (planId: Id, itemId: Id, patch: Partial<Omit<PlanItem, 'id' | 'children'>>) => void
  export let splitItem: (
    planId: Id,
    itemId: Id,
    patch: Partial<Omit<PlanItem, 'id' | 'children'>>,
    after: { html: string; text: string },
  ) => Id
  export let addChild: (planId: Id, parentId: Id) => void
  export let deleteItem: (planId: Id, itemId: Id) => void
  export let moveItem: (planId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  export let moveItemWithinLevel: (planId: Id, itemId: Id, direction: MoveDirection) => void
  export let outdentItem: (planId: Id, itemId: Id) => void
  export let historyRevision: number
  export let selectedItemIds: Set<Id> = new Set()
  export let selectionDragging = false
  export let onSelectionPointerDown: (itemId: Id, event: PointerEvent) => void = () => {}
  export let onSelectionPointerMove: (event: PointerEvent) => void = () => {}
  export let onSelectionPointerEnter: (itemId: Id) => void = () => {}
  export let onTextShiftArrow: (itemId: Id, direction: MoveDirection) => void = () => {}

  let dragging = false
  let activeDropRow: HTMLElement | null = null
  $: selected = selectedItemIds.has(item.id)

  function addTime() {
    patchItem(planId, item.id, defaultPlanItemTimeRange(allItems, item.id))
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
    const row = hovered instanceof Element ? hovered.closest<HTMLElement>('[data-plan-item-id]') : null

    if (!row || row.dataset.planItemId === item.id) {
      clearDropMarker()
      return
    }

    markDropTarget(row, placementForRow(row, event.clientY))
  }

  function endPointerDrag(event: PointerEvent) {
    if (!dragging) return

    const row = activeDropRow
    const targetId = row?.dataset.planItemId
    const placement = row ? placementForRow(row, event.clientY) : null

    clearDropMarker()
    dragging = false

    if (targetId && targetId !== item.id && placement) {
      moveItem(planId, item.id, targetId, placement)
    }
  }

  async function handleTextArrowKey(direction: MoveDirection, current: HTMLDivElement, event: KeyboardEvent) {
    if (event.altKey) {
      moveItemWithinLevel(planId, item.id, direction)
      await tick()
      focusItemTextInput(item.id)
      return
    }

    if (event.shiftKey) {
      onTextShiftArrow(item.id, direction)
      return
    }

    focusAdjacentTextInput(current, direction)
  }

  async function handleTextSplit(before: { html: string; text: string }, after: { html: string; text: string }) {
    const newItemId = splitItem(planId, item.id, before, after)
    await tick()
    focusItemTextInput(newItemId, 'start')
  }

  async function handleBackspaceEmpty(current: HTMLDivElement) {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-plan-text-input]'))
    const index = inputs.indexOf(current)

    deleteItem(planId, item.id)
    await tick()

    const nextInputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-plan-text-input]'))
    const target = nextInputs[Math.max(0, index - 1)] ?? nextInputs[0]
    if (target) focusTextInput(target)
  }

  async function handleTextTab(direction: 'in' | 'out', current: HTMLDivElement) {
    if (direction === 'in') {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-plan-item-id]'))
      const currentRow = current.closest<HTMLElement>('[data-plan-item-id]')
      const index = currentRow ? rows.indexOf(currentRow) : -1
      const targetId = findPreviousSameDepthPlanItemId(rows, index)

      if (targetId) {
        moveItem(planId, item.id, targetId, 'inside')
        await tick()
        focusItemTextInput(item.id)
      }
      return
    }

    if (parentId) {
      outdentItem(planId, item.id)
      await tick()
      focusItemTextInput(item.id)
    }
  }

  function findPreviousSameDepthPlanItemId(rows: HTMLElement[], currentIndex: number): Id | null {
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const rowDepth = Number(rows[index].dataset.planItemDepth ?? 0)

      if (rowDepth === depth) return rows[index].dataset.planItemId ?? null
      if (rowDepth < depth) return null
    }

    return null
  }

  function focusAdjacentTextInput(current: HTMLDivElement, direction: MoveDirection) {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-plan-text-input]'))
    const index = inputs.indexOf(current)
    const target = inputs[direction === 'up' ? index - 1 : index + 1]

    if (target) focusTextInput(target)
  }

  function focusItemTextInput(itemId: Id, position: 'start' | 'end' = 'end') {
    const input = Array.from(document.querySelectorAll<HTMLDivElement>('[data-plan-text-input]')).find(
      (candidate) => candidate.dataset.planTextInputId === itemId,
    )

    if (input) focusTextInput(input, position)
  }

  function focusTextInput(input: HTMLDivElement, position: 'start' | 'end' = 'end') {
    input.focus()
    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(position === 'start')

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
</script>

<div class="item-shell" style={`--depth: ${depth}`}>
  <div
    class="plan-row"
    data-plan-item-id={item.id}
    data-plan-item-depth={depth}
    role="listitem"
    aria-label={`Plan item: ${item.text || 'Untitled'}`}
    class:selected
    on:pointerenter={() => {
      if (selectionDragging) onSelectionPointerEnter(item.id)
    }}
  >
    <button
      class="select-handle"
      class:selected
      type="button"
      title={selected ? 'Selected' : 'Select item'}
      aria-label={selected ? 'Selected item' : 'Select item'}
      aria-pressed={selected}
      on:pointerdown={(event) => onSelectionPointerDown(item.id, event)}
      on:pointermove={onSelectionPointerMove}
    ></button>

    <button
      class="drag-handle"
      class:dragging
      type="button"
      title="Drag to move item"
      aria-label="Drag to move item"
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

    <label class="check-target" title="Complete item">
      <input
        class="check"
        type="checkbox"
        checked={item.done}
        on:change={(event) => patchItem(planId, item.id, { done: event.currentTarget.checked })}
        aria-label="Complete item"
      />
    </label>

    {#if item.startMinutes !== null && item.endMinutes !== null}
      <TimeRange
        startMinutes={item.startMinutes}
        endMinutes={item.endMinutes}
        onChange={(startMinutes, endMinutes) => patchItem(planId, item.id, { startMinutes, endMinutes })}
        onRemove={() => patchItem(planId, item.id, { startMinutes: null, endMinutes: null })}
      />
    {:else}
      <button
        class="icon-button quiet add-time"
        type="button"
        title="Add time range"
        aria-label="Add time range"
        on:click={addTime}
      >
        <AlarmClockIcon />
      </button>
    {/if}

    <RichTextEditor
      className="item-text"
      kind="plan"
      inputId={item.id}
      html={item.html}
      text={item.text}
      done={item.done}
      placeholder="Plan item"
      ariaLabel="Plan item"
      revision={historyRevision}
      onChange={(html, text) => patchItem(planId, item.id, { html, text })}
      onArrowKey={handleTextArrowKey}
      onSplit={handleTextSplit}
      onBackspaceEmpty={handleBackspaceEmpty}
      onTabKey={handleTextTab}
    />

    <div class="row-actions">
      <button class="icon-button" type="button" title="Add child item" on:click={() => addChild(planId, item.id)}>↳</button>
      <button class="icon-button danger" type="button" title="Delete item" on:click={() => deleteItem(planId, item.id)}>×</button>
    </div>
  </div>

  {#if item.children.length > 0}
    <div class="children">
      {#each item.children as child (child.id)}
        <svelte:self
          item={child}
          {allItems}
          depth={depth + 1}
          {planId}
          parentId={item.id}
          {patchItem}
          {splitItem}
          {addChild}
          {deleteItem}
          {moveItem}
          {moveItemWithinLevel}
          {outdentItem}
          {historyRevision}
          {selectedItemIds}
          {selectionDragging}
          {onSelectionPointerDown}
          {onSelectionPointerMove}
          {onSelectionPointerEnter}
          {onTextShiftArrow}
        />
      {/each}
    </div>
  {/if}
</div>
