// Option A: the TipTap (ProseMirror) Notes editor.
//
// One contenteditable holds the whole note. Blocks are generic `noteBlock`
// nodes (see schema.ts) nested exactly like NoteItem.children. Native editing
// handles typing inside a block; every structural key (Enter, Backspace and
// Delete at block edges, Tab, Alt+Arrow, range replacement, paste) is done on
// a mirror of the block tree with the store's semantics (tree.ts) and written
// back as a single transaction. The shared adapter owns persistence: this view
// only reports `onDocumentChanged` once per user transaction.

import { Editor, Extension } from '@tiptap/core'
import { toggleMark as pmToggleMark } from '@tiptap/pm/commands'
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { openExternalURL } from '../../externalLinks'
import { imageEditing } from '../../imageEditing'
import { IMAGE_CLIPBOARD_TYPE } from '../../imageMarkup'
import { imageClipboardHTML } from '../../imageService'
import {
  escapeHTML,
  isURL,
  itemLinkFromAnchor,
  linkifyExternalURLs,
  linkifyItemText,
  sanitizeInlineHTML,
  internalLinkId,
  type ItemTextSegment,
} from '../../planner'
import type { Id, NoteItemKind } from '../../types'
import type { NoteBlock } from '../noteItems'
import type {
  NoteEditorCaret,
  NoteEditorChangeSource,
  NoteEditorContext,
  NoteEditorHostCallbacks,
  NoteEditorMountOptions,
  NoteEditorSelectionState,
  NoteEditorView,
  NoteInlineMark,
} from '../types'
import { clipboardHTML, clipboardPlainText, parseNoteClipboard, type ClipboardBlock, type ParsedClipboardItem } from './clipboard'
import { isInternalHref, noteSchemaExtensions } from './schema'
import { filterSlashCommands, SlashMenu, type SlashCommand } from './slashMenu'
import {
  blocksToFragment,
  buildFragment,
  caretLength,
  deletePreservingChildren,
  docToTree,
  findBlockByPos,
  flattenTree,
  hasImage,
  indentBlock,
  insertAfter,
  insertBefore,
  isContentEmpty,
  LIST_KINDS,
  locate,
  mergeIntoPrevious,
  moveWithinLevel,
  newBlock,
  offsetToPos,
  outdentBlock,
  parseInline,
  plainText,
  posToOffset,
  readDocBlocks,
  reconcileChecklists,
  removeBlock,
  serializeInline,
  type WBlock,
} from './tree'
import './tiptapNoteEditor.css'

const SOURCE = 'balanceNoteSource'
const LOAD = 'balanceNoteLoad'
const ADOPT = 'balanceNoteAdopt'
const CONTEXT = 'balanceNoteContext'
const rowKey = new PluginKey<{ forced: boolean }>('balanceNoteRows')

type BlockInfo = {
  node: PMNode
  pos: number
  line: PMNode
  lineStart: number
  depth: number
}

type ListedBlock = BlockInfo & { number: number | null }

type Focus = { block: WBlock; offset: number | 'end' }

const AUTOFORMAT_RULES: Array<{ pattern: RegExp; kind: NoteItemKind }> = [
  { pattern: /^(#\s)/, kind: 'heading' },
  { pattern: /^(>\s)/, kind: 'quote' },
  { pattern: /^([-*]\s)/, kind: 'bullet' },
  { pattern: /^([1-9]\d*\.\s)/, kind: 'numbered' },
  { pattern: /^(\[\s?\]\s)/, kind: 'checklist' },
]

function blockInfoAt(doc: PMNode, pos: number): BlockInfo | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size))
  let $pos = doc.resolve(clamped)
  let lineDepth = -1
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'noteLine') {
      lineDepth = depth
      break
    }
  }
  if (lineDepth < 0) {
    const near = Selection.findFrom($pos, 1, true) ?? Selection.findFrom($pos, -1, true)
    if (!near) return null
    $pos = near.$head
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      if ($pos.node(depth).type.name === 'noteLine') {
        lineDepth = depth
        break
      }
    }
    if (lineDepth < 0) return null
  }
  return {
    node: $pos.node(lineDepth - 1),
    pos: $pos.before(lineDepth - 1),
    line: $pos.node(lineDepth),
    lineStart: $pos.start(lineDepth),
    depth: lineDepth - 2,
  }
}

function listBlocks(doc: PMNode): ListedBlock[] {
  const out: ListedBlock[] = []
  const walk = (parent: PMNode, start: number, skipFirst: boolean, depth: number) => {
    let run = 0
    parent.forEach((child, offset, index) => {
      if (skipFirst && index === 0) return
      const pos = start + offset
      run = child.attrs.kind === 'numbered' ? run + 1 : 0
      out.push({ node: child, pos, line: child.firstChild!, lineStart: pos + 2, depth, number: child.attrs.kind === 'numbered' ? run : null })
      walk(child, pos + 1, true, depth + 1)
    })
  }
  walk(doc, 0, false, 0)
  return out
}

function textOffsetToPos(content: Fragment, contentStart: number, offset: number): number {
  let remaining = offset
  let pos = contentStart
  let result = -1
  content.forEach((node) => {
    if (result >= 0) return
    if (node.isText) {
      const length = node.text!.length
      if (remaining < length || (remaining === length)) {
        result = pos + remaining
        return
      }
      remaining -= length
    }
    pos += node.nodeSize
  })
  return result >= 0 ? result : contentStart + content.size
}

function lineTextWithBreaks(content: Fragment): string {
  let text = ''
  content.forEach((node) => {
    if (node.isText) text += node.text
    else if (node.type.name === 'hardBreak') text += '\n'
  })
  return text
}

function sameContext(a: NoteEditorContext | null, b: NoteEditorContext): boolean {
  return !!a && a.listTemplates === b.listTemplates && a.metrics === b.metrics && a.notes === b.notes
}

class TipTapNoteEditor implements NoteEditorView {
  readonly name = 'tiptap' as const

  private editor: Editor | null = null
  private wrapper: HTMLDivElement | null = null
  private callbacks: NoteEditorHostCallbacks | null = null
  private context: NoteEditorContext | null = null
  private contextVersion = 0
  private slash: SlashMenu | null = null
  private slashDismissed: string | null = null
  private slashBlurTimer: ReturnType<typeof setTimeout> | null = null
  private imageAction: { destroy(): void } | null = null
  private lastRead: { doc: PMNode; positions: Map<NoteBlock, number> } | null = null
  private pendingComposition = false
  private pendingImage = false
  private pointerDown: { x: number; y: number } | null = null
  private linkCache = new WeakMap<Fragment, { version: number; segments: ItemTextSegment[] }>()
  private structureCache: { doc: PMNode; version: number; set: DecorationSet } | null = null
  private readonly cleanups: Array<() => void> = []

