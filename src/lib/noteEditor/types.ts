// The contract between the Notes page and a document editor implementation
// (TipTap, Lexical). Implementations are pure view layers: they render a block
// tree, let the user edit it, and report the resulting block tree. Everything
// about persistence — store operations, ids, sanitizing, undo, remote updates,
// caret restore — lives in the shared adapter (NoteEditorAdapter.ts).

import type { ItemLink } from '../planner'
import type { Id, ListTemplate, Metric, Note, NoteItemKind } from '../types'
import type { NoteBlock } from './noteItems'

export type NoteEditorCaret = {
  itemId: Id
  // Offsets in plain-text characters within the block (as `NoteItem.text`
  // counts them: `<br>` is one "\n" character, images count as one char).
  start: number
  end: number
}

export type NoteInlineMark = 'bold' | 'italic' | 'underline'

export type NoteEditorSelectionState = {
  // Kind of the block that contains the caret / selection anchor.
  activeKind: NoteItemKind | null
  marks: Record<NoteInlineMark, boolean>
  // True while the selection spans more than one block.
  multiBlock: boolean
}

// Why the document changed. `paste` and `image` edits become their own undo
// step instead of merging into the surrounding typing (parity with Classic).
export type NoteEditorChangeSource = 'typing' | 'paste' | 'image' | 'command'

export type NoteEditorHostCallbacks = {
  // The document changed because of a user action (typing, command, paste…).
  // The adapter reads `view.readBlocks()` and commits. Implementations call
  // this once per transaction, after the DOM/state is settled. Omitting the
  // source means 'typing'.
  onDocumentChanged: (source?: NoteEditorChangeSource) => void
  // IME composition finished (the adapter applies any deferred remote update).
  onCompositionEnd: () => void
  // Caret / selection moved or formatting state changed (may be called often).
  onSelectionChanged: (state: NoteEditorSelectionState) => void
  // The user activated a link inside the note (click / Cmd+click / Enter).
  onOpenLink: (link: ItemLink) => void
  // The user asked for app-level undo/redo (Cmd/Ctrl+Z, Shift+Cmd+Z, Ctrl+Y).
  // Implementations MUST NOT keep their own history stack; the app's history
  // reverts the store and the adapter reloads the document.
  onUndo: () => void
  onRedo: () => void
  // Shift+Tab in the first block with nothing left to outdent: the host moves
  // focus up into the note title.
  onExitToTitle: () => void
  // Focus left the editor (blur to outside the editor root).
  onBlur: () => void
  onFocus: () => void
}

export type NoteEditorContext = {
  // Resolves app links (`balance://…`) and "[[...]]"-style references the way
  // the rest of the app does. Read-only.
  listTemplates: ListTemplate[]
  metrics: Metric[]
  notes: Note[]
  isMac: boolean
}

export type NoteEditorMountOptions = {
  host: HTMLElement
  callbacks: NoteEditorHostCallbacks
  context: NoteEditorContext
  placeholder: string
}

export interface NoteEditorView {
  readonly name: 'tiptap' | 'lexical'

  mount(options: NoteEditorMountOptions): void
  destroy(): void

  // Replace the entire document without emitting `onDocumentChanged`. Used on
  // note switch, after undo/redo, and for remote updates. When `caret` is
  // given, restore it (clamped to the block's text length) after loading.
  load(blocks: NoteBlock[], caret: NoteEditorCaret | null): void

  // Serialize the current document. Block `id`s must be the ids the blocks were
  // loaded with; blocks the user created report `id: null` until the adapter
  // calls `adoptIds`. Inline `html` must only use the allowlisted subset:
  // <strong>, <em>, <u>, <br>, <a href [target rel]>, <img data-balance-image…>.
  readBlocks(): NoteBlock[]

  // Give stable ids to blocks created by the user. `blocks` are the exact
  // objects returned from the last `readBlocks()` call. Must not emit
  // `onDocumentChanged` and must not add an undo step.
  adoptIds(assignments: Array<{ block: NoteBlock; id: Id }>): void

  getCaret(): NoteEditorCaret | null
  setCaret(caret: NoteEditorCaret): void
  focus(): void
  blur(): void
  hasFocus(): boolean
  // True while an IME composition is in progress; the adapter defers reloads.
  isComposing(): boolean

  // Commands driven by the shared toolbar / host shortcuts.
  setBlockKind(kind: NoteItemKind): void
  toggleMark(mark: NoteInlineMark): void
  toggleChecked(): void
  indent(): void
  outdent(): void
  moveBlock(direction: 'up' | 'down'): void
  selectAll(): void
  getSelectionState(): NoteEditorSelectionState

  // Optional: update context (lists/metrics/notes) without reloading.
  updateContext?(context: NoteEditorContext): void
}

export type NoteEditorFactory = () => NoteEditorView
