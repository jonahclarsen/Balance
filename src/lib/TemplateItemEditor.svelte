<script lang="ts">
  import { tick } from 'svelte'
  import AlarmClockIcon from './AlarmClockIcon.svelte'
  import { defaultTemplateItemTimeRange, planItemTimeExceedsAncestor, planItemTimeOverlapsPrevious } from './planner'
  import { scrollMovedItemsIntoView } from './itemScroll'
  import ProbabilitySlider from './ProbabilitySlider.svelte'
  import RichTextEditor from './RichTextEditor.svelte'
  import TimeRange from './TimeRange.svelte'
  import TreeItemRow from './TreeItemRow.svelte'
  import type { Id, MoveDirection, MovePlacement, TemplateItem, TemplateOption } from './types'

  type TextChangeOptions = {
    mergeHistory?: boolean
    mergeKey?: string
    mergeWindowMs?: number
  }

  const TIME_DRAG_MERGE_WINDOW_MS = 1500

  export let item: TemplateItem
  export let allItems: TemplateItem[]
  export let depth = 0
  export let templateId: Id
  export let parentId: Id | null = null
  export let patchItem: (
    templateId: Id,
    itemId: Id,
    patch: Partial<TemplateItem>,
    options?: TextChangeOptions,
  ) => void
  export let splitItem: (
    templateId: Id,
    itemId: Id,
    optionId: Id,
    patch: Partial<TemplateOption>,
    after: { html: string; text: string },
  ) => Id
  export let backspaceOptionAtStart: (
    templateId: Id,
    itemId: Id,
    optionId: Id,
  ) => { focusOptionId: Id; focusOffset: number } | null = () => null
  export let deleteItem: (templateId: Id, itemId: Id) => void
  export let moveItem: (templateId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  export let moveItemWithinLevel: (templateId: Id, itemId: Id, direction: MoveDirection) => void
  export let outdentItem: (templateId: Id, itemId: Id) => void
  export let addOption: (templateId: Id, itemId: Id) => void
  export let patchOption: (
    templateId: Id,
    itemId: Id,
    optionId: Id,
    patch: Partial<TemplateOption>,
    options?: TextChangeOptions,
  ) => void
  export let deleteOption: (templateId: Id, itemId: Id, optionId: Id) => void
  export let historyRevision: number
  export let selectedItemIds: Set<Id> = new Set()
  export let selectionDragging = false
  export let onSelectionPointerDown: (itemId: Id, event: PointerEvent) => void = () => {}
  export let onSelectionPointerMove: (event: PointerEvent) => void = () => {}
  export let onSelectionPointerEnter: (itemId: Id) => void = () => {}
  export let onTextShiftArrow: (itemId: Id, direction: MoveDirection) => void = () => {}

  $: selected = selectedItemIds.has(item.id)

  $: probabilityTotal = item.options.reduce((sum, option) => sum + (Number(option.probability) || 0), 0)
  // A lone option is allowed to sit below 100%: the missing share is an implicit
  // "skip" (the item just doesn't appear that often), so it isn't a bad total.
  $: badProbabilityTotal = item.options.length > 1 && probabilityTotal !== 100
  $: timeOverlapsPrevious =
    item.startMinutes !== null &&
    item.endMinutes !== null &&
    planItemTimeOverlapsPrevious(allItems, item.id, item.startMinutes)
  $: timeExceedsAncestor =
    item.endMinutes !== null && planItemTimeExceedsAncestor(allItems, item.id, item.endMinutes)

  function addTime() {
    patchItem(templateId, item.id, defaultTemplateItemTimeRange(allItems, item.id))
  }

  function patchTimeRange(startMinutes: number, endMinutes: number) {
    patchItem(
      templateId,
      item.id,
      { startMinutes, endMinutes },
      { mergeKey: `template-item-time:${templateId}:${item.id}`, mergeWindowMs: TIME_DRAG_MERGE_WINDOW_MS },
    )
  }

  async function handleTextSplit(
    optionId: Id,
    before: { html: string; text: string },
    after: { html: string; text: string },
  ) {
    const newOptionId = splitItem(templateId, item.id, optionId, before, after)
    await tick()
    focusTemplateOptionTextInput(newOptionId, 'start')
  }

  async function handleTextArrowKey(optionId: Id, direction: MoveDirection, current: HTMLDivElement, event: KeyboardEvent) {
    if (event.altKey) {
      moveItemWithinLevel(templateId, item.id, direction)
      await tick()
      focusTemplateOptionTextInput(optionId)
      scrollMovedItemsIntoView('day-template', [item.id], direction)
      return
    }

    if (event.shiftKey) {
      onTextShiftArrow(item.id, direction)
      return
    }

    focusAdjacentTemplateOptionTextInput(current, direction)
  }

  async function handleTextTab(direction: 'in' | 'out', current: HTMLDivElement) {
    if (direction === 'in') {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-template-item-id]'))
      const currentRow = current.closest<HTMLElement>('[data-template-item-id]')
      const index = currentRow ? rows.indexOf(currentRow) : -1
      const targetId = findPreviousSameDepthTemplateItemId(rows, index)

      if (targetId) {
        moveItem(templateId, item.id, targetId, 'inside')
        await tick()
        focusTemplateOptionTextInput(item.options[0]?.id)
      }
      return
    }

    if (parentId) {
      outdentItem(templateId, item.id)
      await tick()
      focusTemplateOptionTextInput(item.options[0]?.id)
    }
  }

  function findPreviousSameDepthTemplateItemId(rows: HTMLElement[], currentIndex: number): Id | null {
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const rowDepth = Number(rows[index].dataset.templateItemDepth ?? 0)

      if (rowDepth === depth) return rows[index].dataset.templateItemId ?? null
      if (rowDepth < depth) return null
    }

    return null
  }

  async function handleBackspaceEmpty(option: TemplateOption, index: number, current: HTMLDivElement) {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-template-option-text-input]'))
    const inputIndex = inputs.indexOf(current)

    if (index === 0) {
      deleteItem(templateId, item.id)
    } else {
      deleteOption(templateId, item.id, option.id)
    }

    await tick()

    const nextInputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-template-option-text-input]'))
    const target = nextInputs[Math.max(0, inputIndex - 1)] ?? nextInputs[0]
    if (target) focusTextInput(target)
  }

  async function handleBackspaceStart(option: TemplateOption, index: number, current: HTMLDivElement) {
    const result = backspaceOptionAtStart(templateId, item.id, option.id)

    if (!result) {
      if (option.text.trim() === '') await handleBackspaceEmpty(option, index, current)
      return
    }

    await tick()
    focusTemplateOptionTextInputAtOffset(result.focusOptionId, result.focusOffset)
  }

  function handleHorizontalBoundaryKey(direction: 'left' | 'right', current: HTMLDivElement) {
    focusAdjacentTemplateOptionTextInput(
      current,
      direction === 'left' ? 'up' : 'down',
      direction === 'left' ? 'end' : 'start',
    )
  }

  function focusTemplateOptionTextInput(optionId: Id | undefined, position: 'start' | 'end' = 'end') {
    if (!optionId) return

    const input = Array.from(document.querySelectorAll<HTMLDivElement>('[data-template-option-text-input]')).find(
      (candidate) => candidate.dataset.templateOptionTextInputId === optionId,
    )

    if (input) focusTextInput(input, position)
  }

  function focusAdjacentTemplateOptionTextInput(
    current: HTMLDivElement,
    direction: MoveDirection,
    position: 'start' | 'end' = 'end',
  ) {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-template-option-text-input]'))
    const index = inputs.indexOf(current)
    const target = inputs[direction === 'up' ? index - 1 : index + 1]

    if (target) focusTextInput(target, position)
  }

  function focusTemplateOptionTextInputAtOffset(optionId: Id, offset: number) {
    const input = Array.from(document.querySelectorAll<HTMLDivElement>('[data-template-option-text-input]')).find(
      (candidate) => candidate.dataset.templateOptionTextInputId === optionId,
    )

    if (input) focusTextInputAtOffset(input, offset)
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

  function focusTextInputAtOffset(input: HTMLDivElement, offset: number) {
    input.focus()
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT)
    let remaining = offset
    let targetNode: Node = input
    let nodeOffset = 0
    let node = walker.nextNode()

    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        targetNode = node
        nodeOffset = remaining
        break
      }
      remaining -= length
      node = walker.nextNode()
    }

    if (!node) {
      targetNode = input
      nodeOffset = input.childNodes.length
    }

    const range = document.createRange()
    range.setStart(targetNode, nodeOffset)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
