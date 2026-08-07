<script lang="ts">
  import { tick } from 'svelte'
  import { linkifyItemText, type ItemLink, type ItemTextSegment } from './planner'
  import RichTextEditor from './RichTextEditor.svelte'
  import TreeItemRow from './TreeItemRow.svelte'
  import type { Id, ListTemplate, Metric, MoveDirection, MovePlacement, Note, NoteItem, NoteItemKind } from './types'

  type TextChangeOptions = { mergeHistory?: boolean }

  export let item: NoteItem
  export let siblings: NoteItem[]
  export let depth = 0
  export let noteId: Id
  export let parentId: Id | null = null
  export let patchItem: (noteId: Id, itemId: Id, patch: Partial<NoteItem>, options?: TextChangeOptions) => void
  export let splitItem: (noteId: Id, itemId: Id, before: { html: string; text: string }, after: { html: string; text: string }) => Id
  export let backspaceItemAtStart: (noteId: Id, itemId: Id) => { focusItemId: Id; focusOffset: number } | null
  export let deleteItem: (noteId: Id, itemId: Id) => void
  export let deleteItemPreservingChildren: (noteId: Id, itemId: Id) => void
  export let moveItem: (noteId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  export let moveItemWithinLevel: (noteId: Id, itemId: Id, direction: MoveDirection) => void
  export let outdentItem: (noteId: Id, itemId: Id) => void
  export let historyRevision: number
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let notes: Note[] = []
  export let onOpenLink: (link: ItemLink) => void = () => {}

  let linkSegments: ItemTextSegment[] = [{ text: item.text, link: null }]
  $: linkSegments = linkifyItemText(item.text, listTemplates, metrics, notes)
  $: itemNumber = siblings.findIndex((candidate) => candidate.id === item.id) + 1

  async function handleSplit(before: { html: string; text: string }, after: { html: string; text: string }) {
    const newItemId = splitItem(noteId, item.id, before, after)
    await tick()
    focusInput(newItemId, 'start')
  }

  async function handleArrow(direction: MoveDirection, current: HTMLDivElement, event: KeyboardEvent) {
    if (event.altKey) {
      moveItemWithinLevel(noteId, item.id, direction)
      await tick()
      focusInput(item.id)
      return
    }
    focusAdjacent(current, direction)
  }

  async function handleTab(direction: 'in' | 'out', current: HTMLDivElement) {
    const offset = caretOffset(current)
    if (direction === 'in') {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-note-item-id]'))
      const row = current.closest<HTMLElement>('[data-note-item-id]')
      const index = row ? rows.indexOf(row) : -1
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidateDepth = Number(rows[cursor].dataset.noteItemDepth ?? 0)
        if (candidateDepth === depth) {
          const targetId = rows[cursor].dataset.noteItemId
          if (targetId) {
            moveItem(noteId, item.id, targetId, 'inside')
            await tick()
            focusInputAtOffset(item.id, offset)
          }
          return
        }
        if (candidateDepth < depth) return
      }
      return
    }
    if (parentId) {
      outdentItem(noteId, item.id)
      await tick()
      focusInputAtOffset(item.id, offset)
    }
  }

  async function handleBackspaceEmpty() {
    const inputs = noteInputs()
    const index = inputs.findIndex((input) => input.dataset.noteTextInputId === item.id)
    deleteItem(noteId, item.id)
    await tick()
    const next = noteInputs()
    const target = next[Math.max(0, index - 1)] ?? next[0]
    if (target) focusElement(target)
  }

  async function handleBackspaceStart() {
    const result = backspaceItemAtStart(noteId, item.id)
    if (!result) {
      if (!item.text.trim()) await handleBackspaceEmpty()
      return
    }
    await tick()
    focusInputAtOffset(result.focusItemId, result.focusOffset)
  }

  async function handleMetaBackspaceEnd() {
    const inputs = noteInputs()
    const index = inputs.findIndex((input) => input.dataset.noteTextInputId === item.id)
    deleteItemPreservingChildren(noteId, item.id)
    await tick()
    const next = noteInputs()
    const target = next[Math.max(0, index - 1)] ?? next[0]
    if (target) focusElement(target)
  }

  function noteInputs() {
    return Array.from(document.querySelectorAll<HTMLDivElement>('[data-note-text-input]'))
  }

  function focusAdjacent(current: HTMLDivElement, direction: MoveDirection, position: 'start' | 'end' = 'end') {
    const inputs = noteInputs()
    const index = inputs.indexOf(current)
    const target = inputs[direction === 'up' ? index - 1 : index + 1]
    if (target) focusElement(target, position)
  }

  function focusInput(itemId: Id, position: 'start' | 'end' = 'end') {
    const input = noteInputs().find((candidate) => candidate.dataset.noteTextInputId === itemId)
    if (input) focusElement(input, position)
  }

  function focusElement(input: HTMLDivElement, position: 'start' | 'end' = 'end') {
    input.focus()
    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(position === 'start')
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  function caretOffset(input: HTMLDivElement) {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) return input.textContent?.length ?? 0
    const range = selection.getRangeAt(0)
    if (!input.contains(range.startContainer)) return input.textContent?.length ?? 0
    const before = document.createRange()
    before.selectNodeContents(input)
    before.setEnd(range.startContainer, range.startOffset)
    return before.toString().length
  }

  function focusInputAtOffset(itemId: Id, offset: number) {
    const input = noteInputs().find((candidate) => candidate.dataset.noteTextInputId === itemId)
    if (!input) return
    input.focus()
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT)
    let remaining = offset
    let node = walker.nextNode()
    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.collapse(true)
        const selection = document.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return
      }
      remaining -= length
      node = walker.nextNode()
    }
    focusElement(input)
  }

  function changeKind(kind: NoteItemKind) {
    patchItem(noteId, item.id, { kind, done: kind === 'checklist' ? item.done : false })
  }
