<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { onDestroy, onMount, tick } from 'svelte'
  import { caretPointFromCoordinates } from './caretGeometry'
  import NoteItemEditor from './NoteItemEditor.svelte'
  import ReadOnlyNoteItem from './ReadOnlyNoteItem.svelte'
  import { htmlToPlainTextWithBreaks, sanitizeInlineHTML, type ItemLink } from './planner'
  import { noteClipboardHTML, noteClipboardPlainText, type NoteClipboardBlock } from './noteClipboard'
  import { NOTE_TRASH_RETENTION_DAYS, noteTrashDaysRemaining } from './noteTrash'
  import type { Id, ListTemplate, Metric, Note, NoteItemKind } from './types'

  type InlineFormatCommand = 'bold' | 'italic' | 'underline'
  type InlineFormatState = Record<InlineFormatCommand, boolean>

  const NOTE_SCROLL_SPACE_PERCENT_KEY = 'balance:noteScrollSpacePercent'
  const LEGACY_NOTE_SCROLL_SPACE_VH_KEY = 'balance:noteScrollSpaceVh'
  const DEFAULT_NOTE_SCROLL_SPACE_PERCENT = 60
  const MIN_NOTE_SCROLL_SPACE_VH = 6
  // Keep the existing default height stable while giving the upper 40% of the
  // slider more range for lifting the final lines higher in the viewport.
  const DEFAULT_NOTE_SCROLL_SPACE_VH = 31.2
  const MAX_NOTE_SCROLL_SPACE_VH = 60

  export let notes: Note[]
  export let selectedNoteId: Id
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let historyRevision = 0
  export let onSelect: (noteId: Id) => void
  export let onCreate: () => Id
  export let onTrash: (noteId: Id) => boolean | Promise<boolean>
  export let onRestore: (noteId: Id) => void
  export let onPermanentlyDelete: (noteId: Id) => boolean | Promise<boolean>
  export let onEmptyTrash: () => boolean | Promise<boolean>
  export let onRename: (noteId: Id, title: string) => void
  export let onAddItem: (noteId: Id, kind?: NoteItemKind) => Id
  export let patchItem: typeof import('./store').plannerStore.patchNoteItem
  export let splitItem: typeof import('./store').plannerStore.splitNoteItem
  export let backspaceItemAtStart: typeof import('./store').plannerStore.backspaceNoteItemAtStart
  export let deleteItem: typeof import('./store').plannerStore.deleteNoteItem
  export let deleteItemPreservingChildren: typeof import('./store').plannerStore.deleteNoteItemPreservingChildren
  export let moveItem: typeof import('./store').plannerStore.moveNoteItem
  export let moveItemWithinLevel: typeof import('./store').plannerStore.moveNoteItemWithinLevel
  export let outdentItem: typeof import('./store').plannerStore.outdentNoteItem
  export let onOpenLink: (link: ItemLink) => void
  export let trashOpen = false

  let filter = ''
  let lastActiveNoteId: Id | null = null
  let lastTrashNoteId: Id | null = null
  let copyButtonText = 'Copy note link'
  let copyButtonResetTimer: number | undefined
  let activeItemId: Id | null = null
  let activeNoteId: Id | null = null
  let noteBlocksElement: HTMLDivElement
  let bottomFollowFrame: number | null = null
  let bottomFollowRequest = 0
  let noteScrollSpacePercent = DEFAULT_NOTE_SCROLL_SPACE_PERCENT
  let noteScrollSpaceControlVisible = false
  let noteScrollSpaceAdjustmentActive = false
  $: noteScrollSpaceVh = noteScrollSpaceVhForPercent(noteScrollSpacePercent)
  let toolbarSelection: Range | null = null
  let pointerSelectionAnchor: { node: Node; offset: number; editor: HTMLDivElement; itemId: Id } | null = null
  let pointerSelectionFocus: { node: Node; offset: number; editor: HTMLDivElement; itemId: Id } | null = null
  // WKWebView clamps a DOM Selection at contenteditable boundaries when list
  // decoration sits between the editors. Keep a real row selection for lists;
  // it drives both the visible highlight and the clipboard independently.
  let selectedItemIds: Id[] = []
  let selectionAnchorItemId: Id | null = null
  let selectionFocusItemId: Id | null = null
  let pointerUsesItemSelection = false
  let inlineFormats: InlineFormatState = { bold: false, italic: false, underline: false }
  $: activeNotes = notes.filter((note) => !note.deletedAt)
  $: trashedNotes = notes
    .filter((note) => note.deletedAt)
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
  $: visibleNotes = trashOpen ? trashedNotes : activeNotes
  $: selectedNote = visibleNotes.find((note) => note.id === selectedNoteId) ?? visibleNotes[0] ?? null
  $: if (!trashOpen && selectedNote) lastActiveNoteId = selectedNote.id
  $: if (trashOpen && selectedNote) lastTrashNoteId = selectedNote.id
  $: if (selectedNoteId !== activeNoteId) {
    activeNoteId = selectedNoteId
    activeItemId = selectedNote?.items[0]?.id ?? null
    clearItemSelection()
    inlineFormats = { bold: false, italic: false, underline: false }
  }
  $: activeItem = selectedNote && activeItemId ? findItem(selectedNote.items, activeItemId) : null
  $: filteredNotes = [...visibleNotes]
    .filter((note) => `${note.title} ${flattenText(note)}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
    .sort((a, b) => trashOpen
      ? (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '')
      : b.updatedAt.localeCompare(a.updatedAt))

  function flattenText(note: Note): string {
    const visit = (items: Note['items']): string => items.map((item) => `${item.text} ${visit(item.children)}`).join(' ')
    return visit(note.items)
  }

  function findItem(items: Note['items'], itemId: Id): Note['items'][number] | null {
    for (const item of items) {
      if (item.id === itemId) return item
      const child = findItem(item.children, itemId)
      if (child) return child
    }
    return null
  }

  function createAndSelect() {
    trashOpen = false
    const id = onCreate()
    onSelect(id)
    void tick().then(() => document.querySelector<HTMLInputElement>('#note-title')?.select())
  }

  export function showNotes() {
    trashOpen = false
    filter = ''
    const noteId = activeNotes.find((note) => note.id === lastActiveNoteId)?.id ?? activeNotes[0]?.id
    if (noteId) onSelect(noteId)
  }

  export function openTrash() {
    trashOpen = true
    filter = ''
    const noteId = trashedNotes.find((note) => note.id === lastTrashNoteId)?.id ?? trashedNotes[0]?.id
    if (noteId) onSelect(noteId)
  }

  async function moveToTrash(noteId: Id) {
    const index = activeNotes.findIndex((note) => note.id === noteId)
    const nextNoteId = activeNotes[index + 1]?.id ?? activeNotes[index - 1]?.id ?? ''
    if (await onTrash(noteId)) onSelect(nextNoteId)
  }

  async function restoreFromTrash(noteId: Id) {
    onRestore(noteId)
    lastActiveNoteId = noteId
    trashOpen = false
    filter = ''
    onSelect(noteId)
    await tick()
    document.querySelector<HTMLInputElement>('#note-title')?.focus()
  }

  async function permanentlyDelete(noteId: Id) {
    const index = trashedNotes.findIndex((note) => note.id === noteId)
    const nextNoteId = trashedNotes[index + 1]?.id ?? trashedNotes[index - 1]?.id ?? ''
    if (await onPermanentlyDelete(noteId)) onSelect(nextNoteId)
  }

  async function emptyTrash() {
    if (await onEmptyTrash()) onSelect('')
  }

  async function copyLink() {
    if (!selectedNote) return
    const link = `balance://note/${selectedNote.id}`
    let copied = false
    try {
      await navigator.clipboard.writeText(link)
      copied = true
    } catch {
      const fallback = document.createElement('textarea')
      fallback.value = link
      fallback.setAttribute('readonly', '')
      fallback.style.position = 'fixed'
      fallback.style.opacity = '0'
      document.body.append(fallback)
      fallback.select()
      copied = document.execCommand('copy')
      fallback.remove()
    }
    window.clearTimeout(copyButtonResetTimer)
    copyButtonText = copied ? 'Link copied!' : 'Copy failed'
    copyButtonResetTimer = window.setTimeout(() => (copyButtonText = 'Copy note link'), 1000)
  }

  function readableDate(value: string) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(date)
  }

  function deletionCountdown(note: Note) {
    const days = noteTrashDaysRemaining(note)
    if (days <= 1) return 'Permanently deleted within 1 day'
    return `Permanently deleted in ${days} days`
  }

  async function applyBlockKind(kind: NoteItemKind) {
    if (!selectedNote) return
    const itemId = activeItemId ?? selectedNote.items[0]?.id ?? onAddItem(selectedNote.id)
    activeItemId = itemId
    patchItem(selectedNote.id, itemId, { kind, done: kind === 'checklist' ? (activeItem?.done ?? false) : false })
    await tick()
    focusActiveEditor()
  }

  async function startEmptyNote() {
    if (!selectedNote || selectedNote.items.length > 0) return
    activeItemId = onAddItem(selectedNote.id)
    await tick()
    focusActiveEditor()
  }

  function applyInlineFormat(command: InlineFormatCommand) {
    const editor = activeEditor()
    if (!editor) return
    const selection = document.getSelection()
    const liveRange = selection?.rangeCount ? selection.getRangeAt(0) : null
    const savedRange = toolbarSelection ?? (liveRange && editor.contains(liveRange.commonAncestorContainer) ? liveRange.cloneRange() : null)
    editor.focus()
    if (savedRange && selection) {
      selection.removeAllRanges()
      selection.addRange(savedRange)
    }
    editor.dispatchEvent(new CustomEvent('balanceformat', { detail: { command } }))
    toolbarSelection = null
    updateInlineFormatState()
  }

  function rememberToolbarSelection() {
    const editor = activeEditor()
    const selection = document.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    toolbarSelection = editor && range && editor.contains(range.commonAncestorContainer) ? range.cloneRange() : null
  }

  function updateInlineFormatState() {
    const editor = activeEditor()
    const selection = document.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (!editor || !range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      inlineFormats = { bold: false, italic: false, underline: false }
      return
    }

    inlineFormats = {
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
    }
  }

  function activeEditor() {
    if (!activeItemId) return null
    return Array.from(document.querySelectorAll<HTMLDivElement>('[data-note-text-input]')).find(
      (editor) => editor.dataset.noteTextInputId === activeItemId,
    ) ?? null
  }

  function focusActiveEditor() {
    const editor = activeEditor()
    if (!editor) return
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  function noteScrollContainer() {
    const workspace = noteBlocksElement?.closest<HTMLElement>('.workspace') ?? null
    if (!workspace) return null

    const documentScroller = document.scrollingElement as HTMLElement | null
    const workspaceCanScroll = workspace.scrollHeight - workspace.clientHeight > 4
    const documentCanScroll = documentScroller && documentScroller.scrollHeight - documentScroller.clientHeight > 4
    return !workspaceCanScroll && documentCanScroll ? documentScroller : workspace
  }

  function isAtNoteBottom(scroller: HTMLElement) {
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 4
  }

  function trackNoteScrollSpace(node: HTMLDivElement) {
    const scroller = noteScrollContainer()
    if (!scroller) return {}

    let frame: number | null = null
    const scrollEventTarget: HTMLElement | Document = scroller === document.scrollingElement ? document : scroller
    const updateVisibility = () => {
      frame = null
      noteScrollSpaceControlVisible = noteScrollSpaceAdjustmentActive || isAtNoteBottom(scroller)
    }
    const scheduleVisibilityUpdate = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(updateVisibility)
    }
    const resizeObserver = new ResizeObserver(scheduleVisibilityUpdate)

    scrollEventTarget.addEventListener('scroll', scheduleVisibilityUpdate, { passive: true })
    resizeObserver.observe(scroller)
    resizeObserver.observe(node)
    if (noteBlocksElement) resizeObserver.observe(noteBlocksElement)
    scheduleVisibilityUpdate()

    return {
      destroy() {
        scrollEventTarget.removeEventListener('scroll', scheduleVisibilityUpdate)
        resizeObserver.disconnect()
        if (frame !== null) window.cancelAnimationFrame(frame)
        noteScrollSpaceControlVisible = false
      },
    }
  }

  async function scrollNoteToBottomAfterLayout(scroller: HTMLElement) {
    const request = ++bottomFollowRequest
    await tick()
    if (request !== bottomFollowRequest || !scroller.isConnected) return

    if (bottomFollowFrame !== null) window.cancelAnimationFrame(bottomFollowFrame)
    bottomFollowFrame = window.requestAnimationFrame(() => {
      bottomFollowFrame = null
      scroller.scrollTop = scroller.scrollHeight
    })
  }

  function followNoteBottomAfterEdit(event: Event) {
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.closest('[data-note-text-input]')) return

    const scroller = noteScrollContainer()
    if (scroller && isAtNoteBottom(scroller)) void scrollNoteToBottomAfterLayout(scroller)
  }

  function handleNoteSelectionChange() {
    updateInlineFormatState()

    const selection = document.getSelection()
    const inputs = noteInputs()
    const lastInput = inputs.at(-1)
    if (!selection?.isCollapsed || !selection.focusNode || !lastInput?.contains(selection.focusNode)) return
    if (!caretIsOnLastVisualLine(lastInput, selection.getRangeAt(0))) return

    const scroller = noteScrollContainer()
    if (scroller && !isAtNoteBottom(scroller)) void scrollNoteToBottomAfterLayout(scroller)
  }

  function caretIsOnLastVisualLine(input: HTMLDivElement, caret: Range) {
    const content = document.createRange()
    content.selectNodeContents(input)
    const lineRects = Array.from(content.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
    if (lineRects.length === 0) return true

    const caretRect = caret.getBoundingClientRect()
    const lastLineTop = Math.max(...lineRects.map((rect) => rect.top))
    const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight) || 20
    return caretRect.bottom > lastLineTop && caretRect.top < lastLineTop + lineHeight
  }

  function normalizeNoteScrollSpacePercent(value: number) {
    return Number.isFinite(value)
      ? Math.max(0, Math.min(100, Math.round(value)))
      : DEFAULT_NOTE_SCROLL_SPACE_PERCENT
  }

  function noteScrollSpaceVhForPercent(percent: number) {
    if (percent <= DEFAULT_NOTE_SCROLL_SPACE_PERCENT) {
      return MIN_NOTE_SCROLL_SPACE_VH
        + (DEFAULT_NOTE_SCROLL_SPACE_VH - MIN_NOTE_SCROLL_SPACE_VH) * percent / DEFAULT_NOTE_SCROLL_SPACE_PERCENT
    }

    return DEFAULT_NOTE_SCROLL_SPACE_VH
      + (MAX_NOTE_SCROLL_SPACE_VH - DEFAULT_NOTE_SCROLL_SPACE_VH)
        * (percent - DEFAULT_NOTE_SCROLL_SPACE_PERCENT) / (100 - DEFAULT_NOTE_SCROLL_SPACE_PERCENT)
  }

  function noteScrollSpacePercentForVh(value: number) {
    if (!Number.isFinite(value)) return DEFAULT_NOTE_SCROLL_SPACE_PERCENT
    const clamped = Math.max(MIN_NOTE_SCROLL_SPACE_VH, Math.min(MAX_NOTE_SCROLL_SPACE_VH, value))
    if (clamped <= DEFAULT_NOTE_SCROLL_SPACE_VH) {
      return normalizeNoteScrollSpacePercent(
        (clamped - MIN_NOTE_SCROLL_SPACE_VH)
          / (DEFAULT_NOTE_SCROLL_SPACE_VH - MIN_NOTE_SCROLL_SPACE_VH) * DEFAULT_NOTE_SCROLL_SPACE_PERCENT,
      )
    }

    return normalizeNoteScrollSpacePercent(
      DEFAULT_NOTE_SCROLL_SPACE_PERCENT
        + (clamped - DEFAULT_NOTE_SCROLL_SPACE_VH)
          / (MAX_NOTE_SCROLL_SPACE_VH - DEFAULT_NOTE_SCROLL_SPACE_VH)
          * (100 - DEFAULT_NOTE_SCROLL_SPACE_PERCENT),
    )
  }

  function updateNoteScrollSpace(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const scroller = noteScrollContainer()
    const keepFollowingBottom = Boolean(scroller && isAtNoteBottom(scroller))
    noteScrollSpacePercent = normalizeNoteScrollSpacePercent(input.valueAsNumber)
    localStorage.setItem(NOTE_SCROLL_SPACE_PERCENT_KEY, String(noteScrollSpacePercent))

    if (scroller && keepFollowingBottom) void scrollNoteToBottomAfterLayout(scroller)
  }

  function beginNoteScrollSpaceAdjustment(event: PointerEvent) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    noteScrollSpaceAdjustmentActive = true
    noteScrollSpaceControlVisible = true
  }

  async function finishNoteScrollSpaceAdjustment() {
    if (!noteScrollSpaceAdjustmentActive) return

    const scroller = noteScrollContainer()
    if (scroller) await scrollNoteToBottomAfterLayout(scroller)
    await tick()
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        noteScrollSpaceAdjustmentActive = false
        noteScrollSpaceControlVisible = Boolean(scroller && isAtNoteBottom(scroller))
      })
    })
  }

  function handleEditorKeydownCapture(event: KeyboardEvent) {
    const primaryModifier = event.metaKey || event.ctrlKey
    if (selectedItemIds.length > 0) {
      if (event.key === 'Escape') {
        event.preventDefault()
        clearItemSelection()
        return
      }
      const modifierOnly = ['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)
      if (
        !modifierOnly &&
        !event.shiftKey &&
        !(primaryModifier && ['a', 'c'].includes(event.key.toLocaleLowerCase()))
      ) {
        clearItemSelection()
      }
    }
    if (['Enter', 'Backspace', 'Delete', 'Tab'].includes(event.key)) void followNoteBottomAfterEdit(event)
  }

  function noteInputs() {
    return Array.from(noteBlocksElement?.querySelectorAll<HTMLDivElement>('[data-note-text-input]') ?? [])
  }

  function handleNoteCopy(event: ClipboardEvent) {
    if (!selectedNote || !event.clipboardData) return
    const inputs = noteInputs()
    const explicitlySelected = new Set(selectedItemIds)
    const usingItemSelection = explicitlySelected.size > 1
    let range: Range | null = null
    let selectedInputs = usingItemSelection
      ? inputs.filter((input) => explicitlySelected.has(input.dataset.noteTextInputId ?? ''))
      : []

    if (!usingItemSelection) {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
      range = selection.getRangeAt(0)
      selectedInputs = inputs.filter((input) => range?.intersectsNode(input))
    }
    if (selectedInputs.length === 0) return

    const blocks = selectedInputs.flatMap((input) => {
      const fragmentRange = document.createRange()
      fragmentRange.selectNodeContents(input)
      if (range && input.contains(range.startContainer)) fragmentRange.setStart(range.startContainer, range.startOffset)
      if (range && input.contains(range.endContainer)) fragmentRange.setEnd(range.endContainer, range.endOffset)

      const container = document.createElement('div')
      container.append(fragmentRange.cloneContents())
      const html = sanitizeInlineHTML(container.innerHTML)
      const text = htmlToPlainTextWithBreaks(html)
      if (!html && !text) return []

      const itemId = input.dataset.noteTextInputId
      const item = itemId ? findItem(selectedNote.items, itemId) : null
      const row = input.closest<HTMLElement>('[data-note-item-id]')
      if (!item || !row) return []

      return [{
        kind: item.kind,
        depth: Number(row.dataset.noteItemDepth ?? 0),
        html,
        text,
        done: item.done,
        number: numberedMarker(row),
      } satisfies NoteClipboardBlock]
    })
    if (blocks.length === 0 || (blocks.length === 1 && !blocks[0].html.includes('<br>'))) return

    const plainText = noteClipboardPlainText(blocks)
    const html = noteClipboardHTML(blocks)
    event.preventDefault()
    event.clipboardData.setData('text/plain', plainText)
    event.clipboardData.setData('text/html', html)
    if (isTauri()) {
      window.setTimeout(() => {
        void invoke('write_note_clipboard', {
          plainText,
          html: `<meta charset='utf-8'>${html}`,
        }).catch(() => {})
      })
    }
  }

  function numberedMarker(row: HTMLElement) {
    const value = Number.parseInt(row.dataset.noteItemNumber ?? '1', 10)
    return Number.isFinite(value) ? value : 1
  }

  function handleNotePointerDown(event: PointerEvent) {
    if (event.button !== 0 || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) return
    const target = event.target instanceof Element ? event.target : null
    const editor = target?.closest<HTMLDivElement>('[data-note-text-input]') ?? null
    const point = editor ? caretPointFromCoordinates(editor, event.clientX, event.clientY) : null
    const itemId = editor?.dataset.noteTextInputId

    if (event.shiftKey && editor && point && itemId && extendSelectionToClick(editor, point, itemId)) {
      event.preventDefault()
      pointerSelectionAnchor = null
      pointerSelectionFocus = null
      pointerUsesItemSelection = false
      return
    }

    clearItemSelection()
    pointerSelectionAnchor = editor && point && itemId ? { ...point, editor, itemId } : null
    pointerSelectionFocus = null
    pointerUsesItemSelection = false
  }

  function extendSelectionToClick(
    focusEditor: HTMLDivElement,
    focus: { node: Node; offset: number },
    focusId: Id,
  ) {
    const inputs = noteInputs()
    const selection = document.getSelection()
    const nativeAnchorNode = selection?.anchorNode ?? null
    const nativeAnchorEditor = nativeAnchorNode
      ? inputs.find((input) => input.contains(nativeAnchorNode)) ?? null
      : null
    const trackedAnchorEditor = selectionAnchorItemId
      ? inputs.find((input) => input.dataset.noteTextInputId === selectionAnchorItemId) ?? null
      : null
    const anchorEditor = trackedAnchorEditor ?? nativeAnchorEditor
    const anchorId = selectionAnchorItemId ?? anchorEditor?.dataset.noteTextInputId
    if (!anchorEditor || !anchorId || anchorEditor === focusEditor && !selectionAnchorItemId) return false

    if (isListEditor(anchorEditor) || isListEditor(focusEditor)) {
      selectItemRange(anchorId, focusId)
      focusEditor.focus()
      clearNativeSelection()
      window.requestAnimationFrame(clearNativeSelection)
      return true
    }

    if (!selection || !nativeAnchorNode) return false
    const anchor = { node: nativeAnchorNode, offset: selection.anchorOffset }
    focusEditor.focus()
    applyPointerSelection(anchor, focus)
    window.requestAnimationFrame(() => applyPointerSelection(anchor, focus))
    return true
  }

  function handleNotePointerMove(event: PointerEvent) {
    if (
      !pointerSelectionAnchor ||
      !(event.buttons & 1) ||
      (event.pointerType !== 'mouse' && event.pointerType !== 'pen')
    ) return

    const target = event.target instanceof Element ? event.target : null
    const row = target?.closest<HTMLElement>('[data-note-item-id]') ?? null
    const editor = target?.closest<HTMLDivElement>('[data-note-text-input]')
      ?? row?.querySelector<HTMLDivElement>('[data-note-text-input]')
      ?? null
    if (!editor || editor === pointerSelectionAnchor.editor) return

    const point = caretPointFromCoordinates(editor, event.clientX, event.clientY)
    const itemId = editor.dataset.noteTextInputId
    if (!point || !itemId) return
    pointerSelectionFocus = { ...point, editor, itemId }
    event.preventDefault()
    if (isListEditor(pointerSelectionAnchor.editor) || isListEditor(editor)) {
      pointerUsesItemSelection = true
      selectItemRange(pointerSelectionAnchor.itemId, itemId)
      clearNativeSelection()
      return
    }
    applyPointerSelection(pointerSelectionAnchor, pointerSelectionFocus)
  }

  function finishNotePointerSelection(event: PointerEvent) {
    const anchor = pointerSelectionAnchor
    const focus = pointerSelectionFocus
    const usedItemSelection = pointerUsesItemSelection
    pointerSelectionAnchor = null
    pointerSelectionFocus = null
    pointerUsesItemSelection = false
    if (!anchor || !focus) return

    event.preventDefault()
    if (usedItemSelection) {
      clearNativeSelection()
      window.requestAnimationFrame(clearNativeSelection)
      return
    }
    applyPointerSelection(anchor, focus)
    window.requestAnimationFrame(() => applyPointerSelection(anchor, focus))
  }

  function clearNativeSelection() {
    document.getSelection()?.removeAllRanges()
  }

  function extendItemSelection(itemId: Id, direction: 'up' | 'down') {
    const inputs = noteInputs()
    const focusId = selectionFocusItemId ?? itemId
    const focusIndex = inputs.findIndex((input) => input.dataset.noteTextInputId === focusId)
    if (focusIndex < 0) return false

    const adjacentIndex = direction === 'up' ? focusIndex - 1 : focusIndex + 1
    const adjacent = inputs[adjacentIndex]
    const current = inputs[focusIndex]
    if (!adjacent || (!isListEditor(current) && !isListEditor(adjacent))) return false

    const adjacentId = adjacent.dataset.noteTextInputId
    if (!adjacentId) return false
    const anchorId = selectionAnchorItemId ?? itemId
    selectItemRange(anchorId, adjacentId)
    focusItemSelectionEndpoint(adjacent, direction)
    return true
  }

  function selectAllItems() {
    const inputs = noteInputs()
    const firstId = inputs[0]?.dataset.noteTextInputId
    const lastId = inputs.at(-1)?.dataset.noteTextInputId
    if (!firstId || !lastId) return
    selectItemRange(firstId, lastId)
  }

  function selectItemRange(anchorId: Id, focusId: Id) {
    const inputs = noteInputs()
    const anchorIndex = inputs.findIndex((input) => input.dataset.noteTextInputId === anchorId)
    const focusIndex = inputs.findIndex((input) => input.dataset.noteTextInputId === focusId)
    if (anchorIndex < 0 || focusIndex < 0) return

    selectionAnchorItemId = anchorId
    selectionFocusItemId = focusId
    if (anchorIndex === focusIndex) {
      selectedItemIds = []
      return
    }
    const start = Math.min(anchorIndex, focusIndex)
    const end = Math.max(anchorIndex, focusIndex)
    selectedItemIds = inputs.slice(start, end + 1).flatMap((input) => input.dataset.noteTextInputId ?? [])
  }

  function clearItemSelection() {
    selectedItemIds = []
    selectionAnchorItemId = null
    selectionFocusItemId = null
  }

  function isListEditor(editor: HTMLDivElement) {
    return Boolean(editor.closest('.note-list-item'))
  }

  function focusItemSelectionEndpoint(editor: HTMLDivElement, direction: 'up' | 'down') {
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(direction === 'up')
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  function applyPointerSelection(
    anchor: { node: Node; offset: number },
    focus: { node: Node; offset: number },
  ) {
    if (!anchor.node.isConnected || !focus.node.isConnected) return
    document.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  }

  onMount(() => {
    const storedPercent = localStorage.getItem(NOTE_SCROLL_SPACE_PERCENT_KEY)
    const legacyVh = localStorage.getItem(LEGACY_NOTE_SCROLL_SPACE_VH_KEY)
    noteScrollSpacePercent = storedPercent === null
      ? legacyVh === null
        ? DEFAULT_NOTE_SCROLL_SPACE_PERCENT
        : noteScrollSpacePercentForVh(Number(legacyVh))
      : normalizeNoteScrollSpacePercent(Number(storedPercent))
    localStorage.setItem(NOTE_SCROLL_SPACE_PERCENT_KEY, String(noteScrollSpacePercent))
    localStorage.removeItem(LEGACY_NOTE_SCROLL_SPACE_VH_KEY)
  })

  onDestroy(() => {
    bottomFollowRequest += 1
    if (bottomFollowFrame !== null) window.cancelAnimationFrame(bottomFollowFrame)
    noteScrollSpaceAdjustmentActive = false
  })
</script>

<svelte:document
  on:selectionchange={handleNoteSelectionChange}
  on:keyup={updateInlineFormatState}
  on:beforeinput|capture={followNoteBottomAfterEdit}
  on:keydown|capture={handleEditorKeydownCapture}
  on:copy={handleNoteCopy}
  on:pointerdown|capture={handleNotePointerDown}
  on:pointermove|capture={handleNotePointerMove}
  on:pointerup|capture={finishNotePointerSelection}
  on:pointercancel|capture={finishNotePointerSelection}
/>
<svelte:window
  on:pointerup={finishNoteScrollSpaceAdjustment}
  on:pointercancel={finishNoteScrollSpaceAdjustment}
/>

<div class="notes-workspace">
  <aside class="notes-sidebar" aria-label="Notes">
    <div class="notes-sidebar-head">
      {#if trashOpen}
        <h3>Bin</h3>
        {#if trashedNotes.length > 0}<button class="ghost danger note-empty-trash" type="button" aria-label="Empty Bin" on:click={emptyTrash}>Empty</button>{/if}
      {:else}
        <button class="primary note-new" type="button" on:click={createAndSelect}>+ New</button>
      {/if}
    </div>
    <input class="notes-filter" type="search" bind:value={filter} placeholder={trashOpen ? 'Filter Bin' : 'Filter notes'} aria-label={trashOpen ? 'Filter Bin' : 'Filter notes'} />
    <div class="notes-list">
      {#each filteredNotes as note (note.id)}
        <button type="button" class="note-card" class:active={note.id === selectedNote?.id} on:click={() => onSelect(note.id)}>
          <strong>{note.title.trim() || 'Untitled note'}</strong>
          <span>{flattenText(note).trim().replace(/\s+/g, ' ').slice(0, 90) || 'Empty note'}</span>
          <time datetime={trashOpen ? note.deletedAt ?? note.updatedAt : note.updatedAt}>{readableDate(trashOpen ? note.deletedAt ?? note.updatedAt : note.updatedAt)}</time>
        </button>
      {/each}
      {#if visibleNotes.length > 0 && filteredNotes.length === 0}<p class="notes-no-match">No matching notes.</p>{/if}
    </div>
    {#if trashOpen}<button class="notes-back-link" type="button" on:click={showNotes}><span aria-hidden="true">←</span> Back to Notes</button>{/if}
  </aside>

  <section class="note-document">
    {#if selectedNote}
      <header class="note-document-head">
        {#if trashOpen}
          <h1 class="note-title note-trashed-title">{selectedNote.title.trim() || 'Untitled note'}</h1>
        {:else}
          <input id="note-title" class="note-title" value={selectedNote.title} placeholder="Untitled note" aria-label="Note title" on:input={(event) => onRename(selectedNote!.id, event.currentTarget.value)} />
        {/if}
        <div class="note-actions">
          {#if trashOpen}
            <button class="primary" type="button" on:click={() => restoreFromTrash(selectedNote!.id)}>Restore</button>
            <button class="ghost danger" type="button" on:click={() => permanentlyDelete(selectedNote!.id)}>Delete now</button>
          {:else}
            <button type="button" title="Copy an app link to this note" aria-live="polite" on:click={copyLink}>{copyButtonText}</button>
            <button class="ghost danger" type="button" on:click={() => moveToTrash(selectedNote!.id)}>Bin it</button>
          {/if}
        </div>
      </header>

      {#if trashOpen}
        <div class="note-trash-notice" role="status">
          <span aria-hidden="true">⌛</span>
          <div>
            <strong>{deletionCountdown(selectedNote)}</strong>
            <small>Notes stay in Bin for {NOTE_TRASH_RETENTION_DAYS} days. Restore this note to edit it again.</small>
          </div>
        </div>
        <div class="note-blocks note-readonly-blocks">
          {#if selectedNote.items.length === 0}
            <p class="note-readonly-empty">This note is empty.</p>
          {:else}
            {#each selectedNote.items as item (item.id)}
              <ReadOnlyNoteItem {item} siblings={selectedNote.items} />
            {/each}
          {/if}
        </div>
      {:else}
        <div class="note-format-toolbar" role="toolbar" aria-label="Note formatting">
        <div class="note-format-group" aria-label="Text style">
          <button type="button" class:active={activeItem?.kind === 'paragraph'} aria-label="Text" title="Text" on:click={() => applyBlockKind('paragraph')}>Aa</button>
          <button type="button" class:active={activeItem?.kind === 'heading'} aria-label="Heading" title="Heading (# then Space)" on:click={() => applyBlockKind('heading')}>H1</button>
        </div>
        <div class="note-format-group" aria-label="Lists">
          <button type="button" class:active={activeItem?.kind === 'bullet'} aria-label="Bulleted list" title="Bulleted list (- then Space)" on:click={() => applyBlockKind('bullet')}>•</button>
          <button type="button" class:active={activeItem?.kind === 'numbered'} aria-label="Numbered list" title="Numbered list (1. then Space)" on:click={() => applyBlockKind('numbered')}>1.</button>
          <button type="button" class:active={activeItem?.kind === 'checklist'} aria-label="Checklist" title="Checklist ([] then Space)" on:click={() => applyBlockKind('checklist')}>✓</button>
        </div>
        <div class="note-format-group" aria-label="Inline formatting">
          <button type="button" class:active={inlineFormats.bold} aria-label="Bold" aria-pressed={inlineFormats.bold ? 'true' : 'false'} title="Bold (⌘B)" on:mousedown|preventDefault={rememberToolbarSelection} on:click={() => applyInlineFormat('bold')}><strong>B</strong></button>
          <button type="button" class:active={inlineFormats.italic} aria-label="Italic" aria-pressed={inlineFormats.italic ? 'true' : 'false'} title="Italic (⌘I)" on:mousedown|preventDefault={rememberToolbarSelection} on:click={() => applyInlineFormat('italic')}><em>I</em></button>
          <button type="button" class:active={inlineFormats.underline} aria-label="Underline" aria-pressed={inlineFormats.underline ? 'true' : 'false'} title="Underline (⌘U)" on:mousedown|preventDefault={rememberToolbarSelection} on:click={() => applyInlineFormat('underline')}><u>U</u></button>
        </div>
        <span class="note-format-hint">Type <kbd>/</kbd> for more</span>
        </div>

        <div class="note-blocks" bind:this={noteBlocksElement}>
        {#if selectedNote.items.length === 0}
          <button class="note-empty-editor" type="button" on:click={startEmptyNote}>Start writing…</button>
        {:else}
          {#each selectedNote.items as item (item.id)}
            <NoteItemEditor
              {item}
              siblings={selectedNote.items}
              noteId={selectedNote.id}
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
              notes={activeNotes}
              {onOpenLink}
              {selectedItemIds}
              onExtendItemSelection={extendItemSelection}
              onSelectAllItems={selectAllItems}
              onFocusItem={(itemId) => (activeItemId = itemId)}
            />
          {/each}
        {/if}
        </div>
      {/if}

    {:else}
      <div class="empty-state note-empty">
        {#if trashOpen}
          <div class="note-empty-trash-icon" aria-hidden="true">✓</div>
          <h3>Bin is empty</h3>
          <p>Binned notes stay here for {NOTE_TRASH_RETENTION_DAYS} days before they are permanently deleted.</p>
        {:else}
          <h3>{activeNotes.length === 0 ? 'Your notes live here' : 'Choose a note'}</h3>
          <p>Keep reference material, lists, and ideas separate from any particular day.</p>
          <button class="primary" type="button" on:click={createAndSelect}>+ New note</button>
        {/if}
      </div>
    {/if}
  </section>
</div>
{#if selectedNote && !trashOpen}
  <div
    class="note-scroll-space"
    style={`--note-scroll-space-height: ${noteScrollSpaceVh}vh; --note-scroll-space-dynamic-height: ${noteScrollSpaceVh}dvh; --note-scroll-space-progress: ${noteScrollSpacePercent}%`}
    use:trackNoteScrollSpace
  >
    <label class="note-scroll-space-control" class:visible={noteScrollSpaceControlVisible}>
      <span class="note-scroll-space-slider">
        <input
          class="note-scroll-space-native-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          value={noteScrollSpacePercent}
          aria-label="Bottom writing space"
          on:input={updateNoteScrollSpace}
          on:pointerdown={beginNoteScrollSpaceAdjustment}
        />
        <span class="note-scroll-space-track" aria-hidden="true"></span>
        <span class="note-scroll-space-fill" aria-hidden="true"></span>
        <span class="note-scroll-space-thumb" aria-hidden="true"></span>
      </span>
    </label>
  </div>
{/if}
