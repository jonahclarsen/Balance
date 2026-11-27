<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import PlanItemEditor from './PlanItemEditor.svelte'
  import VoiceIdeaModal from './VoiceIdeaModal.svelte'
  import IdeaReviewCadence from './IdeaReviewCadence.svelte'
  import IdeaTrashWindow from './IdeaTrashWindow.svelte'
  import VoiceRecordControls from './VoiceRecordControls.svelte'
  import VoiceClipChip from './VoiceClipChip.svelte'
  import { plannerStore } from './store'
  import { collapsedPlanItemIds, setPlanItemCollapsed } from './collapsedPlanItems'
  import { focusTaskBelow } from './taskCompletionFocus'
  import { ideaUnlockDelay, findIdea, ideaGroupId, ideaGroupKindForKey, ideaGroupMeta, IDEA_GROUPS, IDEA_TRASH_RETENTION_DAYS, scheduledIdeaReviewDefault, type ScheduledIdeaReviewKind } from './ideas'
  import { isURL, itemLinkFromAnchor, linkifyItemText, renderItemDisplayHTML, type ItemLink, type ItemTimeWarning } from './planner'
  import { openExternalURLFromShortcut, openRenderedLinkFromShortcut } from './externalLinks'
  import { clipsByIdea } from './voiceClips'
  import { voiceRecording, voiceRecordingError } from './voiceRecorder'
  import { canTranscribe, transcribeClips, transcriptionError, transcriptionStatus } from './voiceTranscription'
  import type { Id, IdeaGroup, IdeaGroupKind, ListTemplate, Metric, Note, PlanItem, VoiceClip } from './types'

  export let groups: IdeaGroup[]
  export let voiceClips: VoiceClip[] = []
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let notes: Note[] = []
  export let mobile = false
  export let findOpen = false
  export let activeGroup: IdeaGroupKind = 'proposition'
  export let onSelectGroup: (kind: IdeaGroupKind) => void = () => {}
  export let onOpenLink: (link: ItemLink, itemId: Id) => void = () => {}
  export let onImport: () => void
  export let onReview: () => void
  export let onSortPropositions: () => void
  export let onCopyItem: (groupId: Id, itemId: Id) => void = () => {}
  export let onCutItem: (groupId: Id, itemId: Id) => void = () => {}
  export let onPasteItem: (groupId: Id, itemId: Id) => void | Promise<void> = () => {}

  const noTimeWarnings: ReadonlyMap<Id, ItemTimeWarning> = new Map()

  // Root ideas in the showing group, in list order. The anchor is where a
  // range starts; the focus is the end Shift+arrows move.
  let selectedItemIds: Id[] = []
  let selectionAnchorId: Id | null = null
  let selectionFocusId: Id | null = null
  // Dragging from a row's handle, or out of its text, selects a range.
  let dragSelecting = false
  let textDragOrigin: { itemId: Id; input: HTMLElement } | null = null
  // Focus from the press that ended a drag must not drop the selection.
  let keepSelectionUntil = 0
  // Leaving Proposition Party unlocks each destination on its own delay,
  // counted from when the latest row was added to the selection.
  let selectedAt = 0
  let unlockTimers: number[] = []
  let unlockTick = 0
  let shaking: IdeaGroupKind | null = null
  let shakeTimer: number | null = null
  let openClipId: Id | null = null
  let trashWindow: IdeaTrashWindow | null = null

  $: selectedIdeas = selectedItemIds.flatMap((id) => findIdea(groups, id) ?? [])
  $: selected = selectedIdeas[0] ?? null
  $: clipForIdea = clipsByIdea(voiceClips)
  $: untranscribed = voiceClips.filter((clip) => !clip.transcript)
  $: openClip = openClipId ? voiceClips.find((clip) => clip.id === openClipId) ?? null : null
  $: openIdea = openClip ? findIdea(groups, openClip.ideaId) : null
  $: transcribing = $transcriptionStatus
  // Drop the selection once its idea disappears (undo, sync, purge).
  $: dropMissingSelection(groups)
  // An idea stays selected only while its group is the one showing.
  $: if (selected && selected.group.kind !== activeGroup) clearSelection()
  $: selectedItemIdSet = new Set(selectedItemIds)
  // Missing groups render empty; the map keeps the template reactive to `groups`.
  $: groupsByKind = Object.fromEntries(IDEA_GROUPS.map((meta) => [
    meta.kind, groups.find((group) => group.kind === meta.kind) ?? { id: ideaGroupId(meta.kind), kind: meta.kind, items: [] },
  ])) as Record<IdeaGroupKind, IdeaGroup>
  $: activeMeta = ideaGroupMeta(activeGroup)
  $: activeScheduled = scheduledKind(activeGroup)

  function scheduledKind(kind: IdeaGroupKind): ScheduledIdeaReviewKind | null {
    return scheduledIdeaReviewDefault(kind) === null ? null : kind as ScheduledIdeaReviewKind
  }
  $: activeItems = groupsByKind[activeGroup].items

  function dropMissingSelection(current: IdeaGroup[]) {
    const kept = selectedItemIds.filter((id) => findIdea(current, id))
    if (kept.length === selectedItemIds.length) return
    selectedItemIds = kept
    if (!kept.includes(selectionAnchorId ?? '')) selectionAnchorId = kept[0] ?? null
    if (!kept.includes(selectionFocusId ?? '')) selectionFocusId = kept.at(-1) ?? null
  }

  function rootIds(): Id[] {
    return activeItems.map((item) => item.id)
  }

  // Selections hold root ideas; a nested row stands for the idea it is in.
  function rootIdOf(itemId: Id): Id | null {
    const contains = (items: PlanItem[]): boolean => items.some((item) => item.id === itemId || contains(item.children))
    return activeItems.find((item) => item.id === itemId || contains(item.children))?.id ?? null
  }

  export async function includeIdea(itemId: Id) {
    if (!trashWindow) return
    const root = rootIdOf(itemId)
    if (!root) return
    trashWindow.include(root)
    await tick()
  }

  async function revealTrashSelection(itemId: Id) {
    if (!trashWindow) return
    await includeIdea(itemId)
    document.querySelector<HTMLElement>(
      `.ideas-panel [data-plan-item-id="${CSS.escape(itemId)}"]`,
    )?.scrollIntoView({ block: 'nearest' })
  }

  function setSelection(ids: Id[], anchorId: Id | null = ids[0] ?? null, focusId: Id | null = ids.at(-1) ?? null) {
    const wanted = new Set(ids)
    const next = ids.length ? rootIds().filter((id) => wanted.has(id)) : []
    const previous = new Set(selectedItemIds)
    const added = next.some((id) => !previous.has(id))
    selectedItemIds = next
    selectionAnchorId = next.length ? anchorId : null
    selectionFocusId = next.length ? focusId : null
    if (added) restartUnlockTimers()
    if (next.length) releaseTextFocus()
  }

  function select(itemId: Id | null) {
    setSelection(itemId ? [itemId] : [])
  }

  function clearSelection() {
    setSelection([])
    dragSelecting = false
  }

  function restartUnlockTimers() {
    selectedAt = Date.now()
    for (const timer of unlockTimers) window.clearTimeout(timer)
    unlockTimers = []
    for (const target of IDEA_GROUPS) {
      const delay = ideaUnlockDelay(activeGroup, target.kind)
      if (delay > 0) unlockTimers.push(window.setTimeout(() => { unlockTick += 1 }, delay))
    }
  }

  export function releaseTextFocus() {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.closest('.ideas-panel')) return
    if (!active.closest('input, textarea, [contenteditable="true"]')) return
    document.getSelection()?.removeAllRanges()
    active.blur()
  }

  function selectRange(fromId: Id, toId: Id, additive = false) {
    const ids = rootIds()
    const from = ids.indexOf(fromId)
    const to = ids.indexOf(toId)
    if (from === -1 || to === -1) return
    const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1)
    setSelection(additive ? [...selectedItemIds, ...range] : range, fromId, toId)
  }

  function toggleSelected(itemId: Id) {
    const next = selectedItemIds.includes(itemId)
      ? selectedItemIds.filter((id) => id !== itemId)
      : [...selectedItemIds, itemId]
    setSelection(next, next.includes(itemId) ? itemId : next[0] ?? null, next.includes(itemId) ? itemId : next.at(-1) ?? null)
  }

  function locked(kind: IdeaGroupKind, _tick: number): boolean {
    return Date.now() < selectedAt + ideaUnlockDelay(selected?.group.kind ?? null, kind)
  }

  function handleSelectionPointerDown(rowId: Id, event: PointerEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const itemId = rootIdOf(rowId)
    if (!itemId) return
    if (event.shiftKey && selectionAnchorId) selectRange(selectionAnchorId, itemId, event.metaKey || event.ctrlKey)
    else if (event.metaKey || event.ctrlKey) toggleSelected(itemId)
    else if (selectedItemIds.length === 1 && selectedItemIds[0] === itemId) {
      clearSelection()
      return
    } else select(itemId)
    dragSelecting = true
  }

  function rowIdAtPoint(x: number, y: number): Id | null {
    for (const row of document.querySelectorAll<HTMLElement>('.ideas-panel .idea-group-list [data-plan-item-id]')) {
      const rect = row.getBoundingClientRect()
      if (y >= rect.top && y <= rect.bottom && x >= rect.left && x <= rect.right) return row.dataset.planItemId ?? null
    }
    return null
  }

  function leftElement(event: PointerEvent, element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    return event.clientX < rect.left - 3 || event.clientX > rect.right + 3 ||
      event.clientY < rect.top - 3 || event.clientY > rect.bottom + 3
  }

  function handleWindowPointerDown(event: PointerEvent) {
    textDragOrigin = null
    if (mobile || event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    const input = target?.closest<HTMLElement>('.ideas-panel .idea-group-list [data-rich-text-input]')
    const rowId = input?.closest<HTMLElement>('[data-plan-item-id]')?.dataset.planItemId
    const itemId = rowId ? rootIdOf(rowId) : null
    if (!input || !itemId) return
    keepSelectionUntil = 0
    // Shift-clicking another idea while editing one selects both and those between.
    const editingId = focusedIdeaId()
    const editingRoot = editingId ? rootIdOf(editingId) : null
    if (event.shiftKey && editingRoot && editingRoot !== itemId) {
      event.preventDefault()
      event.stopPropagation()
      selectRange(editingRoot, itemId)
      return
    }
    textDragOrigin = { itemId, input }
  }

  function handleWindowPointerMove(event: PointerEvent) {
    pointer = { x: event.clientX, y: event.clientY }
    if (mobile) return
    if (!dragSelecting && textDragOrigin && (event.buttons & 1) === 1 && leftElement(event, textDragOrigin.input)) {
      event.preventDefault()
      select(textDragOrigin.itemId)
      dragSelecting = true
    }
    if (!dragSelecting || !selectionAnchorId) return
    const rowId = rowIdAtPoint(event.clientX, event.clientY)
    const itemId = rowId ? rootIdOf(rowId) : null
    if (itemId && itemId !== selectionFocusId) selectRange(selectionAnchorId, itemId)
  }

  function handleWindowPointerUp() {
    if (dragSelecting && selectedItemIds.length > 0) keepSelectionUntil = Date.now() + 250
    dragSelecting = false
    textDragOrigin = null
  }

  // Editing an idea's text ends the selection, as on Today.
  function handleWindowFocusIn(event: FocusEvent) {
    const target = event.target instanceof Element ? event.target : null
    if (!selectedItemIds.length || !target?.closest('.ideas-panel [contenteditable="true"], .ideas-panel input, .ideas-panel textarea')) return
    if (target.closest('input.check[type="checkbox"]')) return
    if (dragSelecting || Date.now() < keepSelectionUntil) {
      releaseTextFocus()
      return
    }
    clearSelection()
  }

  // Shift+Up/Down from an idea's text selects it and its neighbour.
  function selectWithAdjacent(rowId: Id, direction: 'up' | 'down') {
    const itemId = rootIdOf(rowId)
    if (!itemId) return
    const ids = rootIds()
    const index = ids.indexOf(itemId)
    const target = ids[direction === 'up' ? Math.max(0, index - 1) : Math.min(ids.length - 1, index + 1)]!
    selectRange(itemId, target)
  }

  // Shift+Up/Down moves the selection's free end; meeting the anchor returns to editing it.
  async function extendSelection(direction: 'up' | 'down') {
    const ids = rootIds()
    const anchorId = selectionAnchorId ?? selectedItemIds[0]
    const focusIndex = ids.indexOf(selectionFocusId ?? selectedItemIds.at(-1) ?? '')
    if (!anchorId || focusIndex === -1) return
    const target = ids[direction === 'up' ? Math.max(0, focusIndex - 1) : Math.min(ids.length - 1, focusIndex + 1)]!
    if (target === anchorId && selectedItemIds.length > 1) {
      clearSelection()
      await includeIdea(anchorId)
      await tick()
      document.querySelector<HTMLElement>(
        `.ideas-panel [data-plan-text-focus-target-id="${CSS.escape(anchorId)}"]`,
      )?.focus()
      return
    }
    selectRange(anchorId, target)
    void revealTrashSelection(target)
  }

  function shake(kind: IdeaGroupKind) {
    shaking = kind
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
    shakeTimer = window.setTimeout(() => { shaking = null }, 420)
  }

  function attemptMove(kind: IdeaGroupKind) {
    if (!selected || selected.group.kind === kind) return
    if (locked(kind, unlockTick)) {
      shake(kind)
      return
    }
    plannerStore.moveIdeasToGroup(selectedIdeas.map(({ item }) => item.id), kind)
    clearSelection()
  }

  function moveSelection(direction: -1 | 1) {
    const ids = rootIds()
    if (ids.length === 0) return
    const index = selectionFocusId ? ids.indexOf(selectionFocusId) : -1
    const next = index === -1 ? (direction === 1 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, index + direction))
    select(ids[next]!)
    void revealTrashSelection(ids[next]!)
  }

  function editingText(): boolean {
    const active = document.activeElement
    return active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea, select'))
  }

  function focusedIdeaId(): Id | null {
    const active = document.activeElement
    const row = active instanceof Element ? active.closest<HTMLElement>('.ideas-panel [data-plan-item-id]') : null
    return row?.dataset.planItemId ?? null
  }

  let pointer: { x: number; y: number } | null = null

  function caretAt(x: number, y: number): { node: Node; offset: number } | null {
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
    if (doc.caretPositionFromPoint) {
      const position = doc.caretPositionFromPoint(x, y)
      return position ? { node: position.offsetNode, offset: position.offset } : null
    }
    const range = document.caretRangeFromPoint?.(x, y)
    return range ? { node: range.startContainer, offset: range.startOffset } : null
  }

  // The link the caret sits in or touches at either end, so a caret just
  // before or after a link still opens it.
  function anchorAtCaret(editor: HTMLElement, node: Node, offset: number): HTMLAnchorElement | null {
    if (!editor.contains(node)) return null
    const textBefore = (target: Node, targetOffset: number) => {
      const range = document.createRange()
      range.setStart(editor, 0)
      range.setEnd(target, targetOffset)
      return range.toString().length
    }
    const caret = textBefore(node, offset)
    let touching: HTMLAnchorElement | null = null
    for (const anchor of editor.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const range = document.createRange()
      range.selectNodeContents(anchor)
      const start = textBefore(range.startContainer, range.startOffset)
      const end = start + range.toString().length
      if (start < caret && caret < end) return anchor
      if (!touching && (caret === start || caret === end)) touching = anchor
    }
    return touching
  }

  function openAnchor(anchor: HTMLAnchorElement, itemId: Id): boolean {
    const link = itemLinkFromAnchor(anchor)
    if (link) {
      onOpenLink(link, itemId)
      return true
    }
    const href = anchor.getAttribute('href')?.trim() ?? ''
    if (!isURL(href)) return false
    openExternalURLFromShortcut(href)
    return true
  }

  function ideaEditorAt(node: Node | null | undefined) {
    const element = node instanceof Element ? node : node?.parentElement
    const editor = element?.closest<HTMLElement>('.ideas-panel [contenteditable="true"]')
    const itemId = editor?.closest<HTMLElement>('[data-plan-item-id]')?.dataset.planItemId
    return editor && itemId ? { editor, itemId } : null
  }

  // Option-F opens the link under the mouse or at the caret, else the first
  // link in the idea being edited or selected, as on Today.
  function openIdeaLink(): boolean {
    if (pointer) {
      const hit = document.elementFromPoint(pointer.x, pointer.y)
      const anchor = hit?.closest<HTMLAnchorElement>('.ideas-panel a[href]')
      const hovered = ideaEditorAt(anchor ?? hit)
      if (anchor && hovered && openAnchor(anchor, hovered.itemId)) return true
      const caret = hovered && caretAt(pointer.x, pointer.y)
      const near = caret && hovered && anchorAtCaret(hovered.editor, caret.node, caret.offset)
      if (near && hovered && openAnchor(near, hovered.itemId)) return true
    }
    const selection = document.getSelection()
    const focused = ideaEditorAt(selection?.focusNode)
    if (focused && selection?.focusNode) {
      const anchor = anchorAtCaret(focused.editor, selection.focusNode, selection.focusOffset)
      if (anchor && openAnchor(anchor, focused.itemId)) return true
    }
    const active = document.activeElement
    const itemId = focusedIdeaId() ??
      (active === document.body || active?.closest('.ideas-panel') ? selectionFocusId : null)
    const item = itemId ? findIdea(groups, itemId)?.item : null
    if (!item) return false
    return openRenderedLinkFromShortcut(
      renderItemDisplayHTML(item.html, item.text, linkifyItemText(item.text, listTemplates, metrics, notes)),
      (link) => onOpenLink(link, item.id),
    )
  }

  // Cmd/Ctrl+Shift+A selects the idea being edited, like on Today.
  function selectFocusedIdea(event: KeyboardEvent) {
    const itemId = focusedIdeaId()
    if (!itemId) return
    event.preventDefault()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    select(itemId)
  }

  // Cmd/Ctrl+D toggles done like on Today: the selected idea stays selected,
  // and completing the idea being edited moves the caret to the one below.
  function toggleDoneFromKeyboard(event: KeyboardEvent) {
    if (selected) {
      event.preventDefault()
      if (event.repeat) return
      const done = !selectedIdeas.every(({ item }) => item.done)
      plannerStore.setIdeasDone(selected.group.id, selectedIdeas.map(({ item }) => item.id), done)
      return
    }
    const target = focusedIdeaId()
    const found = target ? findIdea(groups, target) : null
    if (!found) return
    event.preventDefault()
    if (event.repeat) return
    const done = !found.item.done
    plannerStore.patchIdeaItem(found.group.id, found.item.id, { done })
    if (done) void focusTaskBelow(found.group.id, [found.item.id])
  }

  async function toggleChildrenFromKeyboard() {
    const itemId = focusedIdeaId() ?? selectionFocusId
    if (!itemId) return
    function targetIn(items: PlanItem[], parent: PlanItem | null = null): PlanItem | null {
      for (const item of items) {
        if (item.id === itemId) return item.children.length ? item : parent
        const found = targetIn(item.children, item)
        if (found) return found
      }
      return null
    }
    const target = targetIn(activeItems)
    if (!target) return
    const collapse = !$collapsedPlanItemIds.has(target.id)
    setPlanItemCollapsed(target.id, collapse)
    if (collapse && target.id !== itemId) {
      select(null)
      await tick()
      document.querySelector<HTMLElement>(
        `.ideas-panel [data-plan-text-focus-target-id="${CSS.escape(target.id)}"]`,
      )?.focus()
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (openClip) return
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'r') {
      event.preventDefault()
      if (!event.repeat) void toggleChildrenFromKeyboard()
      return
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
      toggleDoneFromKeyboard(event)
      return
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'a') {
      selectFocusedIdea(event)
      return
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.code === 'KeyF' &&
        !event.defaultPrevented && openIdeaLink()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    // Shift+Up/Down, with or without Cmd, grows or shrinks the selection.
    if (selected && event.shiftKey && !event.ctrlKey && !event.altKey && !event.defaultPrevented &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown') && !editingText()) {
      event.preventDefault()
      event.stopPropagation()
      void extendSelection(event.key === 'ArrowUp' ? 'up' : 'down')
      return
    }
    if (event.ctrlKey || event.altKey || event.repeat || editingText()) return
    // Backspace and Cmd+Backspace both delete selected ideas, to Trash unless already there.
    if (selected && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault()
      plannerStore.deleteIdeaItems(selected.group.id, selectedIdeas.map(({ item }) => item.id))
      clearSelection()
      return
    }
    if (event.metaKey) return
    if (event.key === 'Escape') {
      if (selected) {
        event.preventDefault()
        clearSelection()
      }
      return
    }
    if (!selected) return
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.shiftKey) {
      event.preventDefault()
      moveSelection(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    const kind = ideaGroupKindForKey(event.key)
    if (!kind) return
    event.preventDefault()
    event.stopPropagation()
    attemptMove(kind)
  }

  // The phone rail scrolls sideways; keep the open card on screen.
  function revealWhenActive(node: HTMLElement, active: boolean) {
    const reveal = (isActive: boolean) => {
      if (isActive && mobile) node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    reveal(active)
    return { update: reveal }
  }

  function transcribe(clips: VoiceClip[]) {
    void transcribeClips(clips, plannerStore.applyVoiceTranscript)
  }

  function moveOpenIdea(kind: IdeaGroupKind) {
    if (openIdea) plannerStore.moveIdeaToGroup(openIdea.item.id, kind)
    openClipId = null
  }

  async function addItem(groupId: Id) {
    const itemId = plannerStore.addRootIdeaItem(groupId)
    await tick()
    await includeIdea(itemId)
    document.querySelector<HTMLDivElement>(
      `[data-plan-item-scope="${CSS.escape(groupId)}"] [data-plan-item-id="${CSS.escape(itemId)}"] [data-plan-text-focus-target]`,
    )?.focus()
  }

  onDestroy(() => {
    for (const timer of unlockTimers) window.clearTimeout(timer)
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
  })
</script>

<svelte:window
  on:keydown={handleKeydown}
  on:pointerdown|capture={handleWindowPointerDown}
  on:pointermove={handleWindowPointerMove}
  on:pointerup={handleWindowPointerUp}
  on:pointercancel={handleWindowPointerUp}
  on:focusin={handleWindowFocusIn}
/>

{#snippet ideaEditor(item: PlanItem)}
  {@const clip = clipForIdea.get(item.id)}
  <PlanItemEditor
    {item}
    allItems={activeItems}
    timeWarnings={noTimeWarnings}
    planId={groupsByKind[activeGroup].id}
    patchItem={plannerStore.patchIdeaItem}
    splitItem={plannerStore.splitIdeaItem}
    backspaceItemAtStart={plannerStore.backspaceIdeaItemAtStart}
    deleteItem={plannerStore.deleteIdeaItem}
    deleteItemPreservingChildren={plannerStore.deleteIdeaItemPreservingChildren}
    moveItem={plannerStore.moveIdeaItem}
    moveItemWithinLevel={plannerStore.moveIdeaItemWithinLevel}
    outdentItem={plannerStore.outdentIdeaItem}
    historyRevision={$plannerStore.historyRevision}
    selectedItemIds={selectedItemIdSet}
    selectionDragging={dragSelecting}
    onSelectionPointerDown={handleSelectionPointerDown}
    onTextShiftArrow={selectWithAdjacent}
    onMobileSelectionStart={(itemId) => { const root = rootIdOf(itemId); if (root) select(root) }}
    onMobileSelectionToggle={(itemId) => { const root = rootIdOf(itemId); if (root) toggleSelected(root) }}
    {mobile}
    mobileSelectionMode={mobile && selectedItemIds.length > 0}
    {listTemplates}
    {metrics}
    {notes}
    {onOpenLink}
    {onCopyItem}
    {onCutItem}
    {onPasteItem}
    hideTime
    collapsible
    placeholder={clip ? 'Voice idea' : undefined}
  >
    <svelte:fragment slot="trailing">
      {#if clip}
        <VoiceClipChip {clip} onOpen={() => { openClipId = clip.id }} />
      {/if}
    </svelte:fragment>
  </PlanItemEditor>
{/snippet}

<section class="ideas-panel">
  <header class="page-header">
    <h2>Ideas</h2>
    <div class="page-actions">
      {#if activeGroup === 'proposition'}
        <button class="page-action" type="button" disabled={activeItems.length === 0} on:click={onSortPropositions}>Sort</button>
      {:else if activeScheduled}
        {#if mobile}<IdeaReviewCadence kind={activeScheduled} {groups} label={activeMeta.label} />{/if}
        <button class="page-action" type="button" on:click={onReview}>Review</button>
      {:else if activeGroup === 'trash'}
        <span class="idea-group-note">clears after {IDEA_TRASH_RETENTION_DAYS} days</span>
      {/if}
      {#if canTranscribe && untranscribed.length > 0 && $voiceRecording.state === 'idle'}
        <button class="page-action" type="button" disabled={transcribing.state !== 'idle'} on:click={() => transcribe(untranscribed)}>
          {#if transcribing.state === 'downloading'}Downloading {Math.round(transcribing.fraction * 100)}%{:else if transcribing.state === 'transcribing'}Transcribing {transcribing.done + 1}/{transcribing.total}{:else if transcribing.state === 'preparing'}Transcribing…{:else}Transcribe {untranscribed.length}{/if}
        </button>
      {/if}
      <!-- A new recording lands in Proposition Party, so show it there. -->
      <VoiceRecordControls onStart={() => onSelectGroup('proposition')} />
      <button class="page-action" type="button" on:click={onImport}>Import</button>
    </div>
  </header>

  {#if $voiceRecordingError || $transcriptionError}
    <p class="voice-idea-error" role="alert">{$voiceRecordingError ?? $transcriptionError}</p>
  {/if}

  <div class="ideas-layout">
    <nav class="idea-group-cards" aria-label="Idea groups">
      {#each IDEA_GROUPS as meta (meta.kind)}
        {@const items = groupsByKind[meta.kind].items}
        {@const preview = items.find((item) => item.text.trim())?.text}
        {@const scheduled = mobile ? null : scheduledKind(meta.kind)}
        <div class="idea-group-slot">
        <button
          type="button"
          class="idea-group-card"
          class:scheduled
          class:active={meta.kind === activeGroup}
          aria-current={meta.kind === activeGroup ? 'true' : undefined}
          data-idea-group={meta.kind}
          data-balance-link={`balance://idea-group/${meta.kind}`}
          use:revealWhenActive={meta.kind === activeGroup}
          on:click={() => onSelectGroup(meta.kind)}
        >
          <strong>{meta.label}</strong>
          <span class="idea-group-count">{items.length}</span>
          {#if preview}<small>{preview}</small>{/if}
        </button>
        <!-- A sibling, since inputs can't sit inside the card button; it
             occupies the card's reserved bottom padding. -->
        {#if scheduled}
          <div class="idea-group-card-cadence"><IdeaReviewCadence kind={scheduled} {groups} label={meta.label} onTap={() => onSelectGroup(meta.kind)} /></div>
        {/if}
        </div>
      {/each}
    </nav>

    <section class="idea-group-pane" data-idea-pane={activeGroup} data-balance-link={`balance://idea-group/${activeGroup}`} aria-label={activeMeta.label}>
      <div class="list-panel idea-group-list" data-plan-item-scope={groupsByKind[activeGroup].id}>
        {#if activeGroup === 'proposition'}
          <button class="add-row add-row-top" type="button" on:click={() => { void addItem(groupsByKind[activeGroup].id) }}>+ Add item</button>
        {/if}
        {#if activeGroup === 'trash' && activeItems.length}
          <IdeaTrashWindow bind:this={trashWindow} items={activeItems} {mobile} renderAll={findOpen} renderItem={ideaEditor} />
        {:else}
          {#each activeItems as item (item.id)}
            {@render ideaEditor(item)}
          {/each}
        {/if}
        {#if activeGroup !== 'proposition'}
          <button class="add-row" type="button" on:click={() => { void addItem(groupsByKind[activeGroup].id) }}>+ Add item</button>
        {/if}
      </div>
      {#if selected}
        <div class="idea-move-strip" role="group" aria-label={selectedIdeas.length > 1 ? `Move ${selectedIdeas.length} ideas to` : 'Move idea to'}>
          {#each IDEA_GROUPS.filter((target) => target.kind !== activeGroup) as target (target.kind)}
            <button
              type="button"
              class="idea-group-button"
              class:locked={locked(target.kind, unlockTick)}
              class:shaking={shaking === target.kind}
              aria-disabled={locked(target.kind, unlockTick) ? 'true' : undefined}
              on:click={() => attemptMove(target.kind)}
            >{target.label} <kbd aria-hidden="true">{target.key.toUpperCase()}</kbd></button>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</section>

{#if openClip && openIdea}
  {#key openClip.id}
    <VoiceIdeaModal
      clip={openClip}
      idea={openIdea.item}
      onEdit={(text, html) => { if (openIdea) plannerStore.patchIdeaItem(openIdea.group.id, openIdea.item.id, { text, html }) }}
      onMove={moveOpenIdea}
      onTranscribe={() => { if (openClip?.transcript) plannerStore.applyVoiceTranscript(openClip.id, openClip.transcript); else if (openClip) transcribe([openClip]) }}
      onClose={() => { openClipId = null }}
    />
  {/key}
{/if}

<style>
  .ideas-panel { display: grid; align-content: start; }
  .page-header h2 { margin: 0; }
  .add-row-top { margin: 0 0 12px; }
  .idea-group-list > .add-row:first-child:last-child { margin: 0; }
  .ideas-layout {
    display: grid;
    grid-template-columns: 230px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  .idea-group-cards {
    position: sticky;
    top: calc(var(--tree-sticky-base, 0px) + 12px);
    z-index: 1;
    display: grid;
    gap: 6px;
  }
  .idea-group-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 8px;
    width: 100%;
    padding: 10px 11px;
    text-align: left;
  }
  .idea-group-slot { position: relative; }
  /* Reserves room for the cadence below the card's text, clear of its middle. */
  .idea-group-card.scheduled { padding-bottom: 38px; }
  .idea-group-card-cadence {
    position: absolute;
    left: 11px;
    bottom: 8px;
  }
  .idea-group-card:not(.active) {
    border-color: var(--line);
    background: var(--paper);
  }
  .idea-group-card:not(.active):hover { background: var(--paper-strong); }
  .idea-group-card strong { font-size: 14px; font-weight: 600; line-height: 1.35; }
  .idea-group-card small {
    grid-column: 1 / -1;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .idea-group-count { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .idea-group-pane { min-width: 0; }
  .idea-group-note { color: var(--muted); font-size: 12px; }
  .voice-idea-error { margin: 0 0 12px; color: var(--danger); font-size: 13px; }
  .idea-move-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }
  .idea-move-strip button { font-size: 14px; padding: 6px 10px; }
  .idea-move-strip kbd {
    margin-left: 4px;
    font-size: 11px;
    opacity: 0.7;
  }
  @media (max-width: 760px) {
    .ideas-layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
    /* The cards stay pinned as a sideways strip under the phone header. */
    .idea-group-cards {
      top: var(--tree-sticky-base, 0px);
      z-index: 10;
      display: flex;
      flex-wrap: nowrap;
      height: 56px;
      margin-inline: -12px;
      padding: 8px 12px;
      overflow-x: auto;
      /* Some themes use translucent paper; keep scrolled ideas from showing through. */
      background: var(--paper-strong);
      scrollbar-width: none;
    }
    .idea-group-slot { display: flex; flex: 0 0 auto; }
    .idea-group-card {
      flex: 0 0 auto;
      width: auto;
      align-items: center;
      padding-block: 0;
    }
    .idea-group-card small { display: none; }
    .idea-group-pane { --tree-sticky-base: calc(var(--mobile-header-height, 0px) + 56px); }
  }
</style>
