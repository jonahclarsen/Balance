<script lang="ts">
  import { tick } from 'svelte'
  import TimeRange from './TimeRange.svelte'
  import { escapeHTML, htmlToPlainText, isURL, sanitizeInlineHTML } from './planner'
  import type { Id, MoveDirection, MovePlacement, PlanItem } from './types'

  export let item: PlanItem
  export let depth = 0
  export let planId: Id
  export let patchItem: (planId: Id, itemId: Id, patch: Partial<Omit<PlanItem, 'id' | 'children'>>) => void
  export let addChild: (planId: Id, parentId: Id) => void
  export let deleteItem: (planId: Id, itemId: Id) => void
  export let moveItem: (planId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  export let moveItemWithinLevel: (planId: Id, itemId: Id, direction: MoveDirection) => void
  export let historyRevision: number

  let dragging = false
  let activeDropRow: HTMLElement | null = null
  let textEditor: HTMLDivElement
  let renderedHTML = item.html || escapeHTML(item.text)
  let lastHistoryRevision = historyRevision

  $: {
    const nextHTML = item.html || escapeHTML(item.text)
    const historyWasApplied = historyRevision !== lastHistoryRevision

    if (historyWasApplied) {
      lastHistoryRevision = historyRevision
      renderedHTML = nextHTML
      if (textEditor) {
        textEditor.innerHTML = nextHTML
        if (textEditor === document.activeElement) focusTextInput(textEditor)
      }
    } else if (nextHTML !== renderedHTML && textEditor !== document.activeElement) {
      renderedHTML = nextHTML
      if (textEditor) textEditor.innerHTML = nextHTML
    }
  }

  function addTime() {
    patchItem(planId, item.id, {
      startMinutes: 9 * 60,
      endMinutes: 10 * 60,
    })
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

  async function handleTextKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault()
      document.execCommand('bold')
      persistEditor(event.currentTarget as HTMLDivElement, false)
      return
    }

    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'i') {
      event.preventDefault()
      document.execCommand('italic')
      persistEditor(event.currentTarget as HTMLDivElement, false)
      return
    }

    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (event.metaKey || event.ctrlKey) return

    event.preventDefault()
    const direction: MoveDirection = event.key === 'ArrowUp' ? 'up' : 'down'

    if (event.altKey) {
      moveItemWithinLevel(planId, item.id, direction)
      await tick()
      focusItemTextInput(item.id)
      return
    }

    focusAdjacentTextInput(event.currentTarget as HTMLDivElement, direction)
  }

  function handleTextInput(event: Event) {
    persistEditor(event.currentTarget as HTMLDivElement, false)
  }

  function handlePaste(event: ClipboardEvent) {
    const editor = event.currentTarget as HTMLDivElement
    const clipboardText = event.clipboardData?.getData('text/plain') ?? ''
    const clipboardHTML = event.clipboardData?.getData('text/html') ?? ''

    if (clipboardText && isURL(clipboardText) && hasNonCollapsedSelectionInside(editor)) {
      event.preventDefault()
      document.execCommand('createLink', false, clipboardText.trim())
      persistEditor(editor, false)
      return
    }

    if (clipboardHTML || clipboardText) {
      event.preventDefault()
      const html = clipboardHTML
        ? sanitizeInlineHTML(clipboardHTML)
        : escapeHTML(clipboardText).replace(/\r?\n/g, '<br>')
      document.execCommand('insertHTML', false, html)
      persistEditor(editor, false)
    }
  }

  function persistEditor(editor: HTMLDivElement, syncRenderedHTML = true) {
    const html = sanitizeInlineHTML(editor.innerHTML)
    if (syncRenderedHTML && editor.innerHTML !== html) editor.innerHTML = html
    if (syncRenderedHTML) renderedHTML = html
    patchItem(planId, item.id, {
      html,
      text: htmlToPlainText(html),
    })
  }

  function hasNonCollapsedSelectionInside(editor: HTMLDivElement) {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false

    const range = selection.getRangeAt(0)
    return editor.contains(range.commonAncestorContainer)
  }

  function focusAdjacentTextInput(current: HTMLDivElement, direction: MoveDirection) {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-plan-text-input]'))
    const index = inputs.indexOf(current)
    const target = inputs[direction === 'up' ? index - 1 : index + 1]

    if (target) focusTextInput(target)
  }

  function focusItemTextInput(itemId: Id) {
    const input = Array.from(document.querySelectorAll<HTMLDivElement>('[data-plan-text-input]')).find(
      (candidate) => candidate.dataset.planTextInputId === itemId,
    )

    if (input) focusTextInput(input)
  }

  function focusTextInput(input: HTMLDivElement) {
    input.focus()
    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(false)

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
</script>

<div class="item-shell" style={`--depth: ${depth}`}>
  <div
    class="plan-row"
    data-plan-item-id={item.id}
    role="listitem"
    aria-label={`Plan item: ${item.text || 'Untitled'}`}
  >
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
      <span class="handle-dots" aria-hidden="true">
        <span>⋮</span>
        <span>⋮</span>
      </span>
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
      <button class="icon-button quiet add-time" type="button" title="Add time range" on:click={addTime}>+</button>
    {/if}

    <div
      bind:this={textEditor}
      class="item-text"
      class:done={item.done}
      data-plan-text-input
      data-plan-text-input-id={item.id}
      contenteditable="true"
      role="textbox"
      tabindex="0"
      aria-label="Plan item"
      data-placeholder="Plan item"
      on:blur={() => {
        if (textEditor) persistEditor(textEditor)
      }}
      on:keydown={handleTextKeydown}
      on:input={handleTextInput}
      on:paste={handlePaste}
    >{@html renderedHTML}</div>

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
          depth={depth + 1}
          {planId}
          {patchItem}
          {addChild}
          {deleteItem}
          {moveItem}
          {moveItemWithinLevel}
          {historyRevision}
        />
      {/each}
    </div>
  {/if}
</div>
