<script lang="ts">
  import { tick } from 'svelte'
  import { caretPointFromCoordinates, collapsedCaretClientX } from './caretGeometry'
  import { escapeHTML, linkifyItemText, sanitizeInlineHTML, type ItemLink, type ItemTextSegment } from './planner'
  import RichTextEditor from './RichTextEditor.svelte'
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
  export let onFocusItem: (itemId: Id) => void = () => {}
  export let selectedItemIds: Id[] = []
  export let onExtendItemSelection: (itemId: Id, direction: MoveDirection) => boolean = () => false
  export let onSelectAllItems: () => void = () => {}
  export let onToggleChecklist: (itemId: Id, done: boolean) => void = () => {}

  let linkSegments: ItemTextSegment[] = [{ text: item.text, link: null }]
  let slashQuery: string | null = null
  let slashIndex = 0
  let noteBlockElement: HTMLDivElement
  const blockCommands: { kind: NoteItemKind; label: string; hint: string; aliases?: string[] }[] = [
    { kind: 'paragraph', label: 'Text', hint: 'Plain body text' },
    { kind: 'heading', label: 'Heading', hint: 'Large section heading', aliases: ['h1', 'header'] },
    { kind: 'bullet', label: 'Bulleted list', hint: 'Start a simple list' },
    { kind: 'numbered', label: 'Numbered list', hint: 'Start an ordered list' },
    { kind: 'checklist', label: 'Checklist', hint: 'Track something to do' },
  ]
  $: linkSegments = linkifyItemText(item.text, listTemplates, metrics, notes)
  $: itemNumber = numberedPosition(siblings, item.id)
  $: slashCommands = slashQuery === null
    ? []
    : blockCommands.filter((command) => [command.label, ...(command.aliases ?? [])]
      .some((term) => term.toLocaleLowerCase().includes(slashQuery ?? '')))
  $: if (slashIndex >= slashCommands.length) slashIndex = 0

  function positionSlashMenu(node: HTMLDivElement) {
    let frame: number | null = null
    const workspace = node.closest<HTMLElement>('.workspace')
    const noteDocument = node.closest<HTMLElement>('.note-document')
    const update = () => {
      frame = null
      if (!noteBlockElement.isConnected || !node.isConnected) return

      node.style.top = 'calc(100% + 4px)'
      node.style.left = '0px'
      const blockBounds = noteBlockElement.getBoundingClientRect()
      const menuBounds = node.getBoundingClientRect()
      const noteBounds = noteDocument?.getBoundingClientRect()
      const effectiveZoom = node.offsetWidth > 0 ? menuBounds.width / node.offsetWidth : 1
      const viewportGap = 8
      const topEdge = Math.max(viewportGap, noteBounds?.top ?? viewportGap)
      const bottomEdge = Math.min(
        window.innerHeight - viewportGap,
        (noteBounds?.bottom ?? window.innerHeight) - viewportGap,
      )
      const leftEdge = Math.max(viewportGap, noteBounds?.left ?? viewportGap)
      const rightEdge = Math.min(
        window.innerWidth - viewportGap,
        (noteBounds?.right ?? window.innerWidth) - viewportGap,
      )
      const top = Math.max(
        topEdge,
        Math.min(blockBounds.bottom + 4, bottomEdge - menuBounds.height),
      )
      const left = Math.max(
        leftEdge,
        Math.min(blockBounds.left, rightEdge - menuBounds.width),
      )
      node.style.top = `${(top - blockBounds.top) / effectiveZoom}px`
      node.style.left = `${(left - blockBounds.left) / effectiveZoom}px`
    }
    const scheduleUpdate = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(update)
    }
    const resizeObserver = new ResizeObserver(scheduleUpdate)

    window.addEventListener('resize', scheduleUpdate)
    window.addEventListener('scroll', scheduleUpdate, { passive: true })
    workspace?.addEventListener('scroll', scheduleUpdate, { passive: true })
    noteDocument?.addEventListener('scroll', scheduleUpdate, { passive: true })
    resizeObserver.observe(node)
    resizeObserver.observe(noteBlockElement)
    update()

    return {
      destroy() {
        window.removeEventListener('resize', scheduleUpdate)
        window.removeEventListener('scroll', scheduleUpdate)
        workspace?.removeEventListener('scroll', scheduleUpdate)
        noteDocument?.removeEventListener('scroll', scheduleUpdate)
        resizeObserver.disconnect()
        if (frame !== null) window.cancelAnimationFrame(frame)
      },
    }
  }

  async function handleSplit(before: { html: string; text: string }, after: { html: string; text: string }) {
    if ((item.kind === 'heading' || item.kind === 'checklist') && !before.text.trim() && !after.text.trim()) {
      patchItem(noteId, item.id, { kind: 'paragraph', done: false })
      await tick()
      focusInput(item.id, 'start')
      return
    }
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
    if (event.shiftKey) {
      if (onExtendItemSelection(item.id, direction)) return
      extendSelectionToAdjacentLine(current, direction)
      return
    }
    focusAdjacentVisually(current, direction)
  }

  function extendSelectionToAdjacentLine(current: HTMLDivElement, direction: MoveDirection) {
    const selection = document.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) return

    const inputs = noteInputs()
    const index = inputs.indexOf(current)
    if (index < 0) return

    const adjacent = inputs[direction === 'up' ? index - 1 : index + 1]
    const target = adjacent ?? current
    const sourceOffset = textOffsetAtPoint(current, selection.focusNode, selection.focusOffset)
    const targetOffset = adjacent
      ? Math.min(sourceOffset, target.textContent?.length ?? 0)
      : direction === 'up'
        ? 0
        : target.textContent?.length ?? 0
    const targetPoint = pointAtTextOffset(target, targetOffset)

    selection.setBaseAndExtent(
      selection.anchorNode,
      selection.anchorOffset,
      targetPoint.node,
      targetPoint.offset,
    )
  }

  function textOffsetAtPoint(input: HTMLDivElement, node: Node, offset: number) {
    if (!input.contains(node)) return 0
    const range = document.createRange()
    range.selectNodeContents(input)
    range.setEnd(node, offset)
    return range.toString().length
  }

  function pointAtTextOffset(input: HTMLDivElement, requestedOffset: number) {
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT)
    let remaining = requestedOffset
    let node = walker.nextNode()

    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) return { node, offset: remaining }
      remaining -= length
      node = walker.nextNode()
    }

    return { node: input as Node, offset: requestedOffset <= 0 ? 0 : input.childNodes.length }
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
    if (inputs.length === 1) {
      patchItem(noteId, item.id, { kind: 'paragraph', done: false, html: '', text: '' })
      await tick()
      focusInput(item.id, 'start')
      return
    }
    const index = inputs.findIndex((input) => input.dataset.noteTextInputId === item.id)
    deleteItem(noteId, item.id)
    await tick()
    const next = noteInputs()
    const target = next[Math.max(0, index - 1)] ?? next[0]
    if (target) focusElement(target)
  }

  async function handleBackspaceStart() {
    if (item.kind !== 'paragraph') {
      patchItem(noteId, item.id, { kind: 'paragraph', done: false })
      await tick()
      focusInput(item.id, 'start')
      return
    }
    const result = backspaceItemAtStart(noteId, item.id)
    if (!result) {
      if (!item.text.trim()) await handleBackspaceEmpty()
      return
    }
    await tick()
    focusInputAtOffset(result.focusItemId, result.focusOffset)
  }

  async function handleDeleteEnd(current: HTMLDivElement) {
    const inputs = noteInputs()
    const index = inputs.findIndex((input) => input.dataset.noteTextInputId === item.id)
    const nextInput = inputs[index + 1]
    const nextItemId = nextInput?.dataset.noteTextInputId
    if (!nextItemId) return

    current.innerHTML = sanitizeInlineHTML(`${current.innerHTML}${nextInput.innerHTML}`)
    const result = backspaceItemAtStart(noteId, nextItemId)
    if (!result) return
    await tick()
    focusInputAtOffset(result.focusItemId, result.focusOffset)
  }

  async function handleMetaBackspaceEnd(current: HTMLDivElement) {
    const inputs = noteInputs()
    if (inputs.length === 1) {
      current.innerHTML = ''
      patchItem(noteId, item.id, { kind: 'paragraph', done: false, html: '', text: '' })
      await tick()
      focusInput(item.id, 'start')
      return
    }
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

  function focusAdjacentVisually(current: HTMLDivElement, direction: MoveDirection) {
    const inputs = noteInputs()
    const index = inputs.indexOf(current)
    const target = inputs[direction === 'up' ? index - 1 : index + 1]
    if (!target) return

    const sourceX = collapsedCaretClientX(current)
    const sourceIsEmpty = !(current.textContent?.length ?? 0)
    const targetId = target?.dataset.noteTextInputId
    const sourceOffset = caretOffset(current)
    if (sourceX === null) {
      if (targetId) focusInputAtOffset(targetId, sourceOffset)
      return
    }

    target.focus()
    const rect = target.getBoundingClientRect()
    const style = getComputedStyle(target)
    const lineHeight = Number.parseFloat(style.lineHeight) || 20
    const paddingTop = Number.parseFloat(style.paddingTop) || 0
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0
    const targetY = direction === 'up'
      ? rect.bottom - paddingBottom - lineHeight / 2
      : rect.top + paddingTop + lineHeight / 2
    const point = caretPointFromCoordinates(target, sourceX, targetY)
    if (!point) {
      if (targetId) focusInputAtOffset(targetId, sourceOffset)
      return
    }

    const range = document.createRange()
    range.setStart(point.node, point.offset)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    // The left edge of a soft-wrapped line shares a DOM offset with the end of
    // the line above. Nudge downstream when Chromium gives that point the
    // upstream visual affinity, so Up still enters the actual last line.
    if (sourceIsEmpty && direction === 'up' && selection?.modify && selection.rangeCount > 0) {
      const placedRect = selection.getRangeAt(0).getBoundingClientRect()
      if (placedRect.height > 0 && placedRect.bottom < targetY) {
        selection.modify('move', 'forward', 'character')
      }
    }
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

  function numberedPosition(items: NoteItem[], itemId: Id) {
    const index = items.findIndex((candidate) => candidate.id === itemId)
    if (index < 0) return 1
    let start = index
    while (start > 0 && items[start - 1].kind === 'numbered') start -= 1
    return index - start + 1
  }

  function markdownKind(text: string): { kind: NoteItemKind; content: string } | null {
    const shortcuts: { expression: RegExp; kind: NoteItemKind }[] = [
      { expression: /^#\s(.*)$/s, kind: 'heading' },
      { expression: /^(?:-|\*)\s(.*)$/s, kind: 'bullet' },
      { expression: /^[1-9]\d*\.\s(.*)$/s, kind: 'numbered' },
      { expression: /^\[\s?\]\s(.*)$/s, kind: 'checklist' },
    ]
    for (const shortcut of shortcuts) {
      const match = text.match(shortcut.expression)
      if (match) return { kind: shortcut.kind, content: match[1] }
    }
    return null
  }

  function handleTextChange(html: string, text: string, options?: TextChangeOptions, editor?: HTMLDivElement) {
    const shortcut = markdownKind(text)
    if (shortcut && !(item.kind === 'heading' && shortcut.kind === 'numbered')) {
      const nextHTML = shortcut.content ? escapeHTML(shortcut.content) : ''
      patchItem(noteId, item.id, { kind: shortcut.kind, done: false, html: nextHTML, text: shortcut.content }, options)
      slashQuery = null
      if (editor) replaceEditorContent(editor, nextHTML)
      return
    }

    const slashMatch = text.match(/^\/([^\s/]*)$/)
    slashQuery = slashMatch ? slashMatch[1].toLocaleLowerCase() : null
    if (slashQuery !== null) slashIndex = 0
    patchItem(noteId, item.id, { html, text }, options)
  }

  async function applySlashCommand(command: (typeof blockCommands)[number], editor?: HTMLDivElement) {
    patchItem(noteId, item.id, { kind: command.kind, done: false, html: '', text: '' })
    slashQuery = null
    const target = editor ?? noteInputs().find((candidate) => candidate.dataset.noteTextInputId === item.id)
    if (target) replaceEditorContent(target, '')
    await tick()
    focusInput(item.id, 'start')
  }

  function replaceEditorContent(editor: HTMLDivElement, html: string) {
    editor.innerHTML = html
    focusElement(editor)
  }

  function handleEditorKeyDown(_editor: HTMLDivElement, event: KeyboardEvent) {
    if (
      event.key.toLocaleLowerCase() === 'a' &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      const inputs = noteInputs()
      if (inputs.length > 1) {
        const selection = document.getSelection()
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null
        const editorIsFullySelected = Boolean(
          range &&
          _editor.contains(range.startContainer) &&
          _editor.contains(range.endContainer) &&
          textOffsetAtPoint(_editor, range.startContainer, range.startOffset) === 0 &&
          textOffsetAtPoint(_editor, range.endContainer, range.endOffset) === (_editor.textContent?.length ?? 0),
        )
        if (!editorIsFullySelected) return

        event.preventDefault()
        onSelectAllItems()
      }
      return
    }

    if (slashQuery === null || slashCommands.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      slashIndex = (slashIndex + 1) % slashCommands.length
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      slashIndex = (slashIndex - 1 + slashCommands.length) % slashCommands.length
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void applySlashCommand(slashCommands[slashIndex], _editor)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      slashQuery = null
    }
  }
</script>

<div
  class="note-item"
  class:note-heading={item.kind === 'heading'}
  class:note-done={item.kind === 'checklist' && item.done}
  class:note-list-item={item.kind === 'bullet' || item.kind === 'numbered' || item.kind === 'checklist'}
  class:note-bullet={item.kind === 'bullet'}
  class:note-numbered={item.kind === 'numbered'}
  class:note-multi-selected={selectedItemIds.includes(item.id)}
  data-note-item-id={item.id}
  data-note-item-depth={depth}
  data-note-item-number={item.kind === 'numbered' ? itemNumber : undefined}
  aria-label={`Note block: ${item.text || 'Empty'}`}
>
  <div class="note-block" data-note-item-number={item.kind === 'numbered' ? itemNumber : undefined} bind:this={noteBlockElement}>
    {#if item.kind === 'checklist'}
      <input
        class="check note-check"
        type="checkbox"
        checked={item.done}
        aria-label={item.done ? 'Mark unchecked' : 'Mark checked'}
        on:change={(event) => onToggleChecklist(item.id, event.currentTarget.checked)}
      />
    {/if}

    <RichTextEditor
      className="note-text"
      kind="note"
      inputId={item.id}
      html={item.html}
      text={item.text}
      done={item.kind === 'checklist' && item.done}
      placeholder={item.kind === 'heading' ? 'Heading' : 'Type / for styles'}
      ariaLabel="Note text"
      revision={historyRevision}
      onChange={handleTextChange}
      onArrowKey={handleArrow}
      interceptShiftArrowAtBoundary
      onSplit={handleSplit}
      onTabKey={handleTab}
      onBackspaceEmpty={handleBackspaceEmpty}
      onBackspaceStart={handleBackspaceStart}
      onDeleteEnd={handleDeleteEnd}
      onMetaBackspaceEnd={handleMetaBackspaceEnd}
      onHorizontalBoundaryKey={(direction, editor) => focusAdjacent(editor, direction === 'left' ? 'up' : 'down', direction === 'left' ? 'end' : 'start')}
      onFocusChange={(focused) => {
        if (focused) onFocusItem(item.id)
        else if (slashQuery !== null) window.setTimeout(() => (slashQuery = null), 150)
      }}
      onKeyDown={handleEditorKeyDown}
      internalLinkSegments={linkSegments}
      onInternalLinkClick={(link) => onOpenLink(link)}
    />
    {#if slashQuery !== null && slashCommands.length > 0}
      <div class="note-slash-menu" role="listbox" aria-label="Note styles" use:positionSlashMenu>
        {#each slashCommands as command, index (command.kind)}
          <button
            type="button"
            class:active={index === slashIndex}
            role="option"
            aria-selected={index === slashIndex}
            on:mousedown|preventDefault={() => applySlashCommand(command)}
          >
            <span class="note-slash-icon" aria-hidden="true">{command.kind === 'heading' ? 'H' : command.kind === 'bullet' ? '•' : command.kind === 'numbered' ? '1.' : command.kind === 'checklist' ? '✓' : 'Aa'}</span>
            <span><strong>{command.label}</strong><small>{command.hint}</small></span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if item.children.length > 0}
    <div class="note-children">
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
          {onFocusItem}
          {selectedItemIds}
          {onExtendItemSelection}
          {onSelectAllItems}
          {onToggleChecklist}
        />
      {/each}
    </div>
  {/if}
</div>
