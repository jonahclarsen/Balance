<script lang="ts">
  import { externalNotePaste } from './externalNotePaste'
  import { onDestroy, onMount, tick } from 'svelte'
  import NotesPanel from './NotesPanel.svelte'
  import ReadOnlyNoteItem from './ReadOnlyNoteItem.svelte'
  import NoteEditorHost from './noteEditor/NoteEditorHost.svelte'
  import type { ItemLink } from './planner'
  import { NOTE_TRASH_RETENTION_DAYS, noteTrashDaysRemaining } from './noteTrash'
  import { noteVersionGroupId, noteVersionLabel, noteVersionsOf } from './noteVersions'
  import type { Id, ListTemplate, Metric, Note, NoteItemKind, NoteViewState } from './types'

  const NOTE_SCROLL_SPACE_PERCENT_KEY = 'balance:noteScrollSpacePercent'
  const DEFAULT_NOTE_SCROLL_SPACE_PERCENT = 60
  const MIN_NOTE_SCROLL_SPACE_SHARE = 6
  // The slider scales against the actual note viewport, excluding Goal Rhythm.
  const DEFAULT_NOTE_SCROLL_SPACE_SHARE = 31.2
  // At its maximum, scrolling to the bottom leaves this many lines in view.
  const MAX_NOTE_SCROLL_SPACE_VISIBLE_LINES = 2
  const MAX_NOTE_SCROLL_SPACE_TOLERANCE_PX = 4
  const isMac = /Mac|iPhone|iPad|iPod/.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '',
  )
  const newNoteShortcutLabel = `${isMac ? '⌘' : 'Ctrl+'}N`
  const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

  export let notes: Note[]
  export let selectedNoteId: Id
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let historyRevision = 0
  export let onSelect: (noteId: Id) => void
  export let onCreate: () => Id
  export let onTrash: (noteId: Id) => boolean | Promise<boolean>
  export let onAddVersion: (sourceNoteId: Id) => Id
  export let onRenameVersion: (noteId: Id, versionName: string) => void
  export let onTrashVersion: (noteId: Id) => void
  export let onRestore: (noteId: Id) => void
  export let onPermanentlyDelete: (noteId: Id) => boolean | Promise<boolean>
  export let onEmptyTrash: () => boolean | Promise<boolean>
  export let onRename: (noteId: Id, title: string) => void
  export let onAddItem: (noteId: Id, kind?: NoteItemKind) => Id
  export let patchItem: typeof import('./store').plannerStore.patchNoteItem
  export let patchItemsDone: typeof import('./store').plannerStore.patchNoteItemsDone
  export let replaceItems: typeof import('./store').plannerStore.replaceNoteItems
  export let onOpenLink: (link: ItemLink) => void
  export let trashOpen = false
  export let viewStatesByNote: ReadonlyMap<Id, NoteViewState> = new Map()
  export let onViewStateChange: (noteId: Id, state: NoteViewState) => void = () => {}

  // The right pane reuses the complete note editor without another sidebar.
  export let sidePane = false
  export let onClose: () => void = () => {}

  let sideNoteId: Id | null = null
  let sidePanel: { rememberBeforeLeaving: () => void } | null = null
  let titleElement: HTMLTextAreaElement | null = null
  let documentElement: HTMLElement | null = null
  $: sideNote = activeNotes.find((note) => note.id === sideNoteId) ?? null
  $: if (sideNoteId && (!sideNote || trashOpen)) closeSidePane()

  function closeSidePane() {
    sideNoteId = null
  }

  function openBeside(noteId: Id) {
    sideNoteId = noteId
  }

  let filter = ''
  let lastActiveNoteId: Id | null = null
  let lastTrashNoteId: Id | null = null
  let copyButtonText = 'Copy note link'
  let copyButtonResetTimer: number | undefined
  let noteEditorHostElement: HTMLDivElement | null = null
  let noteEditorHost: NoteEditorHost | null = null
  let bottomFollowFrame: number | null = null
  let bottomFollowRequest = 0
  // Whether the reader left the note scrolled to its bottom. Read from scroll
  // events only, so an edit that grows the note cannot clear it first.
  let noteRestsAtBottom = false
  let noteScrollSpacePercent = DEFAULT_NOTE_SCROLL_SPACE_PERCENT
  let noteScrollViewportHeight = 0
  let noteScrollSpaceControlVisible = false
  let noteScrollSpaceAdjustmentActive = false
  let noteScrollSpaceMaxShare = DEFAULT_NOTE_SCROLL_SPACE_SHARE
  $: noteScrollSpaceShare = noteScrollSpaceShareForPercent(noteScrollSpacePercent, noteScrollSpaceMaxShare)
  $: noteScrollSpaceHeight = noteScrollViewportHeight * noteScrollSpaceShare / 100
  $: activeNotes = notes.filter((note) => !note.deletedAt)
  $: trashedNotes = notes
    .filter((note) => note.deletedAt)
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
  $: visibleNotes = trashOpen ? trashedNotes : activeNotes
  $: selectedNote = visibleNotes.find((note) => note.id === selectedNoteId) ?? visibleNotes[0] ?? null
  $: wordCount = selectedNote
    ? Array.from(wordSegmenter.segment(flattenText(selectedNote))).filter((segment) => segment.isWordLike).length
    : 0
  $: if (!trashOpen && selectedNote) lastActiveNoteId = selectedNote.id
  $: if (trashOpen && selectedNote) lastTrashNoteId = selectedNote.id
  $: selectedVersions = selectedNote && !trashOpen ? noteVersionsOf(activeNotes, noteVersionGroupId(selectedNote)) : []
  $: if (selectedNote && !trashOpen) lastVersionByGroup.set(noteVersionGroupId(selectedNote), selectedNote.id)
  // The Bin lists each binned version on its own; Notes lists one card per note.
  $: noteCards = trashOpen ? trashedNotes.map((note) => [note]) : groupVersions(activeNotes)
  $: filteredCards = noteCards
    .filter((versions) => versions.some((note) => `${note.title} ${flattenText(note)}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())))
    .sort((a, b) => trashOpen
      ? (b[0].deletedAt ?? '').localeCompare(a[0].deletedAt ?? '')
      : latestUpdate(b).localeCompare(latestUpdate(a)))

  const lastVersionByGroup = new Map<Id, Id>()
  let renamingVersionId: Id | null = null
  let versionNameDraft = ''

  function groupVersions(notes: Note[]): Note[][] {
    const groups = new Map<Id, Note[]>()
    for (const note of notes) {
      const groupId = noteVersionGroupId(note)
      groups.set(groupId, [...(groups.get(groupId) ?? []), note])
    }
    return [...groups.keys()].map((groupId) => noteVersionsOf(notes, groupId))
  }

  function latestUpdate(versions: Note[]) {
    return versions.reduce((latest, note) => note.updatedAt > latest ? note.updatedAt : latest, '')
  }

  function cardNote(versions: Note[], selected: Note | null): Note {
    if (selected && versions.some((note) => note.id === selected.id)) return selected
    const remembered = lastVersionByGroup.get(noteVersionGroupId(versions[0]))
    return versions.find((note) => note.id === remembered)
      ?? versions.reduce((latest, note) => note.updatedAt > latest.updatedAt ? note : latest)
  }

  function binnedVersionLabel(note: Note) {
    if (!note.versionOf && !notes.some((other) => other.versionOf === note.id)) return ''
    return noteVersionLabel(note, noteVersionsOf(notes, noteVersionGroupId(note)))
  }

  function addVersion() {
    if (!selectedNote) return
    const id = onAddVersion(selectedNote.id)
    if (id) onSelect(id)
  }

  function startRenamingVersion(note: Note) {
    renamingVersionId = note.id
    versionNameDraft = noteVersionLabel(note, selectedVersions)
  }

  function finishRenamingVersion(commit: boolean) {
    const noteId = renamingVersionId
    renamingVersionId = null
    if (!commit || !noteId) return
    const note = selectedVersions.find((version) => version.id === noteId)
    if (!note) return
    const name = versionNameDraft.trim()
    const defaultLabel = noteVersionLabel({ ...note, versionName: '' }, selectedVersions)
    onRenameVersion(noteId, name === defaultLabel ? '' : name)
  }

  function handleVersionNameKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      finishRenamingVersion(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finishRenamingVersion(false)
    }
  }

  function trashVersion(noteId: Id) {
    const index = selectedVersions.findIndex((note) => note.id === noteId)
    const nextNoteId = selectedVersions[index + 1]?.id ?? selectedVersions[index - 1]?.id ?? ''
    onTrashVersion(noteId)
    if (noteId === selectedNote?.id && nextNoteId) onSelect(nextNoteId)
  }

  function handleVersionTabKeydown(event: KeyboardEvent, index: number) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = selectedVersions[(index + (event.key === 'ArrowRight' ? 1 : -1) + selectedVersions.length) % selectedVersions.length]
    onSelect(next.id)
    void tick().then(() => documentElement?.querySelector<HTMLButtonElement>(`[data-note-version-tab="${next.id}"]`)?.focus())
  }

  function selectVersionInput(node: HTMLInputElement) {
    node.focus()
    node.select()
  }

  function flattenText(note: Note): string {
    const visit = (items: Note['items']): string => items.map((item) => `${item.text} ${visit(item.children)}`).join(' ')
    return visit(note.items)
  }

  export function createNote() {
    trashOpen = false
    const id = onCreate()
    onSelect(id)
    void tick().then(() => titleElement?.select())
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
    const groups = groupVersions(activeNotes)
    const index = groups.findIndex((versions) => versions.some((note) => note.id === noteId))
    const nextGroup = groups[index + 1] ?? groups[index - 1]
    const nextNoteId = nextGroup ? cardNote(nextGroup, null).id : ''
    if (await onTrash(noteId)) {
      if (sidePane) onClose()
      else onSelect(nextNoteId)
    }
  }

  async function restoreFromTrash(noteId: Id) {
    onRestore(noteId)
    lastActiveNoteId = noteId
    trashOpen = false
    filter = ''
    onSelect(noteId)
    await tick()
    titleElement?.focus()
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

  function autoSizeTitle(node: HTMLTextAreaElement, _title: string) {
    function resize() {
      if (!node.isConnected) return
      node.style.height = '0px'
      const style = getComputedStyle(node)
      // Leave a pixel for WebKit's fractional rounding under the Notes zoom.
      node.style.height = `${Math.ceil(node.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)) + 1}px`
    }

    let width = -1
    let resizeFrame = 0
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return
      width = entry.contentRect.width
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(resize)
    })
    observer.observe(node)
    void tick().then(resize)

    return {
      update(_title: string) { void tick().then(resize) },
      destroy() {
        observer.disconnect()
        cancelAnimationFrame(resizeFrame)
      },
    }
  }

  // Enter moves into the end of the note, Tab into its start (P-06).
  async function handleTitleKeydown(event: KeyboardEvent) {
    if (
      (event.key !== 'Enter' && event.key !== 'Tab') ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      !selectedNote
    ) return

    event.preventDefault()
    const edge = event.key === 'Tab' ? 'start' : 'end'
    void noteEditorHost?.focusEdge(edge)
  }

  function focusTitle() {
    const title = titleElement
    if (!title) return
    title.focus()
    title.setSelectionRange(title.value.length, title.value.length)
  }

  function noteScrollContainer() {
    const blocksElement = noteEditorHostElement
    const noteDocument = blocksElement?.closest<HTMLElement>('.note-document') ?? null
    if (noteDocument && ['auto', 'scroll'].includes(getComputedStyle(noteDocument).overflowY)) {
      return noteDocument
    }

    if (window.matchMedia('(max-width: 760px)').matches) {
      return document.scrollingElement as HTMLElement | null
    }

    const workspace = blocksElement?.closest<HTMLElement>('.workspace') ?? null
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
    const initialScroller = noteScrollContainer()
    if (!initialScroller) return {}
    let scroller: HTMLElement = initialScroller
    noteScrollViewportHeight = scroller.clientHeight

    let frame: number | null = null
    let remeasure = true
    let measured = false
    let scrollEventTarget: HTMLElement | Document = scroller === document.scrollingElement ? document : scroller
    const updateVisibility = () => {
      frame = null
      // Crossing the narrow-layout breakpoint moves scrolling between the note
      // pane and the page. The old pane then grows with its content; measuring
      // it as a viewport would grow the writing space on every edit.
      const nextScroller = noteScrollContainer()
      if (nextScroller && nextScroller !== scroller) {
        cancelNoteBottomFollow()
        scrollEventTarget.removeEventListener('scroll', handleScroll)
        resizeObserver.unobserve(scroller)
        scroller = nextScroller
        scrollEventTarget = scroller === document.scrollingElement ? document : scroller
        scrollEventTarget.addEventListener('scroll', handleScroll, { passive: true })
        resizeObserver.observe(scroller)
        noteRestsAtBottom = isAtNoteBottom(scroller)
        remeasure = true
        measured = false
      }
      noteScrollViewportHeight = scroller.clientHeight
      // Hold the maximum steady while dragging; it follows the drag's own layout.
      if (remeasure && !noteScrollSpaceAdjustmentActive) {
        remeasure = false
        const maxShare = measureMaxNoteScrollSpaceShare(scroller, node)
        // Resizing the space shifts its subpixel rounding, which moves the
        // measurement slightly; following that would resize the space forever.
        const changedPx = Math.abs(maxShare - noteScrollSpaceMaxShare) * scroller.clientHeight / 100
        if (!measured || changedPx > MAX_NOTE_SCROLL_SPACE_TOLERANCE_PX) {
          const followBottom = measured && isAtNoteBottom(scroller)
          measured = true
          noteScrollSpaceMaxShare = maxShare
          if (followBottom) void scrollNoteToBottomAfterLayout(scroller)
        }
      }
      noteScrollSpaceControlVisible = noteScrollSpaceAdjustmentActive || isAtNoteBottom(scroller)
    }
    const scheduleVisibilityUpdate = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(updateVisibility)
    }
    const handleScroll = () => {
      noteRestsAtBottom = isAtNoteBottom(scroller)
      scheduleVisibilityUpdate()
    }
    noteRestsAtBottom = isAtNoteBottom(scroller)
    const resizeObserver = new ResizeObserver(() => {
      remeasure = true
      scheduleVisibilityUpdate()
    })

    scrollEventTarget.addEventListener('scroll', handleScroll, { passive: true })
    const handleResize = () => {
      remeasure = true
      scheduleVisibilityUpdate()
    }
    window.addEventListener('resize', handleResize)
    resizeObserver.observe(scroller)
    resizeObserver.observe(node)
    if (noteEditorHostElement) resizeObserver.observe(noteEditorHostElement)
    scheduleVisibilityUpdate()

    return {
      destroy() {
        scrollEventTarget.removeEventListener('scroll', handleScroll)
        resizeObserver.disconnect()
        window.removeEventListener('resize', handleResize)
        if (frame !== null) window.cancelAnimationFrame(frame)
        noteScrollSpaceControlVisible = false
      },
    }
  }

  function cancelNoteBottomFollow() {
    bottomFollowRequest += 1
    if (bottomFollowFrame !== null) window.cancelAnimationFrame(bottomFollowFrame)
    bottomFollowFrame = null
  }

  async function scrollNoteToBottomAfterLayout(scroller: HTMLElement) {
    const request = ++bottomFollowRequest
    await tick()
    if (request !== bottomFollowRequest || !scroller.isConnected) return

    if (bottomFollowFrame !== null) window.cancelAnimationFrame(bottomFollowFrame)
    bottomFollowFrame = window.requestAnimationFrame(() => {
      if (request !== bottomFollowRequest || !scroller.isConnected) return
      bottomFollowFrame = null
      scroller.scrollTop = scroller.scrollHeight
    })
  }

  // Writing on the last line keeps the bottom in view, but only when the note
  // was already scrolled there; a reader who scrolled up stays put.
  function handleNoteSelectionChange() {
    if (!noteRestsAtBottom) {
      cancelNoteBottomFollow()
      return
    }
    const selection = document.getSelection()
    const inputs = noteEditorHostElement?.querySelectorAll<HTMLDivElement>('.note-text')
    const lastInput = inputs?.[inputs.length - 1]
    if (!selection?.isCollapsed || !selection.focusNode || !lastInput?.contains(selection.focusNode)
      || !caretIsOnLastVisualLine(lastInput, selection.getRangeAt(0))) {
      cancelNoteBottomFollow()
      return
    }
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
    const lineHeight = (Number.parseFloat(getComputedStyle(input).lineHeight) || 20) * (input.currentCSSZoom || 1)
    return caretRect.bottom > lastLineTop && caretRect.top < lastLineTop + lineHeight
  }

  function normalizeNoteScrollSpacePercent(value: number) {
    return Number.isFinite(value)
      ? Math.max(0, Math.min(100, Math.round(value)))
      : DEFAULT_NOTE_SCROLL_SPACE_PERCENT
  }

  function noteScrollSpaceShareForPercent(percent: number, maxShare: number) {
    if (percent <= DEFAULT_NOTE_SCROLL_SPACE_PERCENT) {
      return MIN_NOTE_SCROLL_SPACE_SHARE
        + (DEFAULT_NOTE_SCROLL_SPACE_SHARE - MIN_NOTE_SCROLL_SPACE_SHARE) * percent / DEFAULT_NOTE_SCROLL_SPACE_PERCENT
    }

    return DEFAULT_NOTE_SCROLL_SPACE_SHARE
      + (maxShare - DEFAULT_NOTE_SCROLL_SPACE_SHARE)
        * (percent - DEFAULT_NOTE_SCROLL_SPACE_PERCENT) / (100 - DEFAULT_NOTE_SCROLL_SPACE_PERCENT)
  }

  // The largest space that still leaves the last lines readable below the
  // sticky toolbar once scrolled to the bottom. Measured from the live layout,
  // so it holds across window sizes, IMAX, and the Notes zoom.
  function measureMaxNoteScrollSpaceShare(scroller: HTMLElement, space: HTMLElement) {
    const texts = noteEditorHostElement?.querySelectorAll<HTMLElement>('.note-text')
    const lastText = texts?.[texts.length - 1]
    const scrollerRect = scroller.getBoundingClientRect()
    if (!scroller.clientHeight || !scroller.offsetHeight || !lastText) return noteScrollSpaceMaxShare

    // Work in screen pixels: the Notes zoom scales rects but not scroll metrics.
    const zoom = scrollerRect.height / scroller.offsetHeight
    const viewport = scroller.clientHeight * zoom
    const lineHeight = (Number.parseFloat(getComputedStyle(lastText).lineHeight) || 26) * zoom
    const spaceRect = space.getBoundingClientRect()
    const contentBottom = scrollerRect.top + (scroller.clientTop + scroller.scrollHeight - scroller.scrollTop) * zoom
    // Row padding below the last line and the page padding below the space
    // stay in view at the bottom alongside the space itself.
    const lastLine = document.createRange()
    lastLine.selectNodeContents(lastText)
    const lineBottoms = Array.from(lastLine.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).map((rect) => rect.bottom)
    const lastLineBottom = lineBottoms.length > 0 ? Math.max(...lineBottoms) : lastText.getBoundingClientRect().bottom
    const surrounding = (spaceRect.top - lastLineBottom) + (contentBottom - spaceRect.bottom)
    const toolbar = scroller.querySelector<HTMLElement>('[data-note-editor-toolbar], .note-format-toolbar')
    const toolbarReach = toolbar && getComputedStyle(toolbar).position === 'sticky'
      ? toolbar.getBoundingClientRect().height + (Number.parseFloat(getComputedStyle(toolbar).top) || 0)
      : 0
    const maxSpace = viewport - toolbarReach - MAX_NOTE_SCROLL_SPACE_VISIBLE_LINES * lineHeight - surrounding
    // Rounded so subpixel layout changes cannot keep resizing the space.
    return Math.round(Math.max(DEFAULT_NOTE_SCROLL_SPACE_SHARE, Math.min(95, maxSpace / viewport * 100)) * 10) / 10
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

  onMount(() => {
    const mobile = window.matchMedia('(max-width: 760px)')
    const closeOnMobile = () => { if (mobile.matches) sideNoteId = null }
    mobile.addEventListener('change', closeOnMobile)
    closeOnMobile()
    const storedPercent = localStorage.getItem(NOTE_SCROLL_SPACE_PERCENT_KEY)
    noteScrollSpacePercent = storedPercent === null
      ? DEFAULT_NOTE_SCROLL_SPACE_PERCENT
      : normalizeNoteScrollSpacePercent(Number(storedPercent))
    return () => mobile.removeEventListener('change', closeOnMobile)
  })

  export function rememberBeforeLeaving() {
    noteEditorHost?.rememberBeforeLeaving()
    sidePanel?.rememberBeforeLeaving()
  }

  onDestroy(() => {
    cancelNoteBottomFollow()
    noteScrollSpaceAdjustmentActive = false
  })
</script>

<svelte:document on:selectionchange={handleNoteSelectionChange} />
<svelte:window
  on:pointerup={finishNoteScrollSpaceAdjustment}
  on:pointercancel={finishNoteScrollSpaceAdjustment}
/>

<div class="notes-workspace" class:notes-split={Boolean(sideNote)} class:notes-side-pane={sidePane}>
  {#if !sidePane}
    <aside class="notes-sidebar" class:notes-trash-open={trashOpen} aria-label="Notes">
      {#if trashOpen}
        <div class="notes-sidebar-head">
          <h3>Bin</h3>
          {#if trashedNotes.length > 0}<button class="ghost danger note-empty-trash" type="button" aria-label="Empty Bin" on:click={emptyTrash}>Empty</button>{/if}
        </div>
      {/if}
      <div class="notes-filter-row">
        {#if !trashOpen}
          <button
            class="note-new"
            type="button"
            title={`New note (${newNoteShortcutLabel})`}
            aria-keyshortcuts="Control+N Meta+N"
            on:click={createNote}
          >
            <span>New</span><kbd class="note-new-shortcut" aria-hidden="true">{newNoteShortcutLabel}</kbd>
          </button>
        {/if}
        <input class="notes-filter" type="search" bind:value={filter} placeholder={trashOpen ? 'Filter Bin' : 'Filter notes'} aria-label={trashOpen ? 'Filter Bin' : 'Filter notes'} />
      </div>
      <div class="notes-list">
        {#each filteredCards as versions (noteVersionGroupId(versions[0]) + (trashOpen ? `:${versions[0].id}` : ''))}
          {@const note = trashOpen ? versions[0] : cardNote(versions, selectedNote)}
          {@const versionLabel = trashOpen ? binnedVersionLabel(note) : ''}
          {@const updatedAt = trashOpen ? note.deletedAt ?? note.updatedAt : latestUpdate(versions)}
          <div class="note-card-row">
            <button type="button" class="note-card" class:active={note.id === selectedNote?.id} on:click={() => onSelect(note.id)}>
              <strong>{note.title.trim() || 'Untitled note'}{#if versionLabel}<small class="note-card-version"> · {versionLabel}</small>{/if}</strong>
              <span>{flattenText(note).trim().replace(/\s+/g, ' ').slice(0, 90) || 'Empty note'}</span>
              {#if versions.length > 1}<small class="note-card-versions">{versions.length} versions</small>{/if}
              <time datetime={updatedAt}>{readableDate(updatedAt)}</time>
            </button>
            {#if !trashOpen}
              <button
                type="button"
                class="note-open-beside"
                aria-label={`Open ${note.title.trim() || 'Untitled note'} on the right`}
                title="Open on the right"
                on:click={() => openBeside(note.id)}
              ><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16M15 9l3 3-3 3M14 12h4" /></svg></button>
            {/if}
          </div>
        {/each}
        {#if visibleNotes.length > 0 && filteredCards.length === 0}<p class="notes-no-match">No matching notes.</p>{/if}
      </div>
      {#if trashOpen}<button class="notes-back-link" type="button" on:click={showNotes}><span aria-hidden="true">←</span> Back to Notes</button>{/if}
    </aside>
  {/if}

  <section bind:this={documentElement} class="note-document" aria-label={sidePane ? 'Right note' : 'Main note'} use:externalNotePaste={`${selectedNoteId}:${trashOpen}`}>
    {#if selectedNote}
      <header class="note-document-head">
        {#if sidePane}
          <button class="note-side-close" type="button" aria-label="Close right note" title="Close" on:click={onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
        {/if}
        {#if trashOpen}
          <h1 class="note-title note-trashed-title">{selectedNote.title.trim() || 'Untitled note'}</h1>
        {:else}
          <textarea bind:this={titleElement} id={sidePane ? 'note-side-title' : 'note-title'} class="note-title" rows="1" value={selectedNote.title} use:autoSizeTitle={selectedNote.title} placeholder="Untitled note" aria-label="Note title" on:input={(event) => onRename(selectedNote!.id, event.currentTarget.value)} on:keydown={handleTitleKeydown}></textarea>
        {/if}
        <div class="note-actions">
          {#if trashOpen}
            <button class="primary" type="button" on:click={() => restoreFromTrash(selectedNote!.id)}>Restore</button>
            <button class="ghost danger" type="button" on:click={() => permanentlyDelete(selectedNote!.id)}>Delete now</button>
          {:else}
            <button type="button" title="Start another version from a copy of this one" on:click={addVersion}>New version</button>
            <button type="button" title="Copy an app link to this note" aria-live="polite" on:click={copyLink}>{copyButtonText}</button>
            <button class="ghost danger" type="button" title={selectedVersions.length > 1 ? 'Move every version of this note to the Bin' : undefined} on:click={() => moveToTrash(selectedNote!.id)}>Bin it</button>
          {/if}
        </div>
        <span class="note-word-count" title="Words in the note body">{wordCount.toLocaleString()} {wordCount === 1 ? 'word' : 'words'}</span>
      </header>

      {#if !trashOpen && selectedVersions.length > 1}
        <div class="note-version-tabs" role="tablist" aria-label="Versions">
          {#each selectedVersions as version, index (version.id)}
            {@const label = noteVersionLabel(version, selectedVersions)}
            <div class="note-version-tab" class:active={version.id === selectedNote.id}>
              {#if renamingVersionId === version.id}
                <input
                  class="note-version-name"
                  bind:value={versionNameDraft}
                  aria-label="Version name"
                  use:selectVersionInput
                  on:keydown={handleVersionNameKeydown}
                  on:blur={() => finishRenamingVersion(true)}
                />
              {:else}
                <button
                  type="button"
                  role="tab"
                  aria-selected={version.id === selectedNote.id}
                  tabindex={version.id === selectedNote.id ? 0 : -1}
                  title="Double-click to rename"
                  data-note-version-tab={version.id}
                  on:click={() => onSelect(version.id)}
                  on:dblclick={() => startRenamingVersion(version)}
                  on:keydown={(event) => handleVersionTabKeydown(event, index)}
                >{label}</button>
                <button
                  class="note-version-close"
                  type="button"
                  aria-label={`Bin ${label}`}
                  title={`Move ${label} to the Bin`}
                  on:click={() => trashVersion(version.id)}
                >×</button>
              {/if}
            </div>
          {/each}
          <button class="note-version-add" type="button" aria-label="New version" title="Start another version from a copy of this one" on:click={addVersion}>+</button>
        </div>
      {/if}

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
          <div class="note-blocks note-editor-blocks" bind:this={noteEditorHostElement}>
            <NoteEditorHost
              bind:this={noteEditorHost}
              note={selectedNote}
              {historyRevision}
              store={{ patchNoteItem: patchItem, patchNoteItemsDone: patchItemsDone, replaceNoteItems: replaceItems }}
              {listTemplates}
              {metrics}
              notes={activeNotes}
              {onOpenLink}
              {onAddItem}
              onFocusTitle={focusTitle}
              scrollContainer={noteScrollContainer}
              {viewStatesByNote}
              {onViewStateChange}
            />
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
          <button
            class="primary note-empty-new"
            type="button"
            title={`New note (${newNoteShortcutLabel})`}
            aria-keyshortcuts="Control+N Meta+N"
            on:click={createNote}
          >
            <span>+ New note</span><kbd class="note-new-shortcut" aria-hidden="true">{newNoteShortcutLabel}</kbd>
          </button>
        {/if}
      </div>
    {/if}
    {#if selectedNote && !trashOpen}
      <div
        class="note-scroll-space"
        style={`--note-scroll-space-height: ${noteScrollSpaceHeight}px; --note-scroll-space-progress: ${noteScrollSpacePercent}%`}
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
              aria-valuetext={`${noteScrollSpaceShare.toFixed(1)}% of note area`}
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
  </section>
  {#if !sidePane && sideNote}
    <NotesPanel
      bind:this={sidePanel}
      sidePane
      onClose={closeSidePane}
      {notes}
      selectedNoteId={sideNote.id}
      {listTemplates}
      {metrics}
      {historyRevision}
      {viewStatesByNote}
      {onViewStateChange}
      onSelect={(noteId) => { sideNoteId = noteId }}
      {onCreate}
      {onTrash}
      {onAddVersion}
      {onRenameVersion}
      {onTrashVersion}
      {onRestore}
      {onPermanentlyDelete}
      {onEmptyTrash}
      {onRename}
      {onAddItem}
      {patchItem}
      {patchItemsDone}
      {replaceItems}
      {onOpenLink}
    />
  {/if}
</div>
