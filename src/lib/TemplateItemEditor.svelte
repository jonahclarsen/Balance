<script lang="ts">
  import RichTextEditor from './RichTextEditor.svelte'
  import type { Id, MovePlacement, TemplateItem, TemplateOption } from './types'

  export let item: TemplateItem
  export let depth = 0
  export let templateId: Id
  export let patchItem: (templateId: Id, itemId: Id, patch: Partial<TemplateItem>) => void
  export let deleteItem: (templateId: Id, itemId: Id) => void
  export let moveItem: (templateId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  export let addChild: (templateId: Id, parentId: Id) => void
  export let addOption: (templateId: Id, itemId: Id) => void
  export let patchOption: (templateId: Id, itemId: Id, optionId: Id, patch: Partial<TemplateOption>) => void
  export let deleteOption: (templateId: Id, itemId: Id, optionId: Id) => void
  export let historyRevision: number

  let dragging = false
  let activeDropRow: HTMLElement | null = null

  $: probabilityTotal = item.options.reduce((sum, option) => sum + (Number(option.probability) || 0), 0)

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

    <div class="option-stack">
      {#each item.options as option, index (option.id)}
        <div class="option-row">
          <RichTextEditor
            className="template-text"
            kind="template-option"
            inputId={option.id}
            html={option.html}
            text={option.text}
            placeholder={index === 0 ? 'Template item' : 'Alternative'}
            ariaLabel={index === 0 ? 'Template item' : 'Template alternative'}
            revision={historyRevision}
            onChange={(html, text) => patchOption(templateId, item.id, option.id, { html, text })}
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
          {patchItem}
          {deleteItem}
          {moveItem}
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
