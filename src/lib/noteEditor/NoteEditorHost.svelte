<script lang="ts">
  // Owns the Lexical Notes body, toolbar, and persistence adapter. The Notes
  // panel owns the sidebar, title, Bin, and page chrome.
  import { onDestroy, onMount, tick } from 'svelte'
  import { mobileNoteToolbar } from '../mobileNoteToolbar'
  import type { ItemLink } from '../planner'
  import type { Id, ListTemplate, Metric, Note, NoteItemKind, NoteViewState } from '../types'
  import { NoteEditorAdapter, type NoteEditorStore } from './NoteEditorAdapter'
  import type { NoteEditorSelectionState, NoteEditorView, NoteInlineMark } from './types'

  export let note: Note
  export let historyRevision = 0
  export let store: NoteEditorStore
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let notes: Note[] = []
  export let onOpenLink: (link: ItemLink) => void = () => {}
  // Appends an empty root item (used by the "Start writing…" surface).
  export let onAddItem: (noteId: Id, kind?: NoteItemKind) => Id = () => ''
  export let onUndo: () => void = () => {}
  export let onRedo: () => void = () => {}
  // Shift+Tab at the top of the note hands focus back to the title.
  export let onFocusTitle: () => void = () => {}
  // Resolves the element whose scrollTop the view state records (the note
  // document, the workspace, or the page depending on layout).
  export let scrollContainer: () => HTMLElement | null = () => null
  export let viewStatesByNote: ReadonlyMap<Id, NoteViewState> = new Map()
  export let onViewStateChange: (noteId: Id, state: NoteViewState) => void = () => {}

  const isMac = /Mac|iPhone|iPad|iPod/.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '',
  )
  const modifierLabel = isMac ? '⌘' : 'Ctrl+'

  let host: HTMLElement
  let view: NoteEditorView | null = null
  let adapter: NoteEditorAdapter | null = null
  let destroyed = false
  let ready = false
  let selection: NoteEditorSelectionState = {
    activeKind: null,
    marks: { bold: false, italic: false, underline: false },
    multiBlock: false,
  }
  let openedNoteId: Id | null = null
  let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null

  async function createView(): Promise<NoteEditorView> {
    const module = await import('./lexical/LexicalNoteEditor')
    return module.createLexicalNoteEditor()
  }

  // Keep the last known caret when focus leaves the editor.
  function rememberViewState() {
    if (!adapter || !openedNoteId) return
    const previous = viewStatesByNote.get(openedNoteId)
    // Svelte can detach the host before teardown runs. Keep the last mounted
    // scroll position instead of replacing it with the detached pane's zero.
    const scroller = host?.isConnected ? scrollContainer() : null
    const scrollTop = scroller?.isConnected ? scroller.scrollTop : previous?.scrollTop ?? 0
    const state = adapter.viewState(scrollTop)
    onViewStateChange(openedNoteId, { scrollTop: state.scrollTop, caret: state.caret ?? previous?.caret ?? null })
  }

  function handleSelectionChange() {
    if (!host || !openedNoteId) return
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0 || !host.contains(selection.anchorNode)) return
    rememberViewState()
  }

  function scheduleScrollSave() {
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
    scrollSaveTimer = setTimeout(() => {
      scrollSaveTimer = null
      rememberViewState()
    }, 150)
  }

  async function mountEditor() {
    const nextView = await createView()
    if (destroyed || !host) {
      nextView.destroy()
      return
    }
    teardown()
    view = nextView
    adapter = new NoteEditorAdapter({ view: nextView, store })
    nextView.mount({
      host,
      placeholder: 'Start writing…',
      context: { listTemplates, metrics, notes, isMac },
      callbacks: {
        onDocumentChanged: (source) => adapter?.handleDocumentChanged(source),
        onCompositionEnd: () => adapter?.compositionEnded(),
        onSelectionChanged: (state) => {
          selection = state
          rememberViewState()
        },
        onOpenLink,
        onUndo,
        onRedo,
        onExitToTitle: () => onFocusTitle(),
        onBlur: () => {
          adapter?.flush()
          rememberViewState()
        },
        onFocus: () => {},
      },
    })
    ready = true
    openedNoteId = null
    syncNote()
  }

  function teardown() {
    if (adapter) {
      rememberViewState()
      adapter.close()
    }
    view?.destroy()
    view = null
    adapter = null
    ready = false
  }

  // Note switch: open with the remembered caret and scroll. Same note: let the
  // adapter decide whether the store's items differ from what the view shows.
  function syncNote() {
    if (!adapter || !view) return
    if (openedNoteId !== note.id) {
      if (openedNoteId) rememberViewState()
      openedNoteId = note.id
      const remembered = viewStatesByNote.get(note.id) ?? null
      adapter.open(note.id, note.items, historyRevision, remembered?.caret ?? null)
      void tick().then(() => {
        const scroller = scrollContainer()
        if (scroller) scroller.scrollTop = remembered?.scrollTop ?? 0
      })
      return
    }
    adapter.receive(note.id, note.items, historyRevision)
  }

  $: if (ready) {
    // Re-run whenever the note object, its items, or history revision change.
    void note.items
    void historyRevision
    syncNote()
  }

  $: view?.updateContext?.({ listTemplates, metrics, notes, isMac })

  export function focus() {
    view?.focus()
  }

  export function flush() {
    adapter?.flush()
  }

  export function focusItem(itemId: Id, offset = 0) {
    view?.setCaret({ itemId, start: offset, end: offset })
    view?.focus()
  }

  async function startEmptyNote() {
    const itemId = onAddItem(note.id)
    await tick()
    if (itemId) focusItem(itemId, 0)
  }

  // Title handoff: Tab lands at the start of the first block, Enter at the end
  // of the last block (contract P-06). An empty note first gets a paragraph.
  export async function focusEdge(edge: 'start' | 'end') {
    if (note.items.length === 0) {
      await startEmptyNote()
      return
    }
    if (edge === 'start') {
      focusItem(note.items[0].id, 0)
      return
    }
    let last = note.items[note.items.length - 1]
    while (last.children.length > 0) last = last.children[last.children.length - 1]
    focusItem(last.id, Number.MAX_SAFE_INTEGER)
  }

  function applyKind(kind: NoteItemKind) {
    view?.setBlockKind(kind)
    view?.focus()
  }

  function applyMark(mark: NoteInlineMark) {
    view?.toggleMark(mark)
    view?.focus()
  }

  function handleVisibility() {
    if (document.visibilityState === 'hidden') adapter?.flush()
  }

  onMount(() => {
    void mountEditor()
    document.addEventListener('visibilitychange', handleVisibility)
    document.addEventListener('selectionchange', handleSelectionChange)
    window.addEventListener('pagehide', flush)
    // Scroll may happen on the note document, the workspace, or the page.
    document.addEventListener('scroll', scheduleScrollSave, { passive: true, capture: true })
  })

  onDestroy(() => {
    destroyed = true
    document.removeEventListener('visibilitychange', handleVisibility)
    document.removeEventListener('selectionchange', handleSelectionChange)
    window.removeEventListener('pagehide', flush)
    document.removeEventListener('scroll', scheduleScrollSave, { capture: true })
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
    teardown()
  })
