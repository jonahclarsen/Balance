<script lang="ts">
  import { tick } from 'svelte'
  import AlarmClockIcon from './AlarmClockIcon.svelte'
  import { defaultTemplateItemTimeRange, hasActiveTimeRange, detectedTemplateLists, linkifyItemText, type ItemLink, type ItemTimeWarning } from './planner'
  import { scrollMovedItemsIntoView } from './itemScroll'
  import ProbabilitySlider from './ProbabilitySlider.svelte'
  import RichTextEditor from './RichTextEditor.svelte'
  import TimeRange from './TimeRange.svelte'
  import TreeItemRow from './TreeItemRow.svelte'
  import type { Id, ListTemplate, Metric, MoveDirection, MovePlacement, Note, TemplateItem, TemplateOption, TemplateListExpansion, TemplateQuestion } from './types'

  type TextChangeOptions = {
    mergeHistory?: boolean
    mergeKey?: string
    mergeWindowMs?: number
  }

  const TIME_DRAG_MERGE_WINDOW_MS = 1500

  export let item: TemplateItem
  export let allItems: TemplateItem[]
  export let timeWarnings: ReadonlyMap<Id, ItemTimeWarning>
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
  export let deleteItemPreservingChildren: (templateId: Id, itemId: Id) => void = deleteItem
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
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let notes: Note[] = []
  export let onOpenLink: (link: ItemLink) => void = () => {}
  export let templateQuestions: TemplateQuestion[] = []
  export let setQuestion: (itemId: Id, question: string | null) => void = () => {}

  export let listExpansions: TemplateListExpansion[] = []
  export let setListExpansion: (optionId: Id, listTemplateId: Id, enabled: boolean) => void = () => {}

  // Keep controls outside contenteditable, positioned over its final text line.
  function inlineExpansionControls(wrapper: HTMLDivElement) {
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const editor = wrapper.querySelector<HTMLElement>('[data-rich-text-input]')
        const controls = wrapper.querySelector<HTMLElement>('.expansion-controls')
        if (!editor) return
        const padding = controls ? `${controls.offsetWidth + 18}px` : ''
        if (editor.style.paddingRight !== padding) editor.style.paddingRight = padding
        if (!controls) return
        const range = document.createRange()
        range.selectNodeContents(editor)
        const rect = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).at(-1)
        if (!rect) return
        const bounds = wrapper.getBoundingClientRect()
        // Client rectangles include Balance's browser zoom; CSS offsets do not.
        const scale = bounds.width / wrapper.offsetWidth
        controls.style.left = `${Math.min((rect.right - bounds.left) / scale + 6, wrapper.clientWidth - controls.offsetWidth - 2)}px`
        controls.style.top = `${(rect.top - bounds.top + rect.height / 2) / scale}px`
        controls.style.visibility = 'visible'
      })
    }
    const resize = new ResizeObserver(update)
    resize.observe(wrapper)
    const mutation = new MutationObserver(update)
    mutation.observe(wrapper, { childList: true, subtree: true, characterData: true })
    update()
    return { destroy() { cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect() } }
  }

  let questionInput: HTMLInputElement | null = null
  $: question = templateQuestions.find(({ id }) => id === item.id)?.question

  async function addQuestion() {
    setQuestion(item.id, '')
    await tick()
    questionInput?.focus()
  }

  $: selected = selectedItemIds.has(item.id)

  $: probabilityTotal = item.options.reduce((sum, option) => sum + (Number(option.probability) || 0), 0)
  // A lone option is allowed to sit below 100%: the missing share is an implicit
  // "skip" (the item just doesn't appear that often), so it isn't a bad total.
  $: badProbabilityTotal = item.options.length > 1 && probabilityTotal !== 100
  $: timeWarning = timeWarnings.get(item.id)

  function addTime() {
    patchItem(
      templateId,
      item.id,
      { ...defaultTemplateItemTimeRange(allItems, item.id), timeHidden: null },
    )
  }

  function patchTimeRange(startMinutes: number, endMinutes: number) {
    patchItem(
      templateId,
      item.id,
      { startMinutes, endMinutes },
      { mergeKey: `template-item-time:${templateId}:${item.id}`, mergeWindowMs: TIME_DRAG_MERGE_WINDOW_MS },
    )
  }

  function handleProbabilityChange(optionIndex: number, probability: number) {
    const targetIds = selected ? selectedItemIds : new Set([item.id])

    for (const targetId of targetIds) {
      const targetOption = findTemplateItem(allItems, targetId)?.options[optionIndex]
      if (!targetOption) continue
      patchOption(templateId, targetId, targetOption.id, { probability })
    }
  }

  function findTemplateItem(items: TemplateItem[], itemId: Id): TemplateItem | null {
    for (const candidate of items) {
      if (candidate.id === itemId) return candidate
      const descendant = findTemplateItem(candidate.children, itemId)
      if (descendant) return descendant
    }
    return null
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
    const optionId = current.dataset.templateOptionTextInputId
    const caretOffset = textOffsetForCaret(current)

    if (direction === 'in') {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-template-item-id]'))
      const currentRow = current.closest<HTMLElement>('[data-template-item-id]')
      const index = currentRow ? rows.indexOf(currentRow) : -1
      const targetId = findPreviousSameDepthTemplateItemId(rows, index)

      if (targetId) {
        moveItem(templateId, item.id, targetId, 'inside')
        await tick()
        if (optionId) focusTemplateOptionTextInputAtOffset(optionId, caretOffset)
      }
      return
    }

    if (parentId) {
      outdentItem(templateId, item.id)
      await tick()
      if (optionId) focusTemplateOptionTextInputAtOffset(optionId, caretOffset)
    }
  }

  function textOffsetForCaret(input: HTMLDivElement) {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) return input.textContent?.length ?? 0

    const range = selection.getRangeAt(0)
    if (!input.contains(range.startContainer)) return input.textContent?.length ?? 0

    const beforeCaret = document.createRange()
    beforeCaret.selectNodeContents(input)
    beforeCaret.setEnd(range.startContainer, range.startOffset)
    return beforeCaret.toString().length
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

  async function handleMetaBackspaceEnd(option: TemplateOption, index: number, current: HTMLDivElement) {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-template-option-text-input]'))
    const inputIndex = inputs.indexOf(current)

    if (index === 0) {
      deleteItemPreservingChildren(templateId, item.id)
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
      if (option.text.trim() === '' && !option.html.includes('data-balance-image=')) await handleBackspaceEmpty(option, index, current)
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
  {#if hasActiveTimeRange(item)}
      <TimeRange
        startMinutes={item.startMinutes}
        endMinutes={item.endMinutes}
        overlapsPrevious={timeWarning?.overlapsPrevious}
        overlapsNext={timeWarning?.overlapsNext}
        precedesAncestor={timeWarning?.precedesAncestor}
        exceedsAncestor={timeWarning?.exceedsAncestor}
        onChange={patchTimeRange}
        onRemove={() => patchItem(templateId, item.id, { startMinutes: null, endMinutes: null, timeHidden: null })}
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
      {#if question !== undefined}
        <div class="question-row">
          <span class="question-mark" aria-hidden="true">?</span>
          <input
            bind:this={questionInput}
            class="question-input"
            type="text"
            value={question}
            placeholder="Question asked when generating the day"
            aria-label="Question asked when generating the day"
            on:input={(event) => setQuestion(item.id, event.currentTarget.value)}
          />
          <button
            class="icon-button danger"
            type="button"
            title="Remove question"
            aria-label="Remove question"
            on:click={() => setQuestion(item.id, null)}
          >
            ×
          </button>
        </div>
      {/if}
      {#each item.options as option, index (option.id)}
        <div class="option-row">
          <div class="template-option-editor" use:inlineExpansionControls>
            <RichTextEditor
              className="template-text"
              kind="template-option"
              inputId={option.id}
              html={option.html}
              text={option.text}
              placeholder={question !== undefined
                ? (item.options.length === 1 ? 'Added when you answer yes' : 'Answer')
                : index === 0 ? 'Template item' : '(Skip)'}
              ariaLabel={index === 0 ? 'Template item' : 'Template alternative'}
              revision={historyRevision}
              onChange={(html, text, options) => patchOption(templateId, item.id, option.id, { html, text }, options)}
              onArrowKey={(direction, editor, event) => handleTextArrowKey(option.id, direction, editor, event)}
              interceptShiftArrowAtBoundary
              onSplit={(before, after) => handleTextSplit(option.id, before, after)}
              onTabKey={handleTextTab}
              onBackspaceEmpty={(editor) => handleBackspaceEmpty(option, index, editor)}
              onBackspaceStart={(editor) => handleBackspaceStart(option, index, editor)}
              onMetaBackspaceEnd={(editor) => handleMetaBackspaceEnd(option, index, editor)}
              onHorizontalBoundaryKey={handleHorizontalBoundaryKey}
              internalLinkSegments={linkifyItemText(option.text, listTemplates, metrics, notes)}
              onInternalLinkClick={(link) => onOpenLink(link)}
            />
            {#if detectedTemplateLists(option.text, listTemplates, metrics, notes).length > 0}
            <div class="expansion-controls">
            {#each detectedTemplateLists(option.text, listTemplates, metrics, notes) as list (list.id)}
              <label class="list-expansion" title={`Place ${list.name} tasks here when generating the day`}>
                <input
                  type="checkbox"
                  aria-label={`Expand ${list.name} into tasks`}
                  checked={listExpansions.find(({ id }) => id === option.id)?.listTemplateIds.includes(list.id) ?? false}
                  on:change={(event) => setListExpansion(option.id, list.id, event.currentTarget.checked)}
                />
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10M3 8h10M3 13h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
              </label>
            {/each}
            </div>
            {/if}
          </div>
          {#if question === undefined}
            <ProbabilitySlider
              value={option.probability}
              min={0}
              step={5}
              editable
              onChange={(probability) => handleProbabilityChange(index, probability)}
            />
          {/if}
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
    {#if question === undefined}
      <span class:bad-total={badProbabilityTotal} class="total">{probabilityTotal}%</span>
      <button
        class="icon-button quiet"
        type="button"
        title="Ask a question when generating the day"
        aria-label="Ask a question when generating the day"
        on:click={addQuestion}
      >
        ?
      </button>
    {/if}
    <button class="icon-button" type="button" title={question === undefined ? 'Add option' : 'Add answer'} on:click={() => addOption(templateId, item.id)}>±</button>
  </div>

  <svelte:fragment slot="children">
    {#if item.children.length > 0}
      <div class="children">
        {#each item.children as child (child.id)}
          <svelte:self
            item={child}
            {allItems}
            {timeWarnings}
            depth={depth + 1}
            {templateId}
            parentId={item.id}
            {patchItem}
            {splitItem}
            {backspaceOptionAtStart}
            {deleteItem}
            {deleteItemPreservingChildren}
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
            {listTemplates}
            {metrics}
            {notes}
            {onOpenLink}
            {templateQuestions}
            {listExpansions}
            {setListExpansion}
            {setQuestion}
          />
        {/each}
      </div>
    {/if}
  </svelte:fragment>
</TreeItemRow>

<style>
  .template-option-editor { position: relative; flex: 1; min-width: 0; }
  .template-option-editor :global(.template-text) { width: 100%; }
  .expansion-controls {
    position: absolute;
    display: inline-flex;
    gap: 6px;
    align-items: center;
    transform: translateY(-50%);
    visibility: hidden;
  }
  .list-expansion { display: inline-flex; align-items: center; gap: 3px; color: var(--muted); cursor: pointer; }
  .list-expansion input { margin: 0; }
  .list-expansion svg { width: 12px; height: 12px; }
  @media (max-width: 760px) {
    .template-option-editor { grid-column: 1 / -1; grid-row: 1; width: 100%; }
  }
</style>
