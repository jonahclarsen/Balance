<script lang="ts">
  import { tick } from 'svelte'
  import AlarmClockIcon from './AlarmClockIcon.svelte'
  import RichTextEditor from './RichTextEditor.svelte'
  import TimeRange from './TimeRange.svelte'
  import type { Id, MoveDirection, MovePlacement, TemplateItem, TemplateOption } from './types'

  export let item: TemplateItem
  export let depth = 0
  export let templateId: Id
  export let parentId: Id | null = null
  export let patchItem: (templateId: Id, itemId: Id, patch: Partial<TemplateItem>) => void
  export let splitItem: (
    templateId: Id,
    itemId: Id,
    optionId: Id,
    patch: Partial<TemplateOption>,
    after: { html: string; text: string },
  ) => Id
  export let deleteItem: (templateId: Id, itemId: Id) => void
  export let moveItem: (templateId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  export let moveItemWithinLevel: (templateId: Id, itemId: Id, direction: MoveDirection) => void
  export let addChild: (templateId: Id, parentId: Id) => void
  export let addOption: (templateId: Id, itemId: Id) => void
  export let patchOption: (templateId: Id, itemId: Id, optionId: Id, patch: Partial<TemplateOption>) => void
  export let deleteOption: (templateId: Id, itemId: Id, optionId: Id) => void
  export let historyRevision: number

  let dragging = false
  let activeDropRow: HTMLElement | null = null

  $: probabilityTotal = item.options.reduce((sum, option) => sum + (Number(option.probability) || 0), 0)

  function addTime() {
    patchItem(templateId, item.id, {
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
    const row = hovered instanceof Element ? hovered.closest<HTMLElement>('[data-template-item-id]') : null

    if (!row || row.dataset.templateItemId === item.id) {
      clearDropMarker()
      return
    }

    markDropTarget(row, placementForRow(row, event.clientY))
  }

  function endPointerDrag(event: PointerEvent) {
    if (!dragging) return

    const row = activeDropRow
    const targetId = row?.dataset.templateItemId
    const placement = row ? placementForRow(row, event.clientY) : null

    clearDropMarker()
    dragging = false

    if (targetId && targetId !== item.id && placement) {
      moveItem(templateId, item.id, targetId, placement)
    }
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
      return
    }

    focusAdjacentTemplateOptionTextInput(current, direction)
  }

  async function handleTextTab(direction: 'in' | 'out', current: HTMLDivElement) {
    if (direction === 'in') {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-template-item-id]'))
      const currentRow = current.closest<HTMLElement>('[data-template-item-id]')
      const index = currentRow ? rows.indexOf(currentRow) : -1
      const targetId = index > 0 ? rows[index - 1].dataset.templateItemId : null

      if (targetId) {
        moveItem(templateId, item.id, targetId, 'inside')
        await tick()
        focusTemplateOptionTextInput(item.options[0]?.id)
      }
      return
    }

    if (parentId) {
      moveItem(templateId, item.id, parentId, 'after')
      await tick()
      focusTemplateOptionTextInput(item.options[0]?.id)
    }
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

  function focusTemplateOptionTextInput(optionId: Id | undefined, position: 'start' | 'end' = 'end') {
    if (!optionId) return

    const input = Array.from(document.querySelectorAll<HTMLDivElement>('[data-template-option-text-input]')).find(
      (candidate) => candidate.dataset.templateOptionTextInputId === optionId,
    )

    if (input) focusTextInput(input, position)
  }

  function focusAdjacentTemplateOptionTextInput(current: HTMLDivElement, direction: MoveDirection) {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-template-option-text-input]'))
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
    data-template-item-id={item.id}
    role="listitem"
    aria-label={`Template item: ${item.options[0]?.text || 'Untitled'}`}
  >
    <button
      class="drag-handle"
      class:dragging
      type="button"
      title="Drag to move template item"
      aria-label="Drag to move template item"
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

    {#if item.startMinutes !== null && item.endMinutes !== null}
      <TimeRange
        startMinutes={item.startMinutes}
        endMinutes={item.endMinutes}
        onChange={(startMinutes, endMinutes) => patchItem(templateId, item.id, { startMinutes, endMinutes })}
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
            onChange={(html, text) => patchOption(templateId, item.id, option.id, { html, text })}
            onArrowKey={(direction, editor, event) => handleTextArrowKey(option.id, direction, editor, event)}
            onSplit={(before, after) => handleTextSplit(option.id, before, after)}
            onTabKey={handleTextTab}
            onBackspaceEmpty={(editor) => handleBackspaceEmpty(option, index, editor)}
          />
          <input
            class="probability"
            type="number"
            min="0"
            max="100"
            value={option.probability}
            aria-label="Probability"
            on:input={(event) =>
              patchOption(templateId, item.id, option.id, {
                probability: Number(event.currentTarget.value) || 0,
              })}
          />
          <span class="percent">%</span>
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
      <span class:bad-total={probabilityTotal !== 100} class="total">{probabilityTotal}%</span>
      <button class="icon-button" type="button" title="Add option" on:click={() => addOption(templateId, item.id)}>±</button>
      <button class="icon-button" type="button" title="Add child item" on:click={() => addChild(templateId, item.id)}>↳</button>
      <button class="icon-button danger" type="button" title="Delete item" on:click={() => deleteItem(templateId, item.id)}>×</button>
    </div>
  </div>

  {#if item.children.length > 0}
    <div class="children">
      {#each item.children as child (child.id)}
        <svelte:self
          item={child}
          depth={depth + 1}
          {templateId}
          parentId={item.id}
          {patchItem}
          {splitItem}
          {deleteItem}
          {moveItem}
          {moveItemWithinLevel}
          {addChild}
          {addOption}
          {patchOption}
          {deleteOption}
          {historyRevision}
        />
      {/each}
    </div>
  {/if}
</div>