  private get view(): EditorView {
    return this.editor!.view
  }

  private get schema(): Schema {
    return this.editor!.schema
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  mount(options: NoteEditorMountOptions) {
    this.callbacks = options.callbacks
    this.context = options.context
    this.wrapper = document.createElement('div')
    this.wrapper.className = 'tt-note-editor'
    options.host.append(this.wrapper)

    const behavior = Extension.create({
      name: 'balanceNoteBehavior',
      priority: 1000,
      addProseMirrorPlugins: () => [this.behaviorPlugin(), this.structurePlugin(), this.selectionPlugin()],
    })

    this.editor = new Editor({
      element: this.wrapper,
      extensions: noteSchemaExtensions(behavior),
      content: { type: 'doc', content: [] },
      injectCSS: false,
      enableInputRules: false,
      enablePasteRules: false,
      enableCoreExtensions: { keymap: false, delete: false, textDirection: false },
      editorProps: {
        attributes: {
          class: 'tt-note-root',
          'data-rich-text-input': '',
          'data-note-text-input': '',
          'aria-label': 'Note text',
          'aria-multiline': 'true',
          role: 'textbox',
          spellcheck: 'true',
        },
      },
    })
    this.editor.on('transaction', ({ transaction }) => this.afterTransaction(transaction))

    const root = this.view.dom as HTMLElement
    const onBalancePaste = (event: Event) => this.handleBalancePaste(event as CustomEvent<{ plainText?: string | null; html?: string | null }>)
    const onBalanceFormat = (event: Event) => {
      const command = (event as CustomEvent<{ command?: string }>).detail?.command
      if (command === 'bold' || command === 'italic' || command === 'underline') this.toggleMark(command)
    }
    root.addEventListener('balancepaste', onBalancePaste)
    root.addEventListener('balanceformat', onBalanceFormat)
    this.cleanups.push(() => {
      root.removeEventListener('balancepaste', onBalancePaste)
      root.removeEventListener('balanceformat', onBalanceFormat)
    })
    this.imageAction = imageEditing(root, () => this.imageCommitted())
    this.slash = new SlashMenu(this.wrapper, (command) => this.applySlash(command))
  }

  destroy() {
    if (this.slashBlurTimer) clearTimeout(this.slashBlurTimer)
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.imageAction?.destroy()
    this.imageAction = null
    this.slash?.destroy()
    this.slash = null
    this.editor?.destroy()
    this.editor = null
    this.wrapper?.remove()
    this.wrapper = null
    this.callbacks = null
  }

  updateContext(context: NoteEditorContext) {
    if (sameContext(this.context, context)) return
    this.context = context
    this.contextVersion += 1
    if (this.editor) this.view.dispatch(this.view.state.tr.setMeta(CONTEXT, true))
  }

  // ---------------------------------------------------------------------------
  // Document in / out
  // ---------------------------------------------------------------------------

  load(blocks: NoteBlock[], caret: NoteEditorCaret | null) {
    if (!this.editor) return
    const state = this.view.state
    const fragment = blocksToFragment(this.schema, blocks)
    const tr = state.tr.replaceWith(0, state.doc.content.size, fragment)
    tr.setMeta(LOAD, true).setMeta('addToHistory', false)
    const target = caret ? this.selectionForCaret(tr.doc, caret) : null
    tr.setSelection(target ?? Selection.atStart(tr.doc))
    const hadFocus = this.view.hasFocus()
    this.view.dispatch(tr)
    if (target) this.focusProgrammatically()
    else if (hadFocus && caret === null && blocks.length === 0) (this.view.dom as HTMLElement).blur()
  }

  readBlocks(): NoteBlock[] {
    if (!this.editor) return []
    const doc = this.view.state.doc
    const { blocks, positions } = readDocBlocks(doc)
    this.lastRead = { doc, positions }
    return blocks
  }

  adoptIds(assignments: Array<{ block: NoteBlock; id: Id }>) {
    if (!this.editor || !this.lastRead || this.lastRead.doc !== this.view.state.doc) return
    const tr = this.view.state.tr
    for (const { block, id } of assignments) {
      const pos = this.lastRead.positions.get(block)
      if (pos === undefined) continue
      tr.setNodeAttribute(pos, 'id', id)
      block.id = id
    }
    if (!tr.docChanged) return
    tr.setMeta(ADOPT, true).setMeta('addToHistory', false)
    this.view.dispatch(tr)
  }

  getCaret(): NoteEditorCaret | null {
    if (!this.editor || !this.view.hasFocus()) return null
    const { selection, doc } = this.view.state
    const head = blockInfoAt(doc, selection.head)
    if (!head || !head.node.attrs.id) return null
    const from = blockInfoAt(doc, selection.from)
    const to = blockInfoAt(doc, selection.to)
    if (from && to && from.pos === head.pos && to.pos === head.pos) {
      return {
        itemId: head.node.attrs.id,
        start: posToOffset(head.line.content, selection.from - head.lineStart),
        end: posToOffset(head.line.content, selection.to - head.lineStart),
      }
    }
    const offset = posToOffset(head.line.content, selection.head - head.lineStart)
    return { itemId: head.node.attrs.id, start: offset, end: offset }
  }

  setCaret(caret: NoteEditorCaret) {
    if (!this.editor) return
    const selection = this.selectionForCaret(this.view.state.doc, caret)
    if (!selection) return
    this.view.dispatch(this.view.state.tr.setSelection(selection))
    this.focusProgrammatically()
  }

  // ProseMirror ignores a collapsed selection at the document start for 200ms
  // after a focus event (a guard against Chrome resetting the caret on focus).
  // Our own focus already placed the selection, so drop that guard; otherwise
  // a deliberate caret at offset 0 right after a note switch snaps back.
  private focusProgrammatically() {
    this.view.focus()
    const input = (this.view as unknown as { input?: { lastFocus: number } }).input
    if (input) input.lastFocus = 0
  }

  focus() {
    this.editor && this.view.focus()
  }

  blur() {
    if (this.editor) (this.view.dom as HTMLElement).blur()
  }

  hasFocus() {
    return !!this.editor && this.view.hasFocus()
  }

  isComposing() {
    return !!this.editor && this.view.composing
  }

  private selectionForCaret(doc: PMNode, caret: NoteEditorCaret): Selection | null {
    const block = listBlocks(doc).find((candidate) => candidate.node.attrs.id === caret.itemId)
    if (!block) return null
    const content = block.line.content
    const start = offsetToPos(content, block.lineStart, caret.start)
    const end = offsetToPos(content, block.lineStart, caret.end)
    return TextSelection.create(doc, start, end)
  }

  // ---------------------------------------------------------------------------
  // Change reporting
  // ---------------------------------------------------------------------------

  private afterTransaction(tr: Transaction) {
    if (!this.editor || !this.callbacks) return
    if (tr.docChanged) {
      this.syncCheckboxes()
      if (!tr.getMeta(LOAD) && !tr.getMeta(ADOPT)) {
        if (this.view.composing) this.pendingComposition = true
        else this.callbacks.onDocumentChanged(this.sourceOf(tr))
      }
    }
    this.updateSlash()
    this.callbacks?.onSelectionChanged(this.getSelectionState())
  }

  private sourceOf(tr: Transaction): NoteEditorChangeSource {
    const explicit = tr.getMeta(SOURCE) as NoteEditorChangeSource | undefined
    if (explicit) return explicit
    const ui = tr.getMeta('uiEvent')
    if (tr.getMeta('paste') || ui === 'paste' || ui === 'drop') return 'paste'
    if (this.pendingImage) return 'image'
    return 'typing'
  }

  private imageCommitted() {
    if (!this.editor) return
    this.pendingImage = true
    try {
      ;(this.view as unknown as { domObserver: { flush(): void } }).domObserver.flush()
    } finally {
      this.pendingImage = false
    }
  }

  private flushDOM() {
    ;(this.view as unknown as { domObserver?: { flush(): void } }).domObserver?.flush()
  }

  private syncCheckboxes() {
    const doc = this.view.state.doc
    for (const input of (this.view.dom as HTMLElement).querySelectorAll<HTMLInputElement & { noteGetPos?: () => number | undefined }>('input.note-check')) {
      const pos = input.noteGetPos?.()
      if (pos === undefined) continue
      const node = doc.nodeAt(pos - 1)
      if (!node || node.type.name !== 'noteBlock') continue
      const checked = Boolean(node.attrs.done)
      if (input.checked !== checked) input.checked = checked
      const label = checked ? 'Mark unchecked' : 'Mark checked'
      if (input.getAttribute('aria-label') !== label) input.setAttribute('aria-label', label)
    }
  }

  private dispatch(tr: Transaction, source: NoteEditorChangeSource = 'command') {
    tr.setMeta(SOURCE, source)
    this.view.dispatch(tr.scrollIntoView())
  }

  // ---------------------------------------------------------------------------
  // Selection model
  // ---------------------------------------------------------------------------

  getSelectionState(): NoteEditorSelectionState {
    const empty: NoteEditorSelectionState = { activeKind: null, marks: { bold: false, italic: false, underline: false }, multiBlock: false }
    if (!this.editor) return empty
    const state = this.view.state
    const head = blockInfoAt(state.doc, state.selection.head)
    if (!head) return empty
    const from = blockInfoAt(state.doc, state.selection.from)
    const to = blockInfoAt(state.doc, state.selection.to)
    return {
      activeKind: head.node.attrs.kind,
      marks: {
        bold: this.markActive(state, 'bold'),
        italic: this.markActive(state, 'italic'),
        underline: this.markActive(state, 'underline'),
      },
      multiBlock: !!from && !!to && from.pos !== to.pos,
    }
  }

  private markActive(state: EditorState, name: string): boolean {
    const type = state.schema.marks[name]
    const { selection } = state
    if (selection.empty) return !!type.isInSet(state.storedMarks ?? selection.$from.marks())
    let any = false
    let all = true
    state.doc.nodesBetween(selection.from, selection.to, (node) => {
      if (node.isText) {
        any = true
        if (!type.isInSet(node.marks)) all = false
      }
    })
    return any && all
  }

  private span(state: EditorState): { from: BlockInfo; to: BlockInfo; multi: boolean } | null {
    const { selection, doc } = state
    const from = blockInfoAt(doc, selection.from)
    const to = blockInfoAt(doc, selection.to)
    if (!from || !to) return null
    return { from, to, multi: from.pos !== to.pos }
  }

  // Row selection: a selection spanning blocks where an endpoint is a list
  // row, or everything after Mod+A twice. Returns the selected rows.
  private selectedRows(state: EditorState): ListedBlock[] | null {
    const span = this.span(state)
    if (!span || !span.multi || state.selection.empty) return null
    const forced = rowKey.getState(state)?.forced ?? false
    if (!forced && !LIST_KINDS.has(span.from.node.attrs.kind) && !LIST_KINDS.has(span.to.node.attrs.kind)) return null
    const blocks = listBlocks(state.doc)
    const start = blocks.findIndex((block) => block.pos === span.from.pos)
    const end = blocks.findIndex((block) => block.pos === span.to.pos)
    if (start < 0 || end < 0) return null
    return blocks.slice(start, end + 1)
  }

  private collapse(to: 'from' | 'to' | 'head') {
    const { selection } = this.view.state
    const pos = to === 'from' ? selection.from : to === 'to' ? selection.to : selection.head
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos)))
  }

  // ---------------------------------------------------------------------------
  // Tree edits
  // ---------------------------------------------------------------------------

  private commitTree(tree: WBlock[], focus: Focus | null, source: NoteEditorChangeSource = 'command') {
    reconcileChecklists(tree)
    const state = this.view.state
    const { fragment, lineStarts } = buildFragment(this.schema, tree)
    const tr = state.tr.replaceWith(0, state.doc.content.size, fragment)
    const start = focus ? lineStarts.get(focus.block) : undefined
    if (focus && start !== undefined) {
      const pos = focus.offset === 'end' ? start + focus.block.content.size : offsetToPos(focus.block.content, start, focus.offset)
      tr.setSelection(TextSelection.create(tr.doc, pos))
    } else if (tr.doc.content.size > 0) {
      tr.setSelection(Selection.atStart(tr.doc))
    }
    this.dispatch(tr, source)
  }

  // Sets done flags from the checklist cascade/reconcile rules inside `tr`.
  private reconcileInto(tr: Transaction, selectedPositions: ReadonlySet<number> = new Set(), value = false) {
    const tree = docToTree(tr.doc)
    const flat = flattenTree(tree)
    const before = new Map(flat.map((block) => [block, block.done]))
    const selected = new Set(flat.filter((block) => selectedPositions.has(block.pos)))
    reconcileChecklists(tree, selected, value)
    for (const block of flat) {
      if (block.kind === 'checklist' && before.get(block) !== block.done) tr.setNodeAttribute(block.pos, 'done', block.done)
    }
  }

  private setKind(info: BlockInfo, kind: NoteItemKind, caret: 'keep' | 'end' = 'keep', source: NoteEditorChangeSource = 'command') {
    const state = this.view.state
    const attrs = info.node.attrs
    const done = kind === 'checklist' && attrs.kind === 'checklist' ? Boolean(attrs.done) : false
    const tr = state.tr.setNodeMarkup(info.pos, undefined, { ...attrs, kind, done })
    this.reconcileInto(tr)
    if (caret === 'end') tr.setSelection(TextSelection.create(tr.doc, info.lineStart + info.line.content.size))
    this.dispatch(tr, source)
  }

  private enter() {
    const state = this.view.state
    const span = this.span(state)
    if (!span) return
    if (span.multi) {
      this.replaceRange('split')
      return
    }
    const info = span.from
    const { selection } = state
    const content = info.line.content
    const before = content.cut(0, selection.from - info.lineStart)
    const after = content.cut(selection.to - info.lineStart)
    const tree = docToTree(state.doc)
    const block = findBlockByPos(tree, info.pos)!
    if (isContentEmpty(before) && isContentEmpty(after)) {
      if (block.kind !== 'paragraph') {
        block.kind = 'paragraph'
        block.done = false
        block.content = before.append(after)
        this.commitTree(tree, { block, offset: 0 })
        return
      }
      block.content = before
      const created = newBlock('paragraph', after)
      insertAfter(tree, block, [created])
      this.commitTree(tree, { block: created, offset: 0 })
      return
    }
    if (before.size === 0) {
      const created = newBlock(block.kind)
      block.content = after
      insertBefore(tree, block, created)
      this.commitTree(tree, { block: created, offset: 0 })
      return
    }
    block.content = before
    const created = newBlock(block.kind === 'heading' ? 'paragraph' : block.kind, after)
    insertAfter(tree, block, [created])
    this.commitTree(tree, { block: created, offset: 0 })
  }

  private softBreak() {
    const state = this.view.state
    const span = this.span(state)
    if (!span) return
    const hardBreak = this.schema.nodes.hardBreak.create()
    if (span.multi) {
      this.replaceRange(Fragment.from(hardBreak))
      return
    }
    this.dispatch(state.tr.replaceSelectionWith(hardBreak, false), 'typing')
  }

  // Replace the current cross-block selection (or row selection, treated as
  // start-of-first to end-of-last) with inline content, or a block boundary.
  private replaceRange(insert: Fragment | 'split' | null, source: NoteEditorChangeSource = 'command') {
    const state = this.view.state
    const rows = this.selectedRows(state)
    let fromPos = state.selection.from
    let toPos = state.selection.to
    if (rows) {
      fromPos = rows[0].lineStart
      const last = rows[rows.length - 1]
      toPos = last.lineStart + last.line.content.size
    }
    const from = blockInfoAt(state.doc, fromPos)
    const to = blockInfoAt(state.doc, toPos)
    if (!from || !to) return
    const tree = docToTree(state.doc)
    const first = findBlockByPos(tree, from.pos)!
    const last = findBlockByPos(tree, to.pos)!
    const head = from.line.content.cut(0, fromPos - from.lineStart)
    const tail = to.line.content.cut(toPos - to.lineStart)
    const flat = flattenTree(tree)
    for (const block of flat.slice(flat.indexOf(first) + 1, flat.indexOf(last) + 1)) deletePreservingChildren(tree, block)
    if (insert === 'split') {
      first.content = head
      const created = newBlock(first.kind === 'heading' ? 'paragraph' : first.kind, tail)
      insertAfter(tree, first, [created])
      this.commitTree(tree, { block: created, offset: 0 }, source)
      return
    }
    const middle = head.append(insert ?? Fragment.empty)
    first.content = middle.append(tail)
    this.commitTree(tree, { block: first, offset: caretLength(middle) }, source)
  }

  private deleteRows(rows: ListedBlock[], source: NoteEditorChangeSource = 'command') {
    const state = this.view.state
    const tree = docToTree(state.doc)
    const flat = flattenTree(tree)
    const firstIndex = flat.findIndex((block) => block.pos === rows[0].pos)
    for (const row of rows) {
      const block = flat.find((candidate) => candidate.pos === row.pos)
      if (block) removeBlock(tree, block)
    }
    const remaining = flattenTree(tree)
    const target = remaining[Math.min(firstIndex, remaining.length - 1)]
    this.commitTree(tree, target ? { block: target, offset: 'end' } : null, source)
  }

  private deleteSelection(source: NoteEditorChangeSource = 'command') {
    const rows = this.selectedRows(this.view.state)
    if (rows) this.deleteRows(rows, source)
    else this.replaceRange(null, source)
  }

  private backspace(): boolean {
    const state = this.view.state
    const { selection } = state
    if (!selection.empty) return false
    const info = blockInfoAt(state.doc, selection.head)
    if (!info || selection.head !== info.lineStart) return false
    if (info.node.attrs.kind !== 'paragraph') {
      this.setKind(info, 'paragraph')
      return true
    }
    const tree = docToTree(state.doc)
    const block = findBlockByPos(tree, info.pos)!
    const flat = flattenTree(tree)
    if (flat.indexOf(block) > 0) {
      const target = mergeIntoPrevious(tree, block)
      if (target) this.commitTree(tree, target)
      return true
    }
    if (!isContentEmpty(block.content) || flat.length === 1) return true
    deletePreservingChildren(tree, block)
    const next = flattenTree(tree)[0]
    this.commitTree(tree, next ? { block: next, offset: 'end' } : null)
    return true
  }

  private metaBackspace(): boolean {
    const state = this.view.state
    if (!state.selection.empty) return false
    const info = blockInfoAt(state.doc, state.selection.head)
    if (!info || !isContentEmpty(info.line.content)) return false
    const tree = docToTree(state.doc)
    const block = findBlockByPos(tree, info.pos)!
    const flat = flattenTree(tree)
    if (flat.length === 1) {
      if (info.node.attrs.kind !== 'paragraph') this.setKind(info, 'paragraph')
      return true
    }
    const index = flat.indexOf(block)
    deletePreservingChildren(tree, block)
    const target = index > 0 ? flat[index - 1] : flattenTree(tree)[0]
    this.commitTree(tree, target ? { block: target, offset: 'end' } : null)
    return true
  }

  private deleteForward(): boolean {
    const state = this.view.state
    const { selection } = state
    if (!selection.empty) return false
    const info = blockInfoAt(state.doc, selection.head)
    if (!info) return false
    const after = info.line.content.cut(selection.head - info.lineStart)
    if (hasImage(after) || plainText(after).trim() !== '') return false
    const tree = docToTree(state.doc)
    const block = findBlockByPos(tree, info.pos)!
    const flat = flattenTree(tree)
    const next = flat[flat.indexOf(block) + 1]
    if (!next) return true
    const target = mergeIntoPrevious(tree, next)
    if (target) this.commitTree(tree, target)
    return true
  }

  private headOffset(state: EditorState, info: BlockInfo): number {
    return posToOffset(info.line.content, state.selection.head - info.lineStart)
  }

  indent() {
    if (!this.editor) return
    const state = this.view.state
    const info = blockInfoAt(state.doc, state.selection.head)
    if (!info) return
    const offset = this.headOffset(state, info)
    const tree = docToTree(state.doc)
    const block = findBlockByPos(tree, info.pos)!
    if (indentBlock(tree, block)) this.commitTree(tree, { block, offset })
    else if (!state.selection.empty && this.selectedRows(state)) this.collapse('head')
  }

  outdent() {
    if (!this.editor) return
    const state = this.view.state
    const info = blockInfoAt(state.doc, state.selection.head)
    if (!info) return
    const offset = this.headOffset(state, info)
    const tree = docToTree(state.doc)
    const block = findBlockByPos(tree, info.pos)!
    const location = locate(tree, block)
    if (!location?.parent) {
      if (LIST_KINDS.has(block.kind)) {
        block.kind = 'paragraph'
        block.done = false
        this.commitTree(tree, { block, offset })
      }
      return
    }
    if (outdentBlock(tree, block)) this.commitTree(tree, { block, offset })
  }

  moveBlock(direction: 'up' | 'down') {
    if (!this.editor) return
    const state = this.view.state
    const info = blockInfoAt(state.doc, state.selection.head)
    if (!info) return
    const tree = docToTree(state.doc)
    const block = findBlockByPos(tree, info.pos)!
    if (moveWithinLevel(tree, block, direction)) this.commitTree(tree, { block, offset: 'end' })
    else if (!state.selection.empty) this.collapse('head')
  }

  private jumpBlock(direction: 'up' | 'down') {
    const state = this.view.state
    const info = blockInfoAt(state.doc, state.selection.head)
    if (!info) return
    const blocks = listBlocks(state.doc)
    const index = blocks.findIndex((block) => block.pos === info.pos)
    const target = blocks[index + (direction === 'up' ? -1 : 1)]
    if (!target) return
    let pos = direction === 'up' ? target.lineStart + target.line.content.size : target.lineStart
    const lineDOM = this.view.nodeDOM(target.pos + 1) as HTMLElement | null
    if (lineDOM) {
      const x = this.view.coordsAtPos(state.selection.head).left
      const rect = lineDOM.getBoundingClientRect()
      const hit = this.view.posAtCoords({ left: x, top: direction === 'up' ? rect.bottom - 4 : rect.top + 4 })
      if (hit && hit.pos >= target.lineStart && hit.pos <= target.lineStart + target.line.content.size) pos = hit.pos
    }
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)).scrollIntoView())
  }

  selectAll() {
    if (!this.editor) return
    const state = this.view.state
    const blocks = listBlocks(state.doc)
    if (blocks.length === 0) return
    const span = this.span(state)
    const info = span?.from
    const lineEnd = info ? info.lineStart + info.line.content.size : -1
    const wholeLine = !!info && !span!.multi && state.selection.from === info.lineStart && state.selection.to === lineEnd
    if (info && !span!.multi && !(wholeLine && blocks.length > 1)) {
      this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, info.lineStart, lineEnd)))
      return
    }
    const last = blocks[blocks.length - 1]
    const tr = state.tr.setSelection(TextSelection.create(state.doc, blocks[0].lineStart, last.lineStart + last.line.content.size))
    tr.setMeta(rowKey, blocks.length > 1)
    this.view.dispatch(tr)
  }

  setBlockKind(kind: NoteItemKind) {
    if (!this.editor) return
    const state = this.view.state
    if (state.doc.childCount === 0) {
      const block = this.schema.nodes.noteBlock.create({ kind }, [this.schema.nodes.noteLine.create()])
      const tr = state.tr.insert(0, block)
      tr.setSelection(TextSelection.create(tr.doc, 2))
      this.dispatch(tr)
      return
    }
    const info = blockInfoAt(state.doc, state.selection.head)
    if (info) this.setKind(info, kind, 'end')
  }

  toggleMark(mark: NoteInlineMark) {
    if (!this.editor) return
    const type = this.schema.marks[mark]
    pmToggleMark(type, null, { removeWhenPresent: false })(this.view.state, (tr) => this.dispatch(tr, 'typing'))
  }

  toggleChecked() {
    if (!this.editor) return
    const info = blockInfoAt(this.view.state.doc, this.view.state.selection.head)
    if (info && info.node.attrs.kind === 'checklist') this.setDone(info.pos, !info.node.attrs.done)
  }

  // Checkbox toggle: a checked row inside a row selection toggles every
  // selected row; the cascade runs locally so the store echo matches.
  private setDone(blockPos: number, value: boolean) {
    const state = this.view.state
    const node = state.doc.nodeAt(blockPos)
    if (!node || node.attrs.kind !== 'checklist') return
    const rows = this.selectedRows(state)
    const targets = rows && rows.some((row) => row.pos === blockPos) ? rows.map((row) => row.pos) : [blockPos]
    const tr = state.tr
    this.reconcileInto(tr, new Set(targets), value)
    if (!tr.docChanged) {
      this.syncCheckboxes()
      return
    }
    tr.setMeta(rowKey, rowKey.getState(state)?.forced ?? false)
    tr.setMeta(SOURCE, 'command')
    this.view.dispatch(tr)
  }

  // ---------------------------------------------------------------------------
  // Slash menu
  // ---------------------------------------------------------------------------

  private slashKey(state: EditorState): { key: string; query: string; info: BlockInfo } | null {
    if (!state.selection.empty) return null
    const info = blockInfoAt(state.doc, state.selection.head)
    if (!info) return null
    let plain = true
    info.line.content.forEach((node) => {
      if (!node.isText) plain = false
    })
    if (!plain) return null
    const match = /^\/([^\s/]*)$/.exec(plainText(info.line.content))
    if (!match) return null
    return { key: `${info.pos}:${match[0]}`, query: match[1].toLowerCase(), info }
  }

  private updateSlash() {
    const slash = this.slash
    if (!slash || !this.editor) return
    const state = this.view.state
    const current = this.view.hasFocus() && !this.view.composing ? this.slashKey(state) : null
    if (!current) {
      if (this.view.hasFocus() || !slash.isOpen) slash.hide()
      if (!current) this.slashDismissed = null
      return
    }
    if (this.slashDismissed === current.key) {
      slash.hide()
      return
    }
    const commands = filterSlashCommands(current.query)
    const anchor = this.view.nodeDOM(current.info.pos + 1) as HTMLElement | null
    if (commands.length === 0 || !anchor) {
      slash.hide()
      return
    }
    slash.show(commands, anchor)
  }

  private applySlash(command: SlashCommand) {
    const state = this.view.state
    const info = blockInfoAt(state.doc, state.selection.head)
    this.slash?.hide()
    if (!info) return
    const attrs = info.node.attrs
    const tr = state.tr.delete(info.lineStart, info.lineStart + info.line.content.size)
    tr.setNodeMarkup(info.pos, undefined, { ...attrs, kind: command.kind, done: false })
    tr.setSelection(TextSelection.create(tr.doc, info.lineStart))
    this.reconcileInto(tr)
    this.dispatch(tr)
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  private handleKeyDown(event: KeyboardEvent): boolean {
    if (event.isComposing || event.keyCode === 229) return false
    const state = this.view.state
    const mod = event.metaKey || event.ctrlKey
    const plainKey = !mod && !event.altKey && !event.shiftKey
    const key = event.key

    if (this.slash?.isOpen) {
      if (plainKey && key === 'ArrowDown') { this.slash.move(1); return true }
      if (plainKey && key === 'ArrowUp') { this.slash.move(-1); return true }
      if (plainKey && key === 'Enter') { this.slash.applyActive(); return true }
      if (plainKey && key === 'Escape') {
        this.slashDismissed = this.slashKey(state)?.key ?? null
        this.slash.hide()
        return true
      }
    }

    const span = this.span(state)
    const multi = !!span?.multi
    const rows = multi ? this.selectedRows(state) : null

    if (key === 'Enter' && !mod && !event.altKey) {
      if (event.shiftKey) this.softBreak()
      else this.enter()
      return true
    }

    if (key === 'Backspace' || key === 'Delete') {
      if (multi) {
        this.deleteSelection()
        return true
      }
      if (key === 'Backspace' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return this.metaBackspace()
      if (mod || event.altKey) return false
      return key === 'Backspace' ? this.backspace() : this.deleteForward()
    }

    if (key === 'Tab' && !mod && !event.altKey) {
      if (event.shiftKey) this.outdent()
      else this.indent()
      return true
    }

    if ((key === 'ArrowUp' || key === 'ArrowDown') && event.altKey && !mod && !event.shiftKey) {
      this.moveBlock(key === 'ArrowUp' ? 'up' : 'down')
      return true
    }

    if ((key === 'ArrowUp' || key === 'ArrowDown') && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      this.jumpBlock(key === 'ArrowUp' ? 'up' : 'down')
      return true
    }

    if (key.startsWith('Arrow') && !event.shiftKey && !mod && !event.altKey && multi) {
      if (rows) {
        this.collapse('head')
        return false
      }
      this.collapse(key === 'ArrowLeft' || key === 'ArrowUp' ? 'from' : 'to')
      return true
    }

    if (mod && !event.altKey && !event.shiftKey && (event.code === 'KeyA' || key.toLowerCase() === 'a')) {
      this.selectAll()
      return true
    }

    if (mod && !event.altKey && !event.shiftKey) {
      const code = event.code
      const mark: NoteInlineMark | null = code === 'KeyB' ? 'bold' : code === 'KeyI' ? 'italic' : code === 'KeyU' ? 'underline' : null
      if (mark) {
        this.toggleMark(mark)
        return true
      }
    }

    if (key === 'Escape' && plainKey && multi) {
      this.collapse(rows ? 'head' : 'to')
      return true
    }

    return false
  }

  // ---------------------------------------------------------------------------
  // Clipboard
  // ---------------------------------------------------------------------------

  private clipboardBlocks(state: EditorState): ClipboardBlock[] | null {
    const rows = this.selectedRows(state)
    const toClipboard = (block: ListedBlock, content: Fragment): ClipboardBlock => ({
      kind: block.node.attrs.kind,
      depth: block.depth,
      html: serializeInline(content),
      done: block.node.attrs.kind === 'checklist' && Boolean(block.node.attrs.done),
      number: block.number,
    })
    if (rows) return rows.map((row) => toClipboard(row, row.line.content))
    const { selection } = state
    if (selection.empty) return null
    const span = this.span(state)
    if (!span) return null
    const blocks = listBlocks(state.doc)
    const start = blocks.findIndex((block) => block.pos === span.from.pos)
    const end = blocks.findIndex((block) => block.pos === span.to.pos)
    return blocks.slice(start, end + 1).map((block, index, list) => {
      let content = block.line.content
      const from = index === 0 ? selection.from - block.lineStart : 0
      const to = index === list.length - 1 ? selection.to - block.lineStart : content.size
      content = content.cut(from, to)
      return toClipboard(block, content)
    })
  }

  private handleCopy(event: ClipboardEvent, cut: boolean): boolean {
    if (event.defaultPrevented) return true
    this.flushDOM()
    const state = this.view.state
    const blocks = this.clipboardBlocks(state)
    if (!blocks || blocks.length === 0) return true
    if (blocks.length === 1 && blocks[0].kind !== 'quote' && !blocks[0].html.includes('<br>')) return true
    const plain = clipboardPlainText(blocks)
    const html = imageClipboardHTML(clipboardHTML(blocks))
    event.preventDefault()
    event.clipboardData?.setData('text/plain', plain)
    event.clipboardData?.setData('text/html', html)
    if (isTauri()) {
      setTimeout(() => {
        void invoke('write_note_clipboard', { plainText: plain, html: `<meta charset='utf-8'>${html}` }).catch(() => {})
      }, 0)
    }
    if (cut) this.deleteSelection()
    return true
  }

  private handlePaste(event: ClipboardEvent): boolean {
    if (event.defaultPrevented) return true
    const data = event.clipboardData
    if (!data) return false
    if (data.types.includes(IMAGE_CLIPBOARD_TYPE)) return true
    this.flushDOM()
    event.preventDefault()
    const plain = data.getData('text/plain')
    const html = data.getData('text/html')
    const items = parseNoteClipboard(plain, html)
    if (items) this.pasteBlocks(items)
    else this.pasteInline(plain, html)
    return true
  }

  private handleBalancePaste(event: CustomEvent<{ plainText?: string | null; html?: string | null }>) {
    const detail = event.detail
    if (!detail || !this.editor) return
    const plain = detail.plainText ?? ''
    if (!plain && !detail.html) return
    this.flushDOM()
    this.pasteInline(plain, detail.html ?? '', true)
  }

  private pasteInline(plain: string, html: string, forceInsert = false) {
    const state = this.view.state
    const span = this.span(state)
    if (!span) return
    if (span.multi) {
      const inline = html ? sanitizeInlineHTML(html) : escapeHTML(plain).replace(/\r?\n/g, '<br>')
      this.replaceRange(parseInline(this.schema, inline), 'paste')
      return
    }
    const target = plain.trim()
    if (!forceInsert && !state.selection.empty && (isURL(target) || isInternalHref(target))) {
      const tr = state.tr.addMark(state.selection.from, state.selection.to, this.schema.marks.link.create({ href: target }))
      this.dispatch(tr, 'paste')
      return
    }
    const inline = linkifyExternalURLs(html || escapeHTML(plain).replace(/\r?\n/g, '<br>'))
    const fragment = parseInline(this.schema, inline)
    this.dispatch(state.tr.replaceSelection(new Slice(fragment, 0, 0)), 'paste')
  }

  private toWBlocks(items: ParsedClipboardItem[]): WBlock[] {
    return items.map((item) => ({
      id: null,
      kind: item.kind,
      done: item.kind === 'checklist' && item.done,
      content: parseInline(this.schema, item.html),
      children: this.toWBlocks(item.children),
      pos: -1,
    }))
  }

  private pasteBlocks(items: ParsedClipboardItem[]) {
    const state = this.view.state
    const rows = this.selectedRows(state)
    let fromPos = state.selection.from
    let toPos = state.selection.to
    if (rows) {
      fromPos = rows[0].lineStart
      const lastRow = rows[rows.length - 1]
      toPos = lastRow.lineStart + lastRow.line.content.size
    }
    const from = blockInfoAt(state.doc, fromPos)
    const to = blockInfoAt(state.doc, toPos)
    if (!from || !to) return
    const tree = docToTree(state.doc)
    const host = findBlockByPos(tree, from.pos)!
    const end = findBlockByPos(tree, to.pos)!
    const head = from.line.content.cut(0, fromPos - from.lineStart)
    const tail = to.line.content.cut(toPos - to.lineStart)
    const flat = flattenTree(tree)
    for (const block of flat.slice(flat.indexOf(host) + 1, flat.indexOf(end) + 1)) deletePreservingChildren(tree, block)

    const pasted = this.toWBlocks(items)
    const first = pasted[0]
    const last = flattenTree(pasted).at(-1)!
    first.content = head.append(first.content)
    const offset = caretLength(last.content)
    last.content = last.content.append(tail)
    host.content = first.content
    host.kind = first.kind
    host.done = first.done
    host.children = [...first.children, ...host.children]
    insertAfter(tree, host, pasted.slice(1))
    this.commitTree(tree, { block: last === first ? host : last, offset }, 'paste')
  }

  // ---------------------------------------------------------------------------
  // Links
  // ---------------------------------------------------------------------------

  private handleClick(event: MouseEvent): boolean {
    if (event.button !== 0 || event.shiftKey || event.altKey) return false
    const anchor = (event.target as Element | null)?.closest?.('a') as HTMLAnchorElement | null
    if (!anchor || !(this.view.dom as HTMLElement).contains(anchor)) return false
    // A drag that ends on a link selects text instead of opening it.
    const down = this.pointerDown
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return false
    const href = anchor.getAttribute('href') ?? ''
    if (anchor.dataset.internalLinkKind || isInternalHref(href)) {
      const link = itemLinkFromAnchor(anchor)
      if (!link) return false
      event.preventDefault()
      this.callbacks?.onOpenLink(link)
      return true
    }
    if (isURL(href)) {
      event.preventDefault()
      void openExternalURL(href.trim())
      return true
    }
    return false
  }

  private segmentsFor(content: Fragment): ItemTextSegment[] {
    const cached = this.linkCache.get(content)
    if (cached && cached.version === this.contextVersion) return cached.segments
    const context = this.context
    const text = plainText(content)
    const segments = context && text
      ? linkifyItemText(text, context.listTemplates, context.metrics, context.notes.filter((note) => !note.deletedAt))
      : [{ text, link: null }]
    this.linkCache.set(content, { version: this.contextVersion, segments })
    return segments
  }

  // ---------------------------------------------------------------------------
  // Plugins
  // ---------------------------------------------------------------------------

  private checkboxWidget(view: EditorView, getPos: () => number | undefined): HTMLElement {
    const input = document.createElement('input') as HTMLInputElement & { noteGetPos?: () => number | undefined }
    input.type = 'checkbox'
    input.className = 'check note-check'
    input.contentEditable = 'false'
    input.noteGetPos = getPos
    const pos = getPos()
    const node = pos === undefined ? null : view.state.doc.nodeAt(pos - 1)
    input.checked = Boolean(node?.attrs.done)
    input.setAttribute('aria-label', input.checked ? 'Mark unchecked' : 'Mark checked')
    input.addEventListener('mousedown', (event) => event.preventDefault())
    input.addEventListener('change', () => {
      const at = getPos()
      if (at !== undefined) this.setDone(at - 1, input.checked)
    })
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()
      const at = getPos()
      if (at === undefined) return
      const block = this.view.state.doc.nodeAt(at - 1)
      if (!block) return
      const end = at + 1 + block.firstChild!.content.size
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, end)))
      this.view.focus()
      if (event.shiftKey) this.outdent()
      else this.indent()
    })
    return input
  }

  private buildStructure(doc: PMNode): DecorationSet {
    const decorations: Decoration[] = []
    const only = listBlocks(doc).length === 1
    for (const block of listBlocks(doc)) {
      const { node, pos, line } = block
      const kind = node.attrs.kind as NoteItemKind
      const rowAttrs: Record<string, string> = { 'data-note-item-depth': String(block.depth) }
      if (block.number !== null) rowAttrs['data-note-item-number'] = String(block.number)
      decorations.push(Decoration.node(pos, pos + node.nodeSize, rowAttrs))

      const lineAttrs: Record<string, string> = {}
      if (node.attrs.id) lineAttrs['data-item-id'] = node.attrs.id
      if (block.number !== null) lineAttrs['data-note-item-number'] = String(block.number)
      if (line.content.size === 0) {
        lineAttrs.class = only ? 'is-empty note-only-block' : 'is-empty'
        lineAttrs['data-placeholder'] = kind === 'heading' ? 'Heading' : 'Type / for styles'
      }
      decorations.push(Decoration.node(pos + 1, pos + 1 + line.nodeSize, lineAttrs))

      if (kind === 'checklist') {
        decorations.push(Decoration.widget(pos + 1, (view, getPos) => this.checkboxWidget(view, getPos), {
          key: `check:${node.attrs.id ?? `new-${pos}`}`,
          side: -1,
          stopEvent: () => true,
          ignoreSelection: true,
        }))
      }

      const segments = this.segmentsFor(line.content)
      if (segments.some((segment) => segment.link)) {
        let offset = 0
        for (const segment of segments) {
          const start = offset
          offset += segment.text.length
          if (!segment.link) continue
          const from = textOffsetToPos(line.content, block.lineStart, start)
          const to = textOffsetToPos(line.content, block.lineStart, offset)
          if (to <= from || doc.rangeHasMark(from, to, doc.type.schema.marks.link)) continue
          decorations.push(Decoration.inline(from, to, {
            nodeName: 'a',
            class: 'note-internal-link',
            'data-internal-link-kind': segment.link.kind,
            'data-internal-link-id': internalLinkId(segment.link),
            'data-internal-link-label': segment.link.label,
            title: `Open ${segment.link.label}`,
          }))
        }
      }
    }
    return DecorationSet.create(doc, decorations)
  }

  private structurePlugin(): Plugin {
    return new Plugin({
      key: new PluginKey('balanceNoteStructure'),
      props: {
        decorations: (state) => {
          const cache = this.structureCache
          if (cache && cache.doc === state.doc && cache.version === this.contextVersion) return cache.set
          const set = this.buildStructure(state.doc)
          this.structureCache = { doc: state.doc, version: this.contextVersion, set }
          return set
        },
      },
    })
  }

  private selectionPlugin(): Plugin {
    return new Plugin({
      key: rowKey,
      state: {
        init: () => ({ forced: false }),
        apply: (tr, value) => {
          const meta = tr.getMeta(rowKey)
          if (meta !== undefined) return { forced: Boolean(meta) }
          if (tr.docChanged || tr.selectionSet) return { forced: false }
          return value
        },
      },
      props: {
        attributes: (state): Record<string, string> => (this.selectedRows(state) ? { class: 'note-row-selection' } : {}),
        decorations: (state) => {
          const decorations: Decoration[] = []
          const rows = this.selectedRows(state)
          if (rows) {
            for (const row of rows) decorations.push(Decoration.node(row.pos, row.pos + row.node.nodeSize, { class: 'note-multi-selected' }))
          } else if (state.selection.empty) {
            const info = blockInfoAt(state.doc, state.selection.head)
            if (info) decorations.push(Decoration.node(info.pos + 1, info.pos + 1 + info.line.nodeSize, { class: 'has-caret' }))
          }
          return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty
        },
      },
    })
  }

  private behaviorPlugin(): Plugin {
    return new Plugin({
      key: new PluginKey('balanceNoteBehavior'),
      props: {
        handleKeyDown: (_view, event) => this.handleKeyDown(event),
        handleTextInput: (view, from, to, text) => {
          const a = blockInfoAt(view.state.doc, from)
          const b = blockInfoAt(view.state.doc, to)
          if (!a || !b || a.pos === b.pos) return false
          this.replaceRange(Fragment.from(this.schema.text(text, view.state.storedMarks ?? view.state.selection.$from.marks())), 'typing')
          return true
        },
        handleDOMEvents: {
          beforeinput: (view, event) => this.handleBeforeInput(view, event as InputEvent),
          copy: (_view, event) => this.handleCopy(event as ClipboardEvent, false),
          cut: (_view, event) => this.handleCopy(event as ClipboardEvent, true),
          paste: (_view, event) => this.handlePaste(event as ClipboardEvent),
          mousedown: (_view, event) => {
            this.pointerDown = { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY }
            return false
          },
          click: (_view, event) => this.handleClick(event as MouseEvent),
          compositionend: () => {
            setTimeout(() => this.compositionFinished(), 30)
            return false
          },
          focus: () => {
            if (this.slashBlurTimer) clearTimeout(this.slashBlurTimer)
            this.callbacks?.onFocus()
            return false
          },
          blur: (_view, event) => {
            const next = (event as FocusEvent).relatedTarget as Node | null
            if (next && this.wrapper?.contains(next)) return false
            if (this.slashBlurTimer) clearTimeout(this.slashBlurTimer)
            this.slashBlurTimer = setTimeout(() => this.slash?.hide(), 150)
            this.callbacks?.onBlur()
            return false
          },
        },
      },
      appendTransaction: (transactions, _old, state) => this.autoformat(transactions, state),
    })
  }

  private handleBeforeInput(view: EditorView, event: InputEvent): boolean {
    switch (event.inputType) {
      case 'historyUndo':
        event.preventDefault()
        this.callbacks?.onUndo()
        return true
      case 'historyRedo':
        event.preventDefault()
        this.callbacks?.onRedo()
        return true
      case 'formatBold':
      case 'formatItalic':
      case 'formatUnderline':
        event.preventDefault()
        this.toggleMark(event.inputType === 'formatBold' ? 'bold' : event.inputType === 'formatItalic' ? 'italic' : 'underline')
        return true
    }
    if (view.composing) return false
    if (event.inputType === 'insertParagraph') {
      event.preventDefault()
      this.enter()
      return true
    }
    if (event.inputType === 'insertLineBreak') {
      event.preventDefault()
      this.softBreak()
      return true
    }
    const span = this.span(view.state)
    if (!span?.multi) return false
    if ((event.inputType === 'insertText' || event.inputType === 'insertReplacementText') && event.data) {
      event.preventDefault()
      this.replaceRange(Fragment.from(this.schema.text(event.data, view.state.selection.$from.marks())), 'typing')
      return true
    }
    if (event.inputType.startsWith('delete')) {
      event.preventDefault()
      this.deleteSelection()
      return true
    }
    return false
  }

  private compositionFinished() {
    if (!this.editor || this.view.composing) return
    this.flushDOM()
    if (this.pendingComposition) {
      this.pendingComposition = false
      this.callbacks?.onDocumentChanged('typing')
    }
    this.callbacks?.onCompositionEnd()
    this.updateSlash()
  }

  // Markdown shortcuts: the whole block text is tested after typing.
  private autoformat(transactions: readonly Transaction[], state: EditorState): Transaction | null {
    if (!this.editor || this.view.composing) return null
    const typed = transactions.some((tr) => tr.docChanged && !tr.getMeta(SOURCE) && !tr.getMeta(LOAD) && !tr.getMeta(ADOPT)
      && !tr.getMeta('paste') && !tr.getMeta('uiEvent') && !tr.getMeta('composition'))
    if (!typed || !state.selection.empty) return null
    const info = blockInfoAt(state.doc, state.selection.head)
    if (!info || hasImage(info.line.content)) return null
    const text = lineTextWithBreaks(info.line.content)
    const kind = info.node.attrs.kind as NoteItemKind
    for (const rule of AUTOFORMAT_RULES) {
      const match = rule.pattern.exec(text)
      if (!match) continue
      if (rule.kind === 'numbered' && kind === 'heading') return null
      const end = offsetToPos(info.line.content, info.lineStart, match[1].length)
      const tr = state.tr.delete(info.lineStart, end)
      tr.setNodeMarkup(info.pos, undefined, { ...info.node.attrs, kind: rule.kind, done: false })
      this.reconcileInto(tr)
      return tr
    }
    return null
  }
}

export function createTipTapNoteEditor(): NoteEditorView {
  return new TipTapNoteEditor()
}
