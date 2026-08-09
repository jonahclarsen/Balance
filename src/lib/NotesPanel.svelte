<script lang="ts">
  import { tick } from 'svelte'
  import NoteItemEditor from './NoteItemEditor.svelte'
  import type { ItemLink } from './planner'
  import type { Id, ListTemplate, Metric, Note, NoteItemKind } from './types'

  export let notes: Note[]
  export let selectedNoteId: Id
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let historyRevision = 0
  export let onSelect: (noteId: Id) => void
  export let onCreate: () => Id
  export let onDelete: (noteId: Id) => void | Promise<void>
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

  let filter = ''
  let copyStatus = ''
  let activeItemId: Id | null = null
  let activeNoteId: Id | null = null
  let toolbarSelection: Range | null = null
  $: selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null
  $: if (selectedNoteId !== activeNoteId) {
    activeNoteId = selectedNoteId
    activeItemId = selectedNote?.items[0]?.id ?? null
  }
  $: activeItem = selectedNote && activeItemId ? findItem(selectedNote.items, activeItemId) : null
  $: filteredNotes = [...notes]
    .filter((note) => `${note.title} ${flattenText(note)}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

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
    const id = onCreate()
    onSelect(id)
    void tick().then(() => document.querySelector<HTMLInputElement>('#note-title')?.select())
  }

  async function copyLink() {
    if (!selectedNote) return
    const link = `balance://note/${selectedNote.id}`
    try {
      await navigator.clipboard.writeText(link)
      copyStatus = 'Note link copied'
    } catch {
      const fallback = document.createElement('textarea')
      fallback.value = link
      fallback.setAttribute('readonly', '')
      fallback.style.position = 'fixed'
      fallback.style.opacity = '0'
      document.body.append(fallback)
      fallback.select()
      const copied = document.execCommand('copy')
      fallback.remove()
      copyStatus = copied ? 'Note link copied' : `Copy this link: ${link}`
    }
    window.setTimeout(() => (copyStatus = ''), 2500)
  }

  function readableDate(value: string) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(date)
  }

  async function applyBlockKind(kind: NoteItemKind) {
    if (!selectedNote) return
    const itemId = activeItemId ?? selectedNote.items[0]?.id
    if (!itemId) return
    activeItemId = itemId
    patchItem(selectedNote.id, itemId, { kind, done: kind === 'checklist' ? (activeItem?.done ?? false) : false })
    await tick()
    focusActiveEditor()
  }

  function applyInlineFormat(command: 'bold' | 'italic' | 'underline') {
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
    if (savedRange && !savedRange.collapsed) {
      const wrapper = document.createElement(command === 'bold' ? 'strong' : command === 'italic' ? 'em' : 'u')
      wrapper.append(savedRange.extractContents())
      savedRange.insertNode(wrapper)
      selection?.selectAllChildren(wrapper)
    } else {
      document.execCommand(command)
    }
    toolbarSelection = null
    const inputType = command === 'bold' ? 'formatBold' : command === 'italic' ? 'formatItalic' : 'formatUnderline'
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }))
  }

  function rememberToolbarSelection() {
    const editor = activeEditor()
    const selection = document.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    toolbarSelection = editor && range && editor.contains(range.commonAncestorContainer) ? range.cloneRange() : null
  }

  async function addLine() {
    if (!selectedNote) return
    const itemId = onAddItem(selectedNote.id)
    activeItemId = itemId
    await tick()
    focusActiveEditor()
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
</script>

<div class="notes-workspace">
  <aside class="notes-sidebar" aria-label="Notes">
    <div class="notes-sidebar-head">
      <h3>Notes</h3>
      <button class="primary note-new" type="button" on:click={createAndSelect}>+ New</button>
    </div>
    <input class="notes-filter" type="search" bind:value={filter} placeholder="Filter notes" aria-label="Filter notes" />
    <div class="notes-list">
      {#each filteredNotes as note (note.id)}
        <button type="button" class="note-card" class:active={note.id === selectedNoteId} on:click={() => onSelect(note.id)}>
          <strong>{note.title.trim() || 'Untitled note'}</strong>
          <span>{flattenText(note).trim().replace(/\s+/g, ' ').slice(0, 90) || 'Empty note'}</span>
          <time datetime={note.updatedAt}>{readableDate(note.updatedAt)}</time>
        </button>
      {/each}
      {#if notes.length > 0 && filteredNotes.length === 0}<p class="notes-no-match">No matching notes.</p>{/if}
    </div>
  </aside>

  <section class="note-document">
    {#if selectedNote}
      <header class="note-document-head">
        <input id="note-title" class="note-title" value={selectedNote.title} placeholder="Untitled note" aria-label="Note title" on:input={(event) => onRename(selectedNote!.id, event.currentTarget.value)} />
        <div class="note-actions">
          <button type="button" title="Copy an app link to this note" on:click={copyLink}>Copy note link</button>
          <button class="ghost danger" type="button" on:click={() => onDelete(selectedNote!.id)}>Delete</button>
        </div>
        {#if copyStatus}<p class="note-copy-status" aria-live="polite">{copyStatus}</p>{/if}
      </header>

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
          <button type="button" aria-label="Bold" title="Bold (⌘B)" on:mousedown|preventDefault={rememberToolbarSelection} on:click={() => applyInlineFormat('bold')}><strong>B</strong></button>
          <button type="button" aria-label="Italic" title="Italic (⌘I)" on:mousedown|preventDefault={rememberToolbarSelection} on:click={() => applyInlineFormat('italic')}><em>I</em></button>
          <button type="button" aria-label="Underline" title="Underline (⌘U)" on:mousedown|preventDefault={rememberToolbarSelection} on:click={() => applyInlineFormat('underline')}><u>U</u></button>
        </div>
        <span class="note-format-hint">Type <kbd>/</kbd> for more</span>
      </div>

      <div class="note-blocks">
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
            {notes}
            {onOpenLink}
            onFocusItem={(itemId) => (activeItemId = itemId)}
          />
        {/each}
      </div>

      <div class="note-add-row">
        <button class="note-add-line" type="button" on:click={addLine}>+ Add a line</button>
      </div>
    {:else}
      <div class="empty-state note-empty">
        <h3>{notes.length === 0 ? 'Your notes live here' : 'Choose a note'}</h3>
        <p>Keep reference material, lists, and ideas separate from any particular day.</p>
        <button class="primary" type="button" on:click={createAndSelect}>+ New note</button>
      </div>
    {/if}
  </section>
</div>
