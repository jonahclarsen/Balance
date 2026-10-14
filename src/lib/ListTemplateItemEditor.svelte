<script lang="ts">
  import { tick } from 'svelte'
  import { htmlToPlainText, linkifyItemText, listItemAppearanceChance, listItemPrimaryShare, listItemVariants, MIN_LIST_ITEM_PROBABILITY, type ItemLink, listItemWordCount } from './planner'
  import { scrollMovedItemsIntoView } from './itemScroll'
  import { formatDuration } from './listTiming'
  import ProbabilitySlider from './ProbabilitySlider.svelte'
  import RichTextEditor from './RichTextEditor.svelte'
  import TreeItemRow from './TreeItemRow.svelte'
  import type { Id, ListTemplate, ListTemplateItem, ListTemplateItemAlternative, Metric, MoveDirection, MovePlacement, Note } from './types'

  type TextChangeOptions = {
    imageEdit?: boolean
    mergeHistory?: boolean
    mergeKey?: string
    mergeWindowMs?: number
  }

  // The data layer keeps accepting 10% so previously saved low-probability
  // items survive unchanged. Only those grandfathered items expose that lower
  // range; every item currently at 25% or above uses the normal UI minimum.
  const NORMAL_MIN_LIST_ITEM_PROBABILITY = 25
  const PROBABILITY_DRAG_MERGE_WINDOW_MS = 1500

  export let item: ListTemplateItem
  export let currentExpected: number
  export let depth = 0
  export let ancestorProbability = 1
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
  export let backspaceItemAtStart: (
    templateId: Id,
    itemId: Id,
  ) => { focusItemId: Id; focusOffset: number } | null = () => null
  export let deleteItem: (templateId: Id, itemId: Id) => void
  export let deleteItemPreservingChildren: (templateId: Id, itemId: Id) => void = deleteItem
  export let moveItem: (templateId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  export let moveItemWithinLevel: (templateId: Id, itemId: Id, direction: MoveDirection) => void
  export let outdentItem: (templateId: Id, itemId: Id) => void
  export let addAlternative: (templateId: Id, itemId: Id) => Id | null = () => null
  export let patchAlternative: (
    templateId: Id,
    itemId: Id,
    alternativeId: Id,
    patch: Partial<Omit<ListTemplateItemAlternative, 'id'>>,
    options?: TextChangeOptions,
  ) => void = () => {}
  export let deleteAlternative: (templateId: Id, itemId: Id, alternativeId: Id) => void = () => {}
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
  // Typical time each item takes in finished runs, outliers excluded.
  export let typicalItemMs: Map<Id, number> = new Map()

  // Bumped to force the contenteditable to revert when a keystroke would push the
  // template's expected word count past the cap.
  let revertNonce = 0
  let allowsLowProbability = item.probability < NORMAL_MIN_LIST_ITEM_PROBABILITY
  // Clearing a row is ambiguous until focus moves: it may be a deletion, or the
  // first half of replacing all text. Keep the persisted item intact while the
  // editor is empty so a committed deletion can archive the original snapshot,
  // while replacement typing remains one ordinary edit.
  let pendingDeletion = false
  $: revision = historyRevision + revertNonce
  $: selected = selectedItemIds.has(item.id)
  $: alternatives = item.alternatives ?? []
  $: if (item.probability < NORMAL_MIN_LIST_ITEM_PROBABILITY) allowsLowProbability = true
  $: primaryShare = listItemPrimaryShare(item)

  // Each wording's chance of being picked; children follow whichever is picked.
  $: variantChances = new Map(listItemVariants(item).map((variant) => [variant.id, variant.chance]))
  $: childAncestorProbability = ancestorProbability * listItemAppearanceChance(item)

  // Check whether new text for one wording would breach the cap by swapping only
  // that wording's expected words, without rebuilding the whole tree.
  function wouldExceedCap(text: string, wordingId: Id = item.id): boolean {
    if (!maxExpectedWords) return false
    const wording = wordingId === item.id ? item : alternatives.find(({ id }) => id === wordingId)
    if (!wording) return false
    const probability = ancestorProbability * (variantChances.get(wordingId) ?? 0)
    const base = currentExpected - listItemWordCount(htmlToPlainText(wording.html) || wording.text, metrics) * probability
    const next = base + listItemWordCount(text, metrics) * probability
    // A lowered cap or a probability change can leave an existing template over
    // its limit. Keep rejecting edits that make that state worse, but allow
    // formatting-only changes and text edits that preserve or reduce its size.
    return next > maxExpectedWords + 1e-9 && next > currentExpected + 1e-9
  }

  function handleTextChange(html: string, text: string, options?: TextChangeOptions) {
    if (wouldExceedCap(htmlToPlainText(html) || text)) {
      // Reject: revert the editor to the last accepted content.
      pendingDeletion = false
      revertNonce += 1
      return
    }

    const nextIsEmpty = !html.includes('data-balance-image=') && text.trim() === '' && htmlToPlainText(html).trim() === ''
    const currentIsEmpty = !item.html.includes('data-balance-image=') && item.text.trim() === '' && htmlToPlainText(item.html).trim() === ''
    if (nextIsEmpty && !currentIsEmpty && !options?.imageEdit) {
      pendingDeletion = true
      return
    }

    if (!nextIsEmpty || options?.imageEdit) pendingDeletion = false
    patchItem(templateId, item.id, { html, text }, options)
  }

  function handleBeforeTextInput(editor: HTMLDivElement, event: InputEvent, wordingId: Id = item.id) {
    if (!event.cancelable || event.data === null || !event.inputType.startsWith('insert')) return

    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return

    const currentText = htmlToPlainText(editor.innerHTML)
    const start = plainTextOffsetForBoundary(editor, range.startContainer, range.startOffset)
    const end = plainTextOffsetForBoundary(editor, range.endContainer, range.endOffset)
    const nextText = `${currentText.slice(0, start)}${event.data}${currentText.slice(end)}`

    const prefix = currentText.slice(0, start)
    const suffix = currentText.slice(end)
    // Keep one count-neutral separator after a word, but stop repeated whitespace
    // when a word at this caret would exceed the cap.
    const repeatedWhitespaceWithoutRoom =
      range.collapsed &&
      /^\s+$/u.test(event.data) &&
      (event.data.length > 1 || /\s$/u.test(prefix) || /^\s/u.test(suffix)) &&
      wouldExceedCap(`${prefix}${event.data}word${suffix}`, wordingId)

    if (wouldExceedCap(nextText, wordingId) || repeatedWhitespaceWithoutRoom) event.preventDefault()
  }

  function plainTextOffsetForBoundary(editor: HTMLDivElement, node: Node, offset: number) {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.setEnd(node, offset)

    const container = document.createElement('div')
    container.append(range.cloneContents())
    return htmlToPlainText(container.innerHTML).length
  }

  function commitPendingDeletion() {
    if (!pendingDeletion) return false
    pendingDeletion = false
    deleteItemPreservingChildren(templateId, item.id)
    return true
  }

  function handleFocusChange(focused: boolean) {
    // Let RichTextEditor finish its blur persistence before removing the keyed
    // row; destroying it from inside its own blur callback leaves Svelte reading
    // derived editor state after the effect has been torn down.
    if (!focused && pendingDeletion) queueMicrotask(commitPendingDeletion)
  }

  function handlePendingDeletionKeydown(_editor: HTMLDivElement, event: KeyboardEvent) {
    if (!pendingDeletion || (event.key !== 'Enter' && event.key !== 'Tab')) return
    event.preventDefault()
    commitPendingDeletion()
  }

  function handleProbabilityChange(probability: number) {
    const targetIds = selected ? selectedItemIds : new Set([item.id])
    const mergeKey = `list-template-item-probability:${templateId}:${Array.from(targetIds).sort().join(',')}`

    for (const targetId of targetIds) {
      patchItem(
        templateId,
        targetId,
        { probability },
        { mergeKey, mergeWindowMs: PROBABILITY_DRAG_MERGE_WINDOW_MS },
      )
    }
  }

  // Clearing an alternative is an ordinary edit rather than a pending deletion;
  // an empty wording is simply skipped when it is picked.
  function handleAlternativeTextChange(alternative: ListTemplateItemAlternative, html: string, text: string, options?: TextChangeOptions) {
    if (wouldExceedCap(htmlToPlainText(html) || text, alternative.id)) {
      revertNonce += 1
      return
    }
    patchAlternative(templateId, item.id, alternative.id, { html, text }, options)
  }

  function handleAlternativeProbabilityChange(alternative: ListTemplateItemAlternative, probability: number) {
    patchAlternative(
      templateId,
      item.id,
      alternative.id,
      { probability },
      { mergeKey: `list-template-item-alternative-probability:${alternative.id}`, mergeWindowMs: PROBABILITY_DRAG_MERGE_WINDOW_MS },
    )
  }

  async function handleAddAlternative() {
    const alternativeId = addAlternative(templateId, item.id)
    await tick()
    focusListItemInput(alternativeId ?? undefined)
  }

  async function handleDeleteAlternative(alternative: ListTemplateItemAlternative, current?: HTMLDivElement) {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
    const index = current ? inputs.indexOf(current) : -1
    deleteAlternative(templateId, item.id, alternative.id)
    if (index < 0) return
    await tick()
    const nextInputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
    const target = nextInputs[Math.max(0, index - 1)]
    if (target) focusTextInput(target)
  }

  async function handleAlternativeArrowKey(direction: MoveDirection, current: HTMLDivElement, event: KeyboardEvent) {
    if (event.shiftKey) {
      onTextShiftArrow(item.id, direction)
      return
    }
    focusAdjacentListItemInput(current, direction)
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
      scrollMovedItemsIntoView('list-template', [item.id], direction)
      return
    }
    if (event.shiftKey) {
      onTextShiftArrow(item.id, direction)
      return
    }
    focusAdjacentListItemInput(current, direction)
  }

  async function handleTextTab(direction: 'in' | 'out', current: HTMLDivElement) {
    if (commitPendingDeletion()) return
    const caretOffset = textOffsetForCaret(current)

    if (direction === 'in') {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-list-template-item-id]'))
      const currentRow = current.closest<HTMLElement>('[data-list-template-item-id]')
      const index = currentRow ? rows.indexOf(currentRow) : -1
      const targetId = findPreviousSameDepthItemId(rows, index)
      if (targetId) {
        moveItem(templateId, item.id, targetId, 'inside')
        await tick()
        focusListItemInputAtOffset(item.id, caretOffset)
      }
      return
    }
    if (parentId) {
      outdentItem(templateId, item.id)
      await tick()
      focusListItemInputAtOffset(item.id, caretOffset)
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

  function findPreviousSameDepthItemId(rows: HTMLElement[], currentIndex: number): Id | null {
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const rowDepth = Number(rows[index].dataset.listTemplateItemDepth ?? 0)
      if (rowDepth === depth) return rows[index].dataset.listTemplateItemId ?? null
      if (rowDepth < depth) return null
    }
    return null
  }

  async function handleBackspaceEmpty() {
    if (commitPendingDeletion()) return
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
    const current = inputs.findIndex((input) => input.dataset.listTemplateTextInputId === item.id)
    deleteItem(templateId, item.id)
    await tick()
    const nextInputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
    const target = nextInputs[Math.max(0, current - 1)] ?? nextInputs[0]
    if (target) focusTextInput(target)
  }

  async function handleMetaBackspaceEnd() {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
    const current = inputs.findIndex((input) => input.dataset.listTemplateTextInputId === item.id)
    pendingDeletion = false
    deleteItemPreservingChildren(templateId, item.id)
    await tick()
    const nextInputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
    const target = nextInputs[Math.max(0, current - 1)] ?? nextInputs[0]
    if (target) focusTextInput(target)
  }

  async function handleBackspaceStart(current: HTMLDivElement) {
    if (pendingDeletion) {
      const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
      const index = inputs.indexOf(current)
      commitPendingDeletion()
      await tick()
      const nextInputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
      const target = nextInputs[Math.max(0, index - 1)] ?? nextInputs[0]
      if (target) focusTextInput(target)
      return
    }

    const result = backspaceItemAtStart(templateId, item.id)

    if (!result) {
      if (item.text.trim() === '' && !item.html.includes('data-balance-image=')) await handleBackspaceEmpty()
      return
    }

    await tick()
    focusListItemInputAtOffset(result.focusItemId, result.focusOffset)
  }

  function handleHorizontalBoundaryKey(direction: 'left' | 'right', current: HTMLDivElement) {
    focusAdjacentListItemInput(
      current,
      direction === 'left' ? 'up' : 'down',
      direction === 'left' ? 'end' : 'start',
    )
  }

  function focusListItemInput(itemId: Id | undefined, position: 'start' | 'end' = 'end') {
    if (!itemId) return
    const input = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]')).find(
      (candidate) => candidate.dataset.listTemplateTextInputId === itemId,
    )
    if (input) focusTextInput(input, position)
  }

  function focusAdjacentListItemInput(
    current: HTMLDivElement,
    direction: MoveDirection,
    position: 'start' | 'end' = 'end',
  ) {
    const inputs = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]'))
    const index = inputs.indexOf(current)
    const target = inputs[direction === 'up' ? index - 1 : index + 1]
    if (target) focusTextInput(target, position)
  }

  function focusListItemInputAtOffset(itemId: Id, offset: number) {
    const input = Array.from(document.querySelectorAll<HTMLDivElement>('[data-list-template-text-input]')).find(
      (candidate) => candidate.dataset.listTemplateTextInputId === itemId,
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
  kind="list-template"
  itemId={item.id}
  containerId={templateId}
  {depth}
  stickyParent={item.children.length > 0}
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
        onBeforeInput={handleBeforeTextInput}
        onFocusChange={handleFocusChange}
        onKeyDown={handlePendingDeletionKeydown}
        onArrowKey={(direction, editor, event) => handleTextArrowKey(direction, editor, event)}
        interceptShiftArrowAtBoundary
        onSplit={(before, after) => handleTextSplit(before, after)}
        onTabKey={handleTextTab}
        onBackspaceEmpty={handleBackspaceEmpty}
        onBackspaceStart={handleBackspaceStart}
        onMetaBackspaceEnd={handleMetaBackspaceEnd}
        onHorizontalBoundaryKey={handleHorizontalBoundaryKey}
        internalLinkSegments={linkifyItemText(item.text, listTemplates, metrics, notes)}
        onInternalLinkClick={(link) => onOpenLink(link)}
      />
      {#if alternatives.length > 0}
        <span class="wording-share" aria-label={`This wording: ${primaryShare}% of appearances`} title="Share of this item's appearances that use this wording; alternatives take the rest">
          ({primaryShare}%)
        </span>
      {/if}
      {#if typicalItemMs.has(item.id)}
        <span class="typical-duration" title="Typical time for this task, ignoring interrupted runs">
          ~{formatDuration(typicalItemMs.get(item.id) ?? 0)}
        </span>
      {/if}
      <ProbabilitySlider
        value={item.probability}
        min={allowsLowProbability ? MIN_LIST_ITEM_PROBABILITY : NORMAL_MIN_LIST_ITEM_PROBABILITY}
        step={5}
        ariaLabel="Appearance probability"
        generousHitbox
        onChange={handleProbabilityChange}
      />
      <button
        class="icon-button quiet add-alternative"
        type="button"
        title="Add alternative"
        aria-label="Add alternative"
        on:click={handleAddAlternative}
      >
        ±
      </button>
    </div>
    {#each alternatives as alternative (alternative.id)}
      <div class="option-row alternative-row">
        <span class="alternative-label" aria-hidden="true">or</span>
        <RichTextEditor
          className="template-text"
          kind="list-template-item"
          inputId={alternative.id}
          html={alternative.html}
          text={alternative.text}
          placeholder="Alternative"
          ariaLabel="List item alternative"
          singleLine
          {revision}
          onChange={(html, text, options) => handleAlternativeTextChange(alternative, html, text, options)}
          onBeforeInput={(editor, event) => handleBeforeTextInput(editor, event, alternative.id)}
          onArrowKey={handleAlternativeArrowKey}
          interceptShiftArrowAtBoundary
          onBackspaceEmpty={(editor) => handleDeleteAlternative(alternative, editor)}
          onHorizontalBoundaryKey={handleHorizontalBoundaryKey}
          internalLinkSegments={linkifyItemText(alternative.text, listTemplates, metrics, notes)}
          onInternalLinkClick={(link) => onOpenLink(link)}
        />
        {#if typicalItemMs.has(alternative.id)}
          <span class="typical-duration" title="Typical time for this task, ignoring interrupted runs">
            ~{formatDuration(typicalItemMs.get(alternative.id) ?? 0)}
          </span>
        {/if}
        <ProbabilitySlider
          value={alternative.probability}
          min={0}
          step={5}
          ariaLabel="Share of appearances"
          generousHitbox
          onChange={(probability) => handleAlternativeProbabilityChange(alternative, probability)}
        />
        <button
          class="icon-button danger"
          type="button"
          title="Delete alternative"
          aria-label="Delete alternative"
          on:click={() => handleDeleteAlternative(alternative)}
        >
          ×
        </button>
      </div>
    {/each}
  </div>

  <svelte:fragment slot="children">
    {#if item.children.length > 0}
      <div class="children">
        {#each item.children as child (child.id)}
          <svelte:self
            item={child}
            {currentExpected}
            depth={depth + 1}
            ancestorProbability={childAncestorProbability}
            {templateId}
            parentId={item.id}
            {maxExpectedWords}
            {patchItem}
            {splitItem}
            {backspaceItemAtStart}
            {deleteItem}
            {deleteItemPreservingChildren}
            {moveItem}
            {moveItemWithinLevel}
            {outdentItem}
            {addAlternative}
            {patchAlternative}
            {deleteAlternative}
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
            {typicalItemMs}
          />
        {/each}
      </div>
    {/if}
  </svelte:fragment>
</TreeItemRow>

<style>
  .alternative-row :global(.template-text) { flex: 1; min-width: 0; }
  .alternative-label,
  .wording-share {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 760px) {
    .alternative-label { display: none; }
    .wording-share { grid-column: 1; grid-row: 2; justify-self: start; }
  }
</style>
