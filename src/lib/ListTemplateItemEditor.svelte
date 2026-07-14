<script lang="ts">
  import { tick } from 'svelte'
  import { expectedWordCount, htmlToPlainText, wordCount } from './planner'
  import ProbabilitySlider from './ProbabilitySlider.svelte'
  import RichTextEditor from './RichTextEditor.svelte'
  import TreeItemRow from './TreeItemRow.svelte'
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
  export let historyRevision: number
  export let selectedItemIds: Set<Id> = new Set()
  export let selectionDragging = false
  export let onSelectionPointerDown: (itemId: Id, event: PointerEvent) => void = () => {}
  export let onSelectionPointerMove: (event: PointerEvent) => void = () => {}
  export let onSelectionPointerEnter: (itemId: Id) => void = () => {}
  export let onTextShiftArrow: (itemId: Id, direction: MoveDirection) => void = () => {}

  // Bumped to force the contenteditable to revert when a keystroke would push the
  // template's expected word count past the cap.
  let revertNonce = 0
  $: revision = historyRevision + revertNonce
  $: selected = selectedItemIds.has(item.id)

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
    if (event.shiftKey) {
      onTextShiftArrow(item.id, direction)
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

<TreeItemRow
  kind="list-template"
  itemId={item.id}
  containerId={templateId}
  {depth}
  ariaLabel={`List item: ${item.text || 'Untitled'}`}
  {selected}
  {selectionDragging}
  {moveItem}
  {onSelectionPointerDown}
  {onSelectionPointerMove}
  {onSelectionPointerEnter}
>
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
        onMetaBackspaceEnd={handleBackspaceEmpty}
      />
      <ProbabilitySlider
        value={item.probability}
        min={40}
        step={10}
        ariaLabel="Appearance probability"
        generousHitbox
        onChange={(probability) => patchItem(templateId, item.id, { probability })}
      />
    </div>
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
            {maxExpectedWords}
            {patchItem}
            {splitItem}
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
  </svelte:fragment>
</TreeItemRow>
