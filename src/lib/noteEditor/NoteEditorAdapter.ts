// Owns ALL persistence for the Notes editor (Lexical):
//   - loads a note's items into the view and reloads on note switch,
//     undo/redo (historyRevision) and remote/sync updates without losing the
//     caret,
//   - turns each view change into the narrowest store operation: typing → a
//     merging text patch, checkbox → done patch, everything else → a
//     structural replace whose replicated form is still per-item,
//   - assigns stable ids to new blocks, preserves unknown fields on existing
//     items, sanitizes inline HTML,
//   - remembers per-note view state (scroll + caret) for the host.
// The view implementations never talk to the store.

import type { Id, NoteItem, NoteViewState } from '../types'
import {
  classifyNoteItemsDiff,
  materializeNoteBlocks,
  noteBlocksFromItems,
  noteItemById,
  noteItemCaretLength,
  noteItemsEqual,
} from './noteItems'
import type { NoteEditorCaret, NoteEditorChangeSource, NoteEditorView } from './types'

export type NoteEditorStore = {
  patchNoteItem: (noteId: Id, itemId: Id, patch: Partial<NoteItem>, options?: { mergeHistory?: boolean }) => void
  patchNoteItemsDone: (noteId: Id, itemIds: Id[], done: boolean) => void
  replaceNoteItems: (noteId: Id, items: NoteItem[], summary?: string) => void
}

export type NoteEditorAdapterOptions = {
  view: NoteEditorView
  store: NoteEditorStore
  // Called after every successful commit with the items now in the store.
  onCommitted?: (noteId: Id, items: NoteItem[]) => void
}

export class NoteEditorAdapter {
  private readonly view: NoteEditorView
  private readonly store: NoteEditorStore
  private readonly onCommitted?: (noteId: Id, items: NoteItem[]) => void

  private noteId: Id | null = null
  // The items the view currently reflects. After a commit this is the exact
  // tree we handed the store, so a store echo of our own edit is recognised by
  // structural equality and never triggers a reload.
  private items: NoteItem[] = []
  private historyRevision = 0
  private applying = false
  private pendingRemote: { items: NoteItem[]; historyRevision: number } | null = null

  constructor(options: NoteEditorAdapterOptions) {
    this.view = options.view
    this.store = options.store
    this.onCommitted = options.onCommitted
  }

  get currentNoteId(): Id | null {
    return this.noteId
  }

  get currentItems(): NoteItem[] {
    return this.items
  }

  // Show a (possibly different) note. Always reloads the view.
  open(noteId: Id, items: NoteItem[], historyRevision: number, caret: NoteEditorCaret | null): void {
    this.noteId = noteId
    this.items = items
    this.historyRevision = historyRevision
    this.pendingRemote = null
    this.loadIntoView(items, caret)
  }

  close(): void {
    this.flush()
    this.noteId = null
    this.items = []
    this.pendingRemote = null
  }

  // The store published new items for the open note (our own echo, a remote
  // update, or undo/redo). Reload only when something we do not already show
  // changed, keeping the caret where it was.
  receive(noteId: Id, items: NoteItem[], historyRevision: number): void {
    if (noteId !== this.noteId) return
    const historyChanged = historyRevision !== this.historyRevision
    this.historyRevision = historyRevision
    if (!historyChanged && noteItemsEqual(items, this.items)) {
      // Same content; adopt the store's objects so later reference checks and
      // unknown-field preservation use the canonical records.
      this.items = items
      return
    }
    if (this.view.isComposing()) {
      this.pendingRemote = { items, historyRevision }
      return
    }
    this.items = items
    this.loadIntoView(items, this.preservedCaretFor(items))
  }

  // Apply a deferred remote update once IME composition finished.
  compositionEnded(): void {
    if (!this.pendingRemote) return
    const { items, historyRevision } = this.pendingRemote
    this.pendingRemote = null
    this.receive(this.noteId as Id, items, historyRevision)
  }

  // The view reports a user edit. Synchronous: the store already coalesces
  // typing for undo and debounces persistence, so nothing is left unsaved.
  handleDocumentChanged(source: NoteEditorChangeSource = 'typing'): void {
    if (this.applying || !this.noteId) return
    this.commit(source)
  }

  // Nothing is buffered, but hosts call this on blur/close/tab switch so any
  // in-flight composition text is captured.
  flush(): void {
    if (!this.noteId || this.applying) return
    this.commit('flush')
  }

  viewState(scrollTop: number): NoteViewState {
    const caret = this.view.getCaret()
    return { scrollTop, caret: caret ? { itemId: caret.itemId, start: caret.start, end: caret.end } : null }
  }

  private commit(source: NoteEditorChangeSource | 'flush'): void {
    const summary = source
    const noteId = this.noteId as Id
    const blocks = this.view.readBlocks()
    const { items, assignments } = materializeNoteBlocks(blocks, this.items)
    if (assignments.length > 0) {
      this.applying = true
      try {
        this.view.adoptIds(assignments)
      } finally {
        this.applying = false
      }
    }
    const diff = classifyNoteItemsDiff(this.items, items)
    if (diff.kind === 'none') {
      this.items = items
      return
    }
    this.items = items
    switch (diff.kind) {
      case 'text': {
        const item = noteItemById(items).get(diff.itemId)
        if (item) {
          this.store.patchNoteItem(noteId, diff.itemId, { text: item.text, html: item.html },
            source === 'paste' || source === 'image' || source === 'quote' ? { mergeHistory: false } : {})
        } else this.store.replaceNoteItems(noteId, items, summary)
        break
      }
      case 'done': {
        // The store cascades `done` down from every id it is given and then
        // reconciles ancestors. If the view already applied that cascade, the
        // changed set includes reconciled ancestors; passing those would push
        // the value down onto unrelated siblings. Send only the changed items
        // with no changed descendant: ancestors re-derive the same value.
        const changed = new Set(diff.itemIds)
        const byId = noteItemById(items)
        const hasChangedDescendant = (item: { children: NoteItem[] }): boolean =>
          item.children.some((child) => changed.has(child.id) || hasChangedDescendant(child))
        const ids = diff.itemIds.filter((id) => {
          const item = byId.get(id)
          return !item || !hasChangedDescendant(item)
        })
        this.store.patchNoteItemsDone(noteId, ids, diff.done)
        break
      }
      default:
        this.store.replaceNoteItems(noteId, items, summary)
    }
    this.onCommitted?.(noteId, this.items)
  }

  private loadIntoView(items: NoteItem[], caret: NoteEditorCaret | null): void {
    this.applying = true
    try {
      this.view.load(noteBlocksFromItems(items), caret ? clampCaret(caret, items) : null)
    } finally {
      this.applying = false
    }
  }

  private preservedCaretFor(items: NoteItem[]): NoteEditorCaret | null {
    const caret = this.view.getCaret()
    if (!caret) return null
    return clampCaret(caret, items)
  }
}

export function clampCaret(caret: NoteEditorCaret, items: NoteItem[]): NoteEditorCaret | null {
  const item = noteItemById(items).get(caret.itemId)
  if (!item) return null
  const length = noteItemCaretLength(item)
  const start = Math.max(0, Math.min(length, caret.start))
  const end = Math.max(start, Math.min(length, caret.end))
  return { itemId: caret.itemId, start, end }
}