</script>

<TreeItemRow
  kind="day-template"
  itemId={item.id}
  containerId={templateId}
  {depth}
  ariaLabel={`Template item: ${item.options[0]?.text || 'Untitled'}`}
  dragLabel="Drag to move template item"
  {selected}
  {selectionDragging}
  {moveItem}
  {onSelectionPointerDown}
  {onSelectionPointerMove}
  {onSelectionPointerEnter}
>
  {#if item.startMinutes !== null && item.endMinutes !== null}
      <TimeRange
        startMinutes={item.startMinutes}
        endMinutes={item.endMinutes}
        overlapsPrevious={timeOverlapsPrevious}
        exceedsAncestor={timeExceedsAncestor}
        onChange={patchTimeRange}
        onRemove={() => patchItem(templateId, item.id, { startMinutes: null, endMinutes: null })}
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

  <div class="option-stack">
      {#each item.options as option, index (option.id)}
        <div class="option-row">
          <RichTextEditor
            className="template-text"
            kind="template-option"
            inputId={option.id}
            html={option.html}
            text={option.text}
            placeholder={index === 0 ? 'Template item' : '(Skip)'}
            ariaLabel={index === 0 ? 'Template item' : 'Template alternative'}
            revision={historyRevision}
            onChange={(html, text, options) => patchOption(templateId, item.id, option.id, { html, text }, options)}
            onArrowKey={(direction, editor, event) => handleTextArrowKey(option.id, direction, editor, event)}
            onSplit={(before, after) => handleTextSplit(option.id, before, after)}
            onTabKey={handleTextTab}
            onBackspaceEmpty={(editor) => handleBackspaceEmpty(option, index, editor)}
            onBackspaceStart={(editor) => handleBackspaceStart(option, index, editor)}
            onMetaBackspaceEnd={(editor) => handleBackspaceEmpty(option, index, editor)}
            onHorizontalBoundaryKey={handleHorizontalBoundaryKey}
          />
          <ProbabilitySlider
            value={option.probability}
            min={0}
            editable
            onChange={(probability) => patchOption(templateId, item.id, option.id, { probability })}
          />
          <button
            class="icon-button danger"
            type="button"
            title="Delete option"
            disabled={item.options.length === 1}
            on:click={() => deleteOption(templateId, item.id, option.id)}
          >
            ×
          </button>
        </div>
      {/each}
  </div>

  <div class="template-actions">
    <span class:bad-total={badProbabilityTotal} class="total">{probabilityTotal}%</span>
    <button class="icon-button" type="button" title="Add option" on:click={() => addOption(templateId, item.id)}>±</button>
  </div>

  <svelte:fragment slot="children">
    {#if item.children.length > 0}
      <div class="children">
        {#each item.children as child (child.id)}
          <svelte:self
            item={child}
            {allItems}
            depth={depth + 1}
            {templateId}
            parentId={item.id}
            {patchItem}
            {splitItem}
            {backspaceOptionAtStart}
            {deleteItem}
            {moveItem}
            {moveItemWithinLevel}
            {outdentItem}
            {addOption}
            {patchOption}
            {deleteOption}
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
  </svelte:fragment>
</TreeItemRow>