</script>

<div use:mobileNoteToolbar class="note-editor-toolbar note-format-toolbar" role="toolbar" aria-label="Note formatting" data-note-editor-toolbar>
  <div class="note-format-group" aria-label="Text style">
    <button type="button" class:active={selection.activeKind === 'paragraph'} aria-label="Text" title="Text" on:mousedown|preventDefault on:click={() => applyKind('paragraph')}>Aa</button>
    <button type="button" class:active={selection.activeKind === 'heading'} aria-label="Heading" title="Heading (# then Space)" on:mousedown|preventDefault on:click={() => applyKind('heading')}>H1</button>
  </div>
  <div class="note-format-group" aria-label="Quotes">
    <button type="button" class:active={selection.activeKind === 'quote'} aria-label="Quote" title="Quote (> then Space)" on:mousedown|preventDefault on:click={() => applyKind('quote')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 11H5V6h5v7a5 5 0 0 1-5 5M20 11h-5V6h5v7a5 5 0 0 1-5 5" /></svg></button>
  </div>
  <div class="note-format-group" aria-label="Lists">
    <button type="button" class:active={selection.activeKind === 'bullet'} aria-label="Bulleted list" title="Bulleted list (- then Space)" on:mousedown|preventDefault on:click={() => applyKind('bullet')}>•</button>
    <button type="button" class:active={selection.activeKind === 'numbered'} aria-label="Numbered list" title="Numbered list (1. then Space)" on:mousedown|preventDefault on:click={() => applyKind('numbered')}>1.</button>
    <button type="button" class:active={selection.activeKind === 'checklist'} aria-label="Checklist" title="Checklist ([] then Space)" on:mousedown|preventDefault on:click={() => applyKind('checklist')}>✓</button>
  </div>
  <div class="note-format-group" aria-label="Inline formatting">
    <button type="button" class:active={selection.marks.bold} aria-label="Bold" aria-pressed={selection.marks.bold ? 'true' : 'false'} title={`Bold (${modifierLabel}B)`} on:mousedown|preventDefault on:click={() => applyMark('bold')}><strong>B</strong></button>
    <button type="button" class:active={selection.marks.italic} aria-label="Italic" aria-pressed={selection.marks.italic ? 'true' : 'false'} title={`Italic (${modifierLabel}I)`} on:mousedown|preventDefault on:click={() => applyMark('italic')}><em>I</em></button>
    <button type="button" class:active={selection.marks.underline} aria-label="Underline" aria-pressed={selection.marks.underline ? 'true' : 'false'} title={`Underline (${modifierLabel}U)`} on:mousedown|preventDefault on:click={() => applyMark('underline')}><u>U</u></button>
  </div>
  <span class="note-format-hint">Type <kbd><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" role="img" aria-label="Slash"><path d="M8 2 4 10" /></svg></kbd> for more</span>
</div>

{#if note.items.length === 0}
  <button class="note-empty-editor" type="button" on:click={startEmptyNote}>Start writing…</button>
{/if}
<div class="note-editor-host" data-note-editor="lexical" bind:this={host} hidden={note.items.length === 0}></div>