</script>

<TreeItemRow
  kind="note"
  itemId={item.id}
  containerId={noteId}
  {depth}
  ariaLabel={`Note block: ${item.text || 'Empty'}`}
  {moveItem}
>
  <div class="note-block" class:note-heading={item.kind === 'heading'} class:note-done={item.kind === 'checklist' && item.done}>
    <select class="note-kind" value={item.kind} aria-label="Block style" title="Block style" on:change={(event) => changeKind(event.currentTarget.value as NoteItemKind)}>
      <option value="paragraph">Text</option>
      <option value="heading">Heading</option>
      <option value="bullet">Bulleted list</option>
      <option value="numbered">Numbered list</option>
      <option value="checklist">Checklist</option>
    </select>

    {#if item.kind === 'bullet'}<span class="note-marker" aria-hidden="true">•</span>{/if}
    {#if item.kind === 'numbered'}<span class="note-marker numbered" aria-hidden="true">{itemNumber}.</span>{/if}
    {#if item.kind === 'checklist'}
      <input
        class="check note-check"
        type="checkbox"
        checked={item.done}
        aria-label={item.done ? 'Mark unchecked' : 'Mark checked'}
        on:change={(event) => patchItem(noteId, item.id, { done: event.currentTarget.checked })}
      />
    {/if}

    <RichTextEditor
      className="note-text"
      kind="note"
      inputId={item.id}
      html={item.html}
      text={item.text}
      done={item.kind === 'checklist' && item.done}
      placeholder={item.kind === 'heading' ? 'Heading' : 'Write something…'}
      ariaLabel="Note text"
      revision={historyRevision}
      onChange={(html, text, options) => patchItem(noteId, item.id, { html, text }, options)}
      onArrowKey={handleArrow}
      onSplit={handleSplit}
      onTabKey={handleTab}
      onBackspaceEmpty={handleBackspaceEmpty}
      onBackspaceStart={handleBackspaceStart}
      onMetaBackspaceEnd={handleMetaBackspaceEnd}
      onHorizontalBoundaryKey={(direction, editor) => focusAdjacent(editor, direction === 'left' ? 'up' : 'down', direction === 'left' ? 'end' : 'start')}
      internalLinkSegments={linkSegments}
      onInternalLinkClick={(link) => onOpenLink(link)}
    />
  </div>

  <svelte:fragment slot="children">
    {#if item.children.length > 0}
      <div class="children">
        {#each item.children as child (child.id)}
          <svelte:self
            item={child}
            siblings={item.children}
            depth={depth + 1}
            {noteId}
            parentId={item.id}
            {patchItem}
            {splitItem}
            {backspaceItemAtStart}
            {deleteItem}
            {deleteItemPreservingChildren}
            {moveItem}
            {moveItemWithinLevel}
            {outdentItem}
            {historyRevision}
            {listTemplates}
            {metrics}
            {notes}
            {onOpenLink}
          />
        {/each}
      </div>
    {/if}
  </svelte:fragment>
</TreeItemRow>
