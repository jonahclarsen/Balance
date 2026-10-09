<script lang="ts">
  import { externalNotePaste } from './externalNotePaste'
  import { onDestroy, onMount, tick } from 'svelte'
  import ReadOnlyNoteItem from './ReadOnlyNoteItem.svelte'
  import NoteEditorHost from './noteEditor/NoteEditorHost.svelte'
  import type { ItemLink } from './planner'
  import { NOTE_TRASH_RETENTION_DAYS, noteTrashDaysRemaining } from './noteTrash'
  import type { Id, ListTemplate, Metric, Note, NoteItemKind, NoteViewState } from './types'

  const NOTE_SCROLL_SPACE_PERCENT_KEY = 'balance:noteScrollSpacePercent'
  const LEGACY_NOTE_SCROLL_SPACE_VH_KEY = 'balance:noteScrollSpaceVh'
  const DEFAULT_NOTE_SCROLL_SPACE_PERCENT = 60
  const MIN_NOTE_SCROLL_SPACE_SHARE = 6
  // The slider scales against the actual note viewport, excluding Goal Rhythm.
  const DEFAULT_NOTE_SCROLL_SPACE_SHARE = 31.2
  const MAX_NOTE_SCROLL_SPACE_SHARE = 49.2
  const isMac = /Mac|iPhone|iPad|iPod/.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '',
  )
  const newNoteShortcutLabel = `${isMac ? '⌘' : 'Ctrl+'}N`

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
  export let patchItemsDone: typeof import('./store').plannerStore.patchNoteItemsDone
  export let replaceItems: typeof import('./store').plannerStore.replaceNoteItems
  export let onOpenLink: (link: ItemLink) => void
  export let trashOpen = false
  export let viewStatesByNote: ReadonlyMap<Id, NoteViewState> = new Map()
  export let onViewStateChange: (noteId: Id, state: NoteViewState) => void = () => {}

  let filter = ''
  let lastActiveNoteId: Id | null = null
  let lastTrashNoteId: Id | null = null
  let copyButtonText = 'Copy note link'
  let copyButtonResetTimer: number | undefined
  let noteEditorHostElement: HTMLDivElement | null = null
  let noteEditorHost: NoteEditorHost | null = null
  let bottomFollowFrame: number | null = null
  let bottomFollowRequest = 0
  let noteScrollSpacePercent = DEFAULT_NOTE_SCROLL_SPACE_PERCENT
  let noteScrollViewportHeight = 0
  let noteScrollSpaceControlVisible = false
  let noteScrollSpaceAdjustmentActive = false
  $: noteScrollSpaceShare = noteScrollSpaceShareForPercent(noteScrollSpacePercent)
  $: noteScrollSpaceHeight = noteScrollViewportHeight * noteScrollSpaceShare / 100
  $: activeNotes = notes.filter((note) => !note.deletedAt)
  $: trashedNotes = notes
    .filter((note) => note.deletedAt)
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
  $: visibleNotes = trashOpen ? trashedNotes : activeNotes
  $: selectedNote = visibleNotes.find((note) => note.id === selectedNoteId) ?? visibleNotes[0] ?? null
  $: if (!trashOpen && selectedNote) lastActiveNoteId = selectedNote.id
  $: if (trashOpen && selectedNote) lastTrashNoteId = selectedNote.id
  $: filteredNotes = [...visibleNotes]
    .filter((note) => `${note.title} ${flattenText(note)}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
    .sort((a, b) => trashOpen
      ? (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '')
      : b.updatedAt.localeCompare(a.updatedAt))

  function flattenText(note: Note): string {
    const visit = (items: Note['items']): string => items.map((item) => `${item.text} ${visit(item.children)}`).join(' ')
    return visit(note.items)
  }

  export function createNote() {
    trashOpen = false
    const id = onCreate()
    onSelect(id)
    void tick().then(() => document.querySelector<HTMLTextAreaElement>('#note-title')?.select())
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
    document.querySelector<HTMLTextAreaElement>('#note-title')?.focus()
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
    const title = document.querySelector<HTMLTextAreaElement>('#note-title')
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
    const scroller = noteScrollContainer()
    if (!scroller) return {}
    noteScrollViewportHeight = scroller.clientHeight

    let frame: number | null = null
    const scrollEventTarget: HTMLElement | Document = scroller === document.scrollingElement ? document : scroller
    const updateVisibility = () => {
      frame = null
      noteScrollViewportHeight = scroller.clientHeight
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
    if (noteEditorHostElement) resizeObserver.observe(noteEditorHostElement)
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

  function followNoteBottomAfterEdit(event: Event) {
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.closest('[data-note-text-input]')) return

    const scroller = noteScrollContainer()
    if (scroller && isAtNoteBottom(scroller)) void scrollNoteToBottomAfterLayout(scroller)
  }

  function handleNoteSelectionChange() {
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

  function noteScrollSpaceShareForPercent(percent: number) {
    if (percent <= DEFAULT_NOTE_SCROLL_SPACE_PERCENT) {
      return MIN_NOTE_SCROLL_SPACE_SHARE
        + (DEFAULT_NOTE_SCROLL_SPACE_SHARE - MIN_NOTE_SCROLL_SPACE_SHARE) * percent / DEFAULT_NOTE_SCROLL_SPACE_PERCENT
    }

    return DEFAULT_NOTE_SCROLL_SPACE_SHARE
      + (MAX_NOTE_SCROLL_SPACE_SHARE - DEFAULT_NOTE_SCROLL_SPACE_SHARE)
        * (percent - DEFAULT_NOTE_SCROLL_SPACE_PERCENT) / (100 - DEFAULT_NOTE_SCROLL_SPACE_PERCENT)
  }

  function noteScrollSpacePercentForLegacyVh(value: number) {
    if (!Number.isFinite(value)) return DEFAULT_NOTE_SCROLL_SPACE_PERCENT
    const clamped = Math.max(MIN_NOTE_SCROLL_SPACE_SHARE, Math.min(MAX_NOTE_SCROLL_SPACE_SHARE, value))
    if (clamped <= DEFAULT_NOTE_SCROLL_SPACE_SHARE) {
      return normalizeNoteScrollSpacePercent(
        (clamped - MIN_NOTE_SCROLL_SPACE_SHARE)
          / (DEFAULT_NOTE_SCROLL_SPACE_SHARE - MIN_NOTE_SCROLL_SPACE_SHARE) * DEFAULT_NOTE_SCROLL_SPACE_PERCENT,
      )
    }

    return normalizeNoteScrollSpacePercent(
      DEFAULT_NOTE_SCROLL_SPACE_PERCENT
        + (clamped - DEFAULT_NOTE_SCROLL_SPACE_SHARE)
          / (MAX_NOTE_SCROLL_SPACE_SHARE - DEFAULT_NOTE_SCROLL_SPACE_SHARE)
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

  onMount(() => {
    const storedPercent = localStorage.getItem(NOTE_SCROLL_SPACE_PERCENT_KEY)
    const legacyVh = localStorage.getItem(LEGACY_NOTE_SCROLL_SPACE_VH_KEY)
    noteScrollSpacePercent = storedPercent === null
      ? legacyVh === null
        ? DEFAULT_NOTE_SCROLL_SPACE_PERCENT
        : noteScrollSpacePercentForLegacyVh(Number(legacyVh))
      : normalizeNoteScrollSpacePercent(Number(storedPercent))
    localStorage.setItem(NOTE_SCROLL_SPACE_PERCENT_KEY, String(noteScrollSpacePercent))
    localStorage.removeItem(LEGACY_NOTE_SCROLL_SPACE_VH_KEY)
  })

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

<div class="notes-workspace">
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

  <section class="note-document" use:externalNotePaste={`${selectedNoteId}:${trashOpen}`}>
    {#if selectedNote}
      <header class="note-document-head">
        {#if trashOpen}
          <h1 class="note-title note-trashed-title">{selectedNote.title.trim() || 'Untitled note'}</h1>
        {:else}
          <textarea id="note-title" class="note-title" rows="1" value={selectedNote.title} use:autoSizeTitle={selectedNote.title} placeholder="Untitled note" aria-label="Note title" on:input={(event) => onRename(selectedNote!.id, event.currentTarget.value)} on:keydown={handleTitleKeydown}></textarea>
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
</div>
