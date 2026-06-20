<script lang="ts">
  import { tick } from 'svelte'
  import { expectedWordCount, htmlToPlainText, wordCount } from './planner'
  import ProbabilitySlider from './ProbabilitySlider.svelte'
  import RichTextEditor from './RichTextEditor.svelte'
  import type { Id, ListTemplateItem, MoveDirection, MovePlacement } from './types'

  type TextChangeOptions = {
    mergeHistory?: boolean
    mergeKey?: string
    mergeWindowMs?: number
  }

  export let item: ListTemplateItem
  export let allItems: ListTemplateItem[]
  export let depth = 0
  export let templateId: Id
  export let parentId: Id | null = null
  export let maxExpectedWords = 0
  export let patchItem: (
    templateId: Id,
    itemId: Id,
    patch: Partial<ListTemplateItem>,
    options?: TextChangeOptions,
  ) => void
  export let splitItem: (
    templateId: Id,
    itemId: Id,
    before: { html: string; text: string },
    after: { html: string; text: string },
  ) => Id
  export let deleteItem: (templateId: Id, itemId: Id) => void
  export let moveItem: (templateId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  export let moveItemWithinLevel: (templateId: Id, itemId: Id, direction: MoveDirection) => void
  export let outdentItem: (templateId: Id, itemId: Id) => void
  export let addChild: (templateId: Id, parentId: Id) => void
  export let historyRevision: number

  let dragging = false
  let activeDropRow: HTMLElement | null = null
  // Bumped to force the contenteditable to revert when a keystroke would push the
  // template's expected word count past the cap.
  let revertNonce = 0
  $: revision = historyRevision + revertNonce

  // Expected words contributed by everything except this item's own text, so we can
  // check whether new text would breach the cap without rebuilding the whole tree.
  $: currentExpected = expectedWordCount(allItems)
  $: itemContribution = wordCount(htmlToPlainText(item.html) || item.text) * (item.probability / 100)

  function wouldExceedCap(text: string, probability: number): boolean {
    if (!maxExpectedWords) return false
    const base = currentExpected - itemContribution
    const next = base + wordCount(text) * (probability / 100)
    return next > maxExpectedWords + 1e-9
  }

  function handleTextChange(html: string, text: string, options?: TextChangeOptions) {
    if (wouldExceedCap(htmlToPlainText(html) || text, item.probability)) {
      // Reject: revert the editor to the last accepted content.
      revertNonce += 1
      return
    }
    patchItem(templateId, item.id, { html, text }, options)
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
    const row = hovered instanceof Element ? hovered.closest<HTMLElement>('[data-list-template-item-id]') : null
    if (!row || row.dataset.listTemplateItemId === item.id) {
      clearDropMarker()
      return
    }
    markDropTarget(row, placementForRow(row, event.clientY))
  }

  function endPointerDrag(event: PointerEvent) {
    if (!dragging) return
    const row = activeDropRow
    const targetId = row?.dataset.listTemplateItemId
    const placement = row ? placementForRow(row, event.clientY) : null
    clearDropMarker()
    dragging = false
    if (targetId && targetId !== item.id && placement) {
      moveItem(templateId, item.id, targetId, placement)
    }
  }

  async function handleTextSplit(before: { html: string; text: string }, after: { html: string; text: string }) {
    const newItemId = splitItem(templateId, item.id, before, after)
    await tick()
    focusListItemInput(newItemId, 'start')
  }

  async function handleTextArrowKey(direction: MoveDirection, current: HTMLDivElement, event: KeyboardEvent) {
    if (event.altKey) {
      moveItemWithinLevel(templateId, item.id, direction)
      await tick()
      focusListItemInput(item.id)
      return
    }
    focusAdjacentListItemInput(current, direction)
  }

  async function handleTextTab(direction: 'in' | 'out', current: HTMLDivElement) {
    if (direction === 'in') {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-list-template-item-id]'))
      const currentRow = current.closest<HTMLElement>('[data-list-template-item-id]')
      const index = currentRow ? rows.indexOf(currentRow) : -1
      const targetId = findPreviousSameDepthItemId(rows, index)
      if (targetId) {
        moveItem(templateId, item.id, targetId, 'inside')
        await tick()
        focusListItemInput(item.id)
      }
      return
    }
    if (parentId) {
      outdentItem(templateId, item.id)
      await tick()
      focusListItemInput(item.id)
    }
  }

  function findPreviousSameDepthItemId(rows: HTMLElement[], currentIndex: number): Id | null {
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const rowDepth = Number(rows[index].dataset.listTemplateItemDepth ?? 0)
      if (rowDepth === depth) return rows[index].dataset.listTemplateItemId ?? null
      if (rowDepth < depth) return null
    }
    return null
  }

  async function handleBackspaceEmpty() {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
    const current = inputs.findIndex((input) => input.dataset.listTemplateTextInputId === item.id)
    deleteItem(templateId, item.id)
    await tick()
    const nextInputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
    const target = nextInputs[Math.max(0, current - 1)] ?? nextInputs[0]
    if (target) focusTextInput(target)
  }

  function focusListItemInput(itemId: Id | undefined, position: 'start' | 'end' = 'end') {
    if (!itemId) return
    const input = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]')).find(
      (candidate) => candidate.dataset.listTemplateTextInputId === itemId,
    )
    if (input) focusTextInput(input, position)
  }

  function focusAdjacentListItemInput(current: HTMLDivElement, direction: MoveDirection) {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
    const index = inputs.indexOf(current)
    const target = inputs[direction === 'up' ? index - 1 : index + 1]
    if (target) focusTextInput(target)
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

<div class="template-item" style={`--depth: ${depth}`}>
  <div
    class="template-main"
    data-list-template-item-id={item.id}
    data-list-template-item-depth={depth}
    role="listitem"
    aria-label={`List item: ${item.text || 'Untitled'}`}
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
      <span class="handle-dots" aria-hidden="true"></span>
    </button>

    <div class="option-stack">
      <div class="option-row">
        <RichTextEditor
          className="template-text"
          kind="list-template-item"
          inputId={item.id}
          html={item.html}
          text={item.text}
          placeholder="List item"
          ariaLabel="List item"
          {revision}
          onChange={handleTextChange}
          onArrowKey={(direction, editor, event) => handleTextArrowKey(direction, editor, event)}
          onSplit={(before, after) => handleTextSplit(before, after)}
          onTabKey={handleTextTab}
          onBackspaceEmpty={handleBackspaceEmpty}
        />
        <ProbabilitySlider
          value={item.probability}
          min={50}
          ariaLabel="Appearance probability"
          onChange={(probability) => patchItem(templateId, item.id, { probability })}
        />
      </div>
    </div>

    <div class="template-actions">
      <button class="icon-button" type="button" title="Add child item" on:click={() => addChild(templateId, item.id)}>↳</button>
      <button class="icon-button danger" type="button" title="Delete item" on:click={() => deleteItem(templateId, item.id)}>×</button>
    </div>
  </div>

  {#if item.children.length > 0}
    <div class="children">
      {#each item.children as child (child.id)}
        <svelte:self
          item={child}
          {allItems}
          depth={depth + 1}
          {templateId}
          parentId={item.id}
          {maxExpectedWords}
          {patchItem}
          {splitItem}
          {deleteItem}
          {moveItem}
          {moveItemWithinLevel}
          {outdentItem}
          {addChild}
          {historyRevision}
        />
      {/each}
    </div>
  {/if}
</div>
