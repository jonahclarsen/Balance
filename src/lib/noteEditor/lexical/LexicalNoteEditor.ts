import { inlineTextStyle } from '../../inlineTextStyle'
// Option B: the Notes body editor built on Lexical (headless, no React).
//
// One contenteditable holds the whole note. The Lexical tree mirrors
// NoteItem.children exactly (see nodes.ts); structural keys (Enter,
// Backspace/Delete at edges, Tab, Alt+Arrow, range replacement, paste) are
// implemented here to the Notes contract, and everything else — typing,
// caret movement, IME, inline formatting — is Lexical's.
//
// The view never touches the store: it reports changes through
// `callbacks.onDocumentChanged` and serializes blocks on `readBlocks()`.
// Lexical's history is not registered; the app owns undo.

import {
  $createRangeSelectionFromDom,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  COPY_COMMAND,
  createEditor,
  CUT_COMMAND,
  DELETE_CHARACTER_COMMAND,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  INSERT_TAB_COMMAND,
  KEY_DOWN_COMMAND,
  mergeRegister,
  OUTDENT_CONTENT_COMMAND,
  ParagraphNode,
  PASTE_COMMAND,
  REDO_COMMAND,
  REMOVE_TEXT_COMMAND,
  RootNode,
  SELECT_ALL_COMMAND,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  UNDO_COMMAND,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type RangeSelection,
  type TextFormatType,
} from 'lexical'
import { registerRichText } from '@lexical/rich-text'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { openExternalURL } from '../../externalLinks'
import { imageEditing } from '../../imageEditing'
import { imageClipboardHTML } from '../../imageService'
import {
  escapeHTML,
  isGoalStatsURL,
  isURL,
  linkifyExternalURLs,
  linkifyItemText,
  noteIdFromURL,
  projectIdFromURL,
  sanitizeInlineHTML,
  type ItemLink,
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
import {
  clipboardHTML,
  clipboardPlainText,
  countPasted,
  parseChecklistClipboard,
  parseClipboardHTML,
  parsePlainTextClipboard,
  type ClipboardBlock,
  type PastedBlock,
} from './clipboard'
import {
  $caretLength,
  $hasImage,
  $inlineLeaves,
  $isContentEmpty,
  $nodesFromInlineHTML,
  $offsetOfPoint,
  $plainText,
  $removeLeadingCharacters,
  $serializeInline,
  $textWithBreaks,
} from './inline'
import {
  $createNoteBlockNode,
  $createNoteContentNode,
  $createNoteLinkNode,
  $isNoteBlockNode,
  $isNoteChildrenNode,
  $isNoteContentNode,
  $isNoteImageNode,
  ALLOWED_FORMATS,
  isListKind,
  NOTE_NODES,
  NoteBlockNode,
  NoteChildrenNode,
  NoteContentNode,
  NoteTextNode,
  syncCheckbox,
} from './nodes'
import {
  $appendChildBlocks,
  $blockOf,
  $blockPoint,
  $blocksBetween,
  $blocksInOrder,
  $childBlocks,
  $contentOf,
  $createBlock,
  $currentRange,
  $deleteRows,
  $deleteTextRange,
  $depthOf,
  $ensureAtLeastOneBlock,
  $indentBlock,
  $mergeBlocks,
  $moveBlock,
  $outdentBlock,
  $parentBlock,
  $prependChildBlocks,
  $pruneContainer,
  $removeBlock,
  $removeBlockKeepingChildren,
  $removeInlineRange,
  $rootBlocks,
  $selectEnd,
  $selectionEdges,
  $selectOffset,
  type BlockPoint,
} from './structure'
import { SLASH_PATTERN, SlashMenu, type SlashCommand } from './slashMenu'
import './lexicalNotes.css'

const SILENT_TAG = 'balance-note-silent'
const INTERNAL_LINK_HIGHLIGHT = 'balance-note-internal-link'

const MARKDOWN_TRIGGERS: Array<{ pattern: RegExp; kind: NoteItemKind }> = [
  { pattern: /^#\s(.*)$/s, kind: 'heading' },
  { pattern: /^>\s(.*)$/s, kind: 'quote' },
  { pattern: /^(?:-|\*)\s(.*)$/s, kind: 'bullet' },
  { pattern: /^[1-9]\d*\.\s(.*)$/s, kind: 'numbered' },
  { pattern: /^\[\s?\]\s(.*)$/s, kind: 'checklist' },
]

type HtmlCacheEntry = { leaves: LexicalNode[]; html: string }

type EdgeInfo = NonNullable<ReturnType<typeof $selectionEdges>>

const EMPTY_SELECTION_STATE: NoteEditorSelectionState = {
  activeKind: null,
  marks: { bold: false, italic: false, underline: false },
  multiBlock: false,
}

function $contentDescendants(content: NoteContentNode): LexicalNode[] {
  const out: LexicalNode[] = []
  const walk = (node: LexicalNode) => {
    out.push(node)
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child)
  }
  for (const child of content.getChildren()) walk(child)
  return out
}

function sameNodes(a: LexicalNode[], b: LexicalNode[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
  return true
}

function $readContent(block: NoteBlockNode): NoteContentNode | null {
  const first = block.getFirstChild()
  return $isNoteContentNode(first) ? first : null
}

function $numberOf(block: NoteBlockNode): number | null {
  if (block.getKind() !== 'numbered') return null
  let number = 1
  for (let sibling = block.getPreviousSibling(); $isNoteBlockNode(sibling) && sibling.getKind() === 'numbered'; sibling = sibling.getPreviousSibling()) number += 1
  return number
}

function isLinkTarget(value: string): boolean {
  return isURL(value) || noteIdFromURL(value) !== null || projectIdFromURL(value) !== null || isGoalStatsURL(value)
}

function stripAnchors(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll('a').forEach((anchor) => anchor.replaceWith(...Array.from(anchor.childNodes)))
  return template.innerHTML
}

class LexicalNoteEditorView implements NoteEditorView {
  readonly name = 'lexical' as const

  private editor: LexicalEditor | null = null
  private host: HTMLElement | null = null
  private root: HTMLDivElement | null = null
  private callbacks: NoteEditorHostCallbacks | null = null
  private context: NoteEditorContext = { listTemplates: [], metrics: [], notes: [], isMac: false }
  private teardown: Array<() => void> = []
  private slash: SlashMenu | null = null
  private slashDismissed: string | null = null
  private slashBlurTimer: ReturnType<typeof setTimeout> | null = null

  private composing = false
  private lastInputType: string | null = null
  private pendingSource: NoteEditorChangeSource | null = null

  private htmlCache = new Map<NodeKey, HtmlCacheEntry>()
  private lastRead = new WeakMap<NoteBlock, NodeKey>()
  private adoptedIds = new Map<NodeKey, Id>()

  private selectAllMarker: string | null = null
  private lastBlockKey: NodeKey | null = null
  private selectionState: NoteEditorSelectionState = EMPTY_SELECTION_STATE
  private selectionSignature = ''

  private segmentCache = new Map<NodeKey, { text: string; segments: ItemTextSegment[] }>()
  private internalLinks: Array<{ range: Range; link: ItemLink }> = []
  private hoverFrame = 0

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  mount(options: NoteEditorMountOptions): void {
    this.host = options.host
    this.callbacks = options.callbacks
    this.context = options.context

    const root = document.createElement('div')
    root.className = 'lexical-note-editor'
    root.contentEditable = 'true'
    root.spellcheck = true
    root.setAttribute('role', 'textbox')
    root.setAttribute('aria-multiline', 'true')
    root.setAttribute('aria-label', 'Note text')
    root.dataset.richTextInput = 'true'
    root.dataset.noteTextInput = 'true'
    root.dataset.placeholder = options.placeholder
    options.host.classList.add('lexical-note-host')
    options.host.append(root)
    this.root = root

    const editor = createEditor({
      namespace: 'balance-notes',
      nodes: NOTE_NODES,
      theme: {},
      onError: (error) => {
        console.error('[notes:lexical]', error)
      },
    })
    this.editor = editor
    editor.setRootElement(root)
    this.slash = new SlashMenu(options.host, (command) => this.applySlashCommand(command))

    this.teardown.push(
      registerRichText(editor),
      this.registerNormalization(editor),
      this.registerCommands(editor),
      editor.registerUpdateListener((payload) => this.handleUpdate(payload)),
    )
    this.attachDOMListeners(root)
    const images = imageEditing(root, () => this.resyncImages())
    this.teardown.push(() => images.destroy())
  }

  destroy(): void {
    for (const dispose of this.teardown.splice(0)) {
      try {
        dispose()
      } catch {
        // Keep tearing down.
      }
    }
    if (this.slashBlurTimer) clearTimeout(this.slashBlurTimer)
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame)
    this.clearInternalLinkHighlight()
    this.slash?.destroy()
    this.slash = null
    this.editor?.setRootElement(null)
    this.editor = null
    this.root?.remove()
    this.root = null
    this.host?.classList.remove('lexical-note-host')
    this.host = null
    this.callbacks = null
  }

  // -------------------------------------------------------------------------
  // Document in / out
  // -------------------------------------------------------------------------

  load(blocks: NoteBlock[], caret: NoteEditorCaret | null): void {
    const editor = this.editor
    if (!editor) return
    this.slash?.close()
    this.selectAllMarker = null
    const focused = this.hasFocus()
    // A reload that reports back the caret we already have (checkbox
    // cascades, remote edits elsewhere) keeps the live selection, including
    // a multi-block or row selection.
    const live = caret && focused ? this.getCaret() : null
    const keepSelection = Boolean(live && caret && live.itemId === caret.itemId && live.start === caret.start && live.end === caret.end)
    if (caret && !focused) this.root?.focus({ preventScroll: true })
    const loaded = new Map<NodeKey, string>()
    let rebuilt = false
    editor.update(() => {
      const current = $rootBlocks()
      if (this.$sameShape(current, blocks)) this.$updateInPlace(current, blocks, loaded)
      else {
        rebuilt = true
        const root = $getRoot()
        root.clear()
        root.append(...blocks.map((block) => this.$buildBlock(block, loaded)))
      }
      const selectionIntact = keepSelection && !rebuilt && ($getSelection()?.getNodes().every((node) => node.isAttached()) ?? false) &&
        !($currentRange() && [...loaded.keys()].some((key) => $blockOf($currentRange()!.anchor.getNode())?.getFirstChild()?.getKey() === key))
      if (selectionIntact) {
        // Nothing to do: the selection still points at unchanged content.
      } else if (caret) {
        const target = $blocksInOrder().find((block) => block.getItemId() === caret.itemId)
        if (target) $selectOffset(target, caret.start, caret.end)
        else $setSelection(null)
      } else if (!focused) {
        $setSelection(null)
      } else {
        const selection = $getSelection()
        if (selection && selection.getNodes().some((node) => !node.isAttached())) $setSelection(null)
      }
    }, { discrete: true, tag: caret || focused ? SILENT_TAG : [SILENT_TAG, SKIP_DOM_SELECTION_TAG] })
    if (rebuilt) {
      this.htmlCache.clear()
      this.segmentCache.clear()
      this.adoptedIds.clear()
    }
    editor.getEditorState().read(() => {
      for (const [key, html] of loaded) {
        const content = $getNodeByKey(key)
        if ($isNoteContentNode(content)) this.htmlCache.set(key, { leaves: $contentDescendants(content), html })
      }
    })
  }

  private $sameShape(nodes: NoteBlockNode[], blocks: NoteBlock[]): boolean {
    if (nodes.length !== blocks.length) return false
    for (let index = 0; index < nodes.length; index += 1) {
      const id = nodes[index].getItemId() ?? this.adoptedIds.get(nodes[index].getKey()) ?? null
      if (id === null || id !== blocks[index].id) return false
      if (!this.$sameShape($childBlocks(nodes[index]), blocks[index].children)) return false
    }
    return true
  }

  private $updateInPlace(nodes: NoteBlockNode[], blocks: NoteBlock[], loaded: Map<NodeKey, string>) {
    nodes.forEach((node, index) => {
      const block = blocks[index]
      if (node.getItemId() !== block.id) node.setItemId(block.id)
      if (node.getKind() !== block.kind) node.setKind(block.kind)
      const done = block.kind === 'checklist' && block.done
      if (node.getDone() !== done) node.setDone(done)
      const content = $contentOf(node)
      if (this.$htmlOf(content) !== block.html) {
        content.clear()
        const inline = $nodesFromInlineHTML(block.html)
        if (inline.length > 0) content.append(...inline)
        loaded.set(content.getKey(), block.html)
      }
      this.$updateInPlace($childBlocks(node), block.children, loaded)
    })
  }

  private $buildBlock(block: NoteBlock, loaded: Map<NodeKey, string>): NoteBlockNode {
    const node = $createNoteBlockNode(block.kind, block.done, block.id)
    const content = $createNoteContentNode()
    const inline = $nodesFromInlineHTML(block.html)
    if (inline.length > 0) content.append(...inline)
    node.append(content)
    loaded.set(content.getKey(), block.html)
    if (block.children.length > 0) $appendChildBlocks(node, block.children.map((child) => this.$buildBlock(child, loaded)))
    return node
  }

  // Serialized inline HTML, reusing the loaded source HTML (or the previous
  // serialization) while the content's nodes are untouched. This keeps no-op
  // round trips byte-identical and typing cheap on long notes.
  private $htmlOf(content: NoteContentNode): string {
    const key = content.getKey()
    const leaves = $contentDescendants(content)
    const cached = this.htmlCache.get(key)
    if (cached && sameNodes(cached.leaves, leaves)) return cached.html
    const html = $serializeInline(content)
    this.htmlCache.set(key, { leaves, html })
    return html
  }

  readBlocks(): NoteBlock[] {
    const editor = this.editor
    if (!editor) return []
    const build = (nodes: NoteBlockNode[]): NoteBlock[] => nodes.map((node) => {
      const content = $readContent(node)
      const key = node.getKey()
      const kind = node.getKind()
      const block: NoteBlock = {
        id: node.getItemId() ?? this.adoptedIds.get(key) ?? null,
        kind,
        html: content ? this.$htmlOf(content) : '',
        done: kind === 'checklist' && node.getDone(),
        children: build($childBlocks(node)),
      }
      this.lastRead.set(block, key)
      return block
    })
    return editor.read(() => build($rootBlocks()))
  }

  adoptIds(assignments: Array<{ block: NoteBlock; id: Id }>): void {
    const editor = this.editor
    if (!editor || assignments.length === 0) return
    const resolved: Array<[NodeKey, Id]> = []
    for (const { block, id } of assignments) {
      const key = this.lastRead.get(block)
      if (key) {
        this.adoptedIds.set(key, id)
        resolved.push([key, id])
      }
    }
    editor.update(() => {
      for (const [key, id] of resolved) {
        const node = $getNodeByKey(key)
        if ($isNoteBlockNode(node)) node.setItemId(id)
      }
    }, { discrete: true, tag: [SILENT_TAG, SKIP_DOM_SELECTION_TAG] })
  }

  // -------------------------------------------------------------------------
  // Caret
  // -------------------------------------------------------------------------

  getCaret(): NoteEditorCaret | null {
    const editor = this.editor
    const root = this.root
    if (!editor || !root) return null
    const domSelection = document.getSelection()
    if (!domSelection?.anchorNode || !root.contains(domSelection.anchorNode)) return null
    return editor.read(() => {
      const selection = $currentRange()
      if (!selection) return null
      const anchor = $blockPoint(selection.anchor)
      const focus = $blockPoint(selection.focus)
      if (!anchor) return null
      const itemId = anchor.block.getItemId() ?? this.adoptedIds.get(anchor.block.getKey())
      if (!itemId) return null
      if (focus && focus.block.is(anchor.block)) {
        return { itemId, start: Math.min(anchor.offset, focus.offset), end: Math.max(anchor.offset, focus.offset) }
      }
      return { itemId, start: anchor.offset, end: anchor.offset }
    })
  }

  setCaret(caret: NoteEditorCaret): void {
    const editor = this.editor
    if (!editor) return
    if (!this.hasFocus()) this.root?.focus({ preventScroll: true })
    editor.update(() => {
      const target = $blocksInOrder().find((block) => (block.getItemId() ?? this.adoptedIds.get(block.getKey())) === caret.itemId)
      if (!target) return
      const length = $caretLength($contentOf(target))
      $selectOffset(target, Math.min(length, caret.start), Math.min(length, caret.end))
    }, { discrete: true, tag: SILENT_TAG })
  }

  focus(): void {
    const editor = this.editor
    const root = this.root
    if (!editor || !root) return
    const hasSelection = editor.getEditorState().read(() => $currentRange() !== null)
    if (!this.hasFocus()) root.focus({ preventScroll: true })
    if (!hasSelection) {
      editor.update(() => {
        const last = this.lastBlockKey ? $getNodeByKey(this.lastBlockKey) : null
        const target = $isNoteBlockNode(last) && last.isAttached() ? last : $blocksInOrder()[0]
        if (target) $selectEnd(target)
      }, { discrete: true, tag: SILENT_TAG })
    }
  }

  blur(): void {
    this.root?.blur()
  }

  hasFocus(): boolean {
    const root = this.root
    return Boolean(root && document.activeElement && root.contains(document.activeElement))
  }

  isComposing(): boolean {
    return this.composing || Boolean(this.editor?.isComposing())
  }

  updateContext(context: NoteEditorContext): void {
    const changed = context.listTemplates !== this.context.listTemplates || context.metrics !== this.context.metrics || context.notes !== this.context.notes
    this.context = context
    if (changed) {
      this.segmentCache.clear()
      this.refreshInternalLinks()
    }
  }

  // -------------------------------------------------------------------------
  // Host commands
  // -------------------------------------------------------------------------

  private runCommand(fn: () => void) {
    const editor = this.editor
    if (!editor) return
    editor.update(() => {
      this.pendingSource = 'command'
      fn()
    }, { discrete: true })
  }

  private $targetBlock(): NoteBlockNode | null {
    const selection = $currentRange()
    if (selection) {
      const block = $blockOf(selection.anchor.getNode())
      if (block) return block
    }
    const remembered = this.lastBlockKey ? $getNodeByKey(this.lastBlockKey) : null
    if ($isNoteBlockNode(remembered) && remembered.isAttached()) return remembered
    return $blocksInOrder()[0] ?? null
  }

  setBlockKind(kind: NoteItemKind): void {
    this.runCommand(() => {
      const block = this.$targetBlock() ?? $ensureAtLeastOneBlock()
      if (block.getKind() !== kind) block.setKind(kind)
      $selectEnd(block)
    })
  }

  toggleMark(mark: NoteInlineMark): void {
    const editor = this.editor
    if (!editor) return
    editor.update(() => {
      const selection = $currentRange()
      if (!selection) return
      this.pendingSource = 'typing'
      selection.formatText(mark)
    }, { discrete: true })
  }

  toggleChecked(): void {
    this.runCommand(() => {
      const block = this.$targetBlock()
      if (block && block.getKind() === 'checklist') block.setDone(!block.getDone())
    })
  }

  indent(): void {
    this.runCommand(() => this.$indentOrOutdent(false))
  }

  outdent(): void {
    this.runCommand(() => this.$indentOrOutdent(true))
  }

  moveBlock(direction: 'up' | 'down'): void {
    this.runCommand(() => this.$moveCurrent(direction))
  }

  selectAll(): void {
    this.editor?.update(() => {
      this.$selectAll()
    }, { discrete: true })
  }

  getSelectionState(): NoteEditorSelectionState {
    return this.selectionState
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  private registerNormalization(editor: LexicalEditor): () => void {
    return mergeRegister(
      // Lexical creates plain paragraphs in a few edge cases (e.g. typing
      // with the caret on the root); fold them into note blocks.
      editor.registerNodeTransform(ParagraphNode, (paragraph) => {
        const children = paragraph.getChildren()
        if ($isNoteContentNode(paragraph.getParent())) {
          for (const child of children) paragraph.insertBefore(child)
          paragraph.remove()
          return
        }
        const block = $createBlock('paragraph')
        if (children.length > 0) $contentOf(block).append(...children)
        paragraph.replace(block)
      }),
      editor.registerNodeTransform(RootNode, (root) => {
        for (const child of root.getChildren()) {
          if ($isNoteBlockNode(child)) continue
          const block = $createBlock('paragraph')
          child.insertBefore(block)
          if ($isNoteContentNode(child)) {
            $contentOf(block).replace(child)
          } else if ($isElementNode(child) && !child.isInline()) {
            const kids = child.getChildren()
            if (kids.length > 0) $contentOf(block).append(...kids)
            child.remove()
          } else {
            $contentOf(block).append(child)
          }
        }
      }),
      editor.registerNodeTransform(NoteBlockNode, (block) => {
        const children = block.getChildren()
        if (!$isNoteContentNode(children[0])) {
          const content = $createNoteContentNode()
          if (children[0]) children[0].insertBefore(content)
          else block.append(content)
        }
        const content = $contentOf(block)
        for (const child of block.getChildren().slice(1)) {
          if ($isNoteChildrenNode(child)) continue
          if ($isNoteContentNode(child)) {
            const stray = child.getChildren()
            if (stray.length > 0) content.append(...stray)
            child.remove()
          } else if ($isNoteBlockNode(child)) {
            $appendChildBlocks(block, [child])
          } else content.append(child)
        }
        const containers = block.getChildren().filter($isNoteChildrenNode)
        for (const extra of containers.slice(0, -1)) {
          const last = containers[containers.length - 1]
          const first = last.getFirstChild()
          for (const moved of extra.getChildren()) {
            if (first) first.insertBefore(moved)
            else last.append(moved)
          }
          extra.remove()
        }
        const container = containers[containers.length - 1]
        if (container && !container.is(block.getLastChild())) block.append(container)
      }),
      editor.registerNodeTransform(NoteChildrenNode, (container) => {
        const parent = container.getParent()
        if (!$isNoteBlockNode(parent)) {
          for (const child of container.getChildren()) container.insertBefore(child)
          container.remove()
          return
        }
        for (const child of container.getChildren()) {
          if ($isNoteBlockNode(child)) continue
          const block = $createBlock('paragraph')
          child.insertBefore(block)
          if ($isElementNode(child) && !child.isInline()) {
            const kids = child.getChildren()
            if (kids.length > 0) $contentOf(block).append(...kids)
            child.remove()
          } else $contentOf(block).append(child)
        }
        $pruneContainer(container)
      }),
      editor.registerNodeTransform(NoteContentNode, (content) => {
        if ($isNoteBlockNode(content.getParent())) return
        const block = $createNoteBlockNode('paragraph')
        content.insertBefore(block)
        block.append(content)
      }),
      editor.registerNodeTransform(NoteTextNode, (text) => {
        const format = text.getFormat()
        if (format & ~ALLOWED_FORMATS) text.setFormat(format & ALLOWED_FORMATS)
        const style = inlineTextStyle(text.getStyle())
        if (style !== text.getStyle()) text.setStyle(style)
      }),
    )
  }

  private registerCommands(editor: LexicalEditor): () => void {
    return mergeRegister(
      editor.registerCommand(KEY_DOWN_COMMAND, (event) => this.handleKeyDown(event), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(INSERT_PARAGRAPH_COMMAND, () => this.$handleEnter(), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(INSERT_LINE_BREAK_COMMAND, () => this.$handleLineBreak(), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(DELETE_CHARACTER_COMMAND, (isBackward) => this.$handleDelete(isBackward, 'character'), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(DELETE_WORD_COMMAND, (isBackward) => this.$handleDelete(isBackward, 'word'), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(DELETE_LINE_COMMAND, (isBackward) => this.$handleDelete(isBackward, 'line'), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(REMOVE_TEXT_COMMAND, () => this.$handleRangeRemoval(), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(CONTROLLED_TEXT_INSERTION_COMMAND, () => {
        // Typing over a cross-block or row selection: replace the range first,
        // then let Lexical insert the text at the collapsed caret.
        this.$collapseMultiBlockRange()
        return false
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(FORMAT_TEXT_COMMAND, (format: TextFormatType) => {
        if (format !== 'bold' && format !== 'italic' && format !== 'underline') return true
        this.pendingSource = 'typing'
        return false
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(PASTE_COMMAND, (event) => this.$handlePaste(event), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(COPY_COMMAND, (event) => this.$handleCopy(event, false), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(CUT_COMMAND, (event) => this.$handleCopy(event, true), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(SELECT_ALL_COMMAND, () => {
        this.$selectAll()
        return true
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(INSERT_TAB_COMMAND, () => true, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(INDENT_CONTENT_COMMAND, () => true, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(OUTDENT_CONTENT_COMMAND, () => true, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(UNDO_COMMAND, () => {
        this.callbacks?.onUndo()
        return true
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(REDO_COMMAND, () => {
        this.callbacks?.onRedo()
        return true
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {
        this.$normalizeSelection()
        return false
      }, COMMAND_PRIORITY_CRITICAL),
    )
  }

  private attachDOMListeners(root: HTMLDivElement) {
    const listen = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
      root.addEventListener(type, listener as EventListener, options)
      this.teardown.push(() => root.removeEventListener(type, listener as EventListener, options))
    }
    listen('beforeinput', (event) => {
      this.lastInputType = event.inputType
    }, { capture: true })
    listen('compositionstart', () => {
      this.composing = true
    })
    listen('compositionend', () => {
      this.composing = false
      setTimeout(() => {
        if (!this.editor || this.composing) return
        this.callbacks?.onDocumentChanged('typing')
        this.callbacks?.onCompositionEnd()
      }, 0)
    })
    listen('mousedown', (event) => {
      const target = event.target as HTMLElement
      // A checkbox press keeps the caret / row selection where it is.
      if (target.closest('.note-check')) event.preventDefault()
    }, { capture: true })
    listen('click', (event) => this.handleClick(event), { capture: true })
    listen('mousemove', (event) => this.trackLinkHover(event))
    listen('focus', () => {
      if (this.slashBlurTimer) clearTimeout(this.slashBlurTimer)
      this.callbacks?.onFocus()
    })
    listen('blur', (event) => {
      const next = event.relatedTarget
      if (next instanceof Node && root.contains(next)) return
      if (this.slashBlurTimer) clearTimeout(this.slashBlurTimer)
      this.slashBlurTimer = setTimeout(() => this.slash?.close(), 150)
      this.callbacks?.onBlur()
    })
    listen('keydown', (event) => {
      // Space on a focused checkbox toggles it natively; keep Lexical out.
      if ((event.target as HTMLElement).closest?.('.note-check')) event.stopPropagation()
    }, { capture: true })
    const balancepaste = (event: Event) => {
      const detail = (event as CustomEvent<{ plainText?: string | null; html?: string | null }>).detail
      if (!detail) return
      const html = detail.html
        ? sanitizeInlineHTML(detail.html)
        : detail.plainText ? linkifyExternalURLs(escapeHTML(detail.plainText).replace(/\r?\n/g, '<br>')) : ''
      if (!html) return
      this.editor?.update(() => {
        const selection = this.$ensureRange()
        if (!selection) return
        this.pendingSource = 'paste'
        this.$collapseMultiBlockRange()
        this.$insertInlineHTML(html)
      }, { discrete: true })
    }
    root.addEventListener('balancepaste', balancepaste)
    this.teardown.push(() => root.removeEventListener('balancepaste', balancepaste))
    const reposition = () => this.slash?.position()
    window.addEventListener('resize', reposition)
    this.teardown.push(() => window.removeEventListener('resize', reposition))
  }

  // -------------------------------------------------------------------------
  // Update listener: emit changes, decorate derived DOM state
  // -------------------------------------------------------------------------

  private handleUpdate({ editorState, dirtyElements, dirtyLeaves, tags }: {
    editorState: EditorState
    dirtyElements: Map<NodeKey, boolean>
    dirtyLeaves: Set<NodeKey>
    tags: Set<string>
  }) {
    const source = this.pendingSource ?? 'typing'
    this.pendingSource = null
    const inputType = this.lastInputType
    this.lastInputType = null
    const silent = tags.has(SILENT_TAG)
    const changed = dirtyElements.size > 0 || dirtyLeaves.size > 0

    editorState.read(() => this.$decorate())

    if (!silent && changed && !this.isComposing()) {
      if (inputType === 'insertText' && this.tryAutoformat(editorState)) return
      this.callbacks?.onDocumentChanged(source)
    }
    if (changed) this.refreshInternalLinks()
    editorState.read(() => {
      this.$updateSlashMenu()
      this.$emitSelectionState()
    })
  }

  // Derived attributes that depend on neighbours (depth, numbering), text
  // (aria-label, placeholder), and the selection (caret row, row selection).
  private $decorate() {
    const editor = this.editor
    const root = this.root
    if (!editor || !root) return
    const selection = $currentRange()
    const edges = selection ? $selectionEdges(selection) : null
    const rows = this.$rowSelection(selection, edges)
    const rowKeys = new Set(rows?.map((row) => row.getKey()) ?? [])
    const caretKey = edges && edges.anchor.block.is(edges.focus.block) ? edges.anchor.block.getKey() : null
    const blocks = $rootBlocks()
    const single = blocks.length === 1 && $childBlocks(blocks[0]).length === 0
    root.classList.toggle('note-single-block', single)
    root.classList.toggle('lexical-row-selection', rowKeys.size > 0)
    root.classList.toggle('lexical-cross-block', Boolean(edges && !edges.anchor.block.is(edges.focus.block) && rowKeys.size === 0))

    const visit = (list: NoteBlockNode[], depth: number) => {
      let number = 0
      for (const block of list) {
        const dom = editor.getElementByKey(block.getKey())
        const kind = block.getKind()
        number = kind === 'numbered' ? number + 1 : 0
        if (dom) {
          setData(dom, 'noteItemDepth', String(depth))
          const content = $readContent(block)
          const text = content ? $plainText(content) : ''
          const empty = !content || (text === '' && !$hasImage(content) && !content.getChildren().some($isLineBreakNode))
          setAttr(dom, 'aria-label', `Note block: ${text.trim() ? text : 'Empty'}`)
          const blockDom = dom.firstElementChild as HTMLElement | null
          if (kind === 'numbered') {
            setData(dom, 'noteItemNumber', String(number))
            if (blockDom) setData(blockDom, 'noteItemNumber', String(number))
          } else {
            setData(dom, 'noteItemNumber', null)
            if (blockDom) setData(blockDom, 'noteItemNumber', null)
          }
          const textDom = blockDom?.querySelector<HTMLElement>(':scope > .note-text')
          if (textDom) setData(textDom, 'placeholder', empty ? (kind === 'heading' ? 'Heading' : 'Type / for styles') : null)
          const check = blockDom?.querySelector<HTMLInputElement>(':scope > input.note-check')
          if (check) syncCheckbox(check, block.getDone())
          dom.classList.toggle('note-empty-block', empty)
          dom.classList.toggle('note-caret-block', block.getKey() === caretKey)
          dom.classList.toggle('note-multi-selected', rowKeys.has(block.getKey()))
        }
        visit($childBlocks(block), depth + 1)
      }
    }
    visit(blocks, 0)
  }

  private tryAutoformat(editorState: EditorState): boolean {
    const plan = editorState.read(() => {
      const selection = $currentRange()
      if (!selection || !selection.isCollapsed()) return null
      const point = $blockPoint(selection.anchor)
      if (!point) return null
      const content = $readContent(point.block)
      if (!content || $hasImage(content)) return null
      const text = $textWithBreaks(content)
      for (const trigger of MARKDOWN_TRIGGERS) {
        const match = trigger.pattern.exec(text)
        if (!match) continue
        if (trigger.kind === 'numbered' && point.block.getKind() === 'heading') return null
        return { key: point.block.getKey(), kind: trigger.kind, marker: text.length - match[1].length, caret: point.offset }
      }
      return null
    })
    if (!plan) return false
    this.editor?.update(() => {
      const block = $getNodeByKey(plan.key)
      if (!$isNoteBlockNode(block)) return
      this.pendingSource = 'typing'
      block.setKind(plan.kind)
      if (plan.kind === 'checklist') block.setDone(false)
      $removeLeadingCharacters($contentOf(block), plan.marker)
      $selectOffset(block, Math.max(0, plan.caret - plan.marker))
    })
    return true
  }

  private $emitSelectionState() {
    const selection = $currentRange()
    if (!selection || !this.hasFocus()) return
    const edges = $selectionEdges(selection)
    if (!edges) return
    this.lastBlockKey = edges.anchor.block.getKey()
    const marks = { bold: false, italic: false, underline: false }
    if (selection.isCollapsed()) {
      marks.bold = selection.hasFormat('bold')
      marks.italic = selection.hasFormat('italic')
      marks.underline = selection.hasFormat('underline')
    } else {
      const texts = selection.getNodes().filter((node) => $isTextNode(node) && node.getTextContentSize() > 0) as NoteTextNode[]
      const all = (flag: number) => texts.length > 0 && texts.every((node) => (node.getFormat() & flag) !== 0)
      marks.bold = all(1)
      marks.italic = all(2)
      marks.underline = all(8)
    }
    const state: NoteEditorSelectionState = {
      activeKind: edges.anchor.block.getKind(),
      marks,
      multiBlock: !edges.anchor.block.is(edges.focus.block),
    }
    const signature = `${state.activeKind}|${marks.bold}${marks.italic}${marks.underline}|${state.multiBlock}|${this.getCaretSignature(edges)}`
    this.selectionState = state
    if (signature === this.selectionSignature) return
    this.selectionSignature = signature
    this.callbacks?.onSelectionChanged(state)
  }

  private getCaretSignature(edges: EdgeInfo): string {
    return `${edges.anchor.block.getKey()}:${edges.anchor.offset}:${edges.focus.block.getKey()}:${edges.focus.offset}`
  }

  // -------------------------------------------------------------------------
  // Selection model
  // -------------------------------------------------------------------------

  private selectionMarker(selection: RangeSelection): string {
    return `${selection.anchor.key}:${selection.anchor.offset}:${selection.focus.key}:${selection.focus.offset}`
  }

  // Row selection (contract section D): a multi-block range where either end
  // is a list row, or the whole document after Mod+A twice.
  private $rowSelection(selection: RangeSelection | null = $currentRange(), edges: EdgeInfo | null = selection ? $selectionEdges(selection) : null): NoteBlockNode[] | null {
    if (!selection || !edges || selection.isCollapsed()) return null
    const selectAll = this.selectAllMarker !== null && this.selectAllMarker === this.selectionMarker(selection)
    if (!selectAll && this.selectAllMarker !== null) this.selectAllMarker = null
    if (edges.anchor.block.is(edges.focus.block)) return null
    if (!selectAll && !isListKind(edges.anchor.block.getKind()) && !isListKind(edges.focus.block.getKind())) return null
    return $blocksBetween(edges.start.block, edges.end.block)
  }

  private $isMultiBlock(selection: RangeSelection | null): boolean {
    if (!selection || selection.isCollapsed()) return false
    const edges = $selectionEdges(selection)
    return Boolean(edges && !edges.anchor.block.is(edges.focus.block))
  }

  // Replace a cross-block / row selection with a collapsed caret at its start
  // (text semantics). Returns true if something was removed.
  private $collapseMultiBlockRange(): boolean {
    const selection = $currentRange()
    if (!selection || selection.isCollapsed()) return false
    const edges = $selectionEdges(selection)
    if (!edges || edges.start.block.is(edges.end.block)) return false
    const rows = this.$rowSelection(selection, edges)
    this.selectAllMarker = null
    if (rows) {
      $deleteTextRange({ block: edges.start.block, offset: 0 }, { block: edges.end.block, offset: $caretLength($contentOf(edges.end.block)) })
    } else {
      $deleteTextRange(edges.start, edges.end)
    }
    return true
  }

  private $selectAll() {
    const selection = $currentRange()
    const blocks = $blocksInOrder()
    if (blocks.length === 0) return
    const edges = selection ? $selectionEdges(selection) : null
    const block = edges?.anchor.block ?? blocks[0]
    const length = $caretLength($contentOf(block))
    const wholeBlock = edges && edges.start.block.is(block) && edges.end.block.is(block) && edges.start.offset === 0 && edges.end.offset === length
    if (blocks.length > 1 && wholeBlock) {
      const last = blocks[blocks.length - 1]
      const first = blocks[0]
      const next = $selectOffset(first, 0)
      const end = $selectOffset(last, $caretLength($contentOf(last)))
      const all = next.clone()
      all.focus.set(end.focus.key, end.focus.offset, end.focus.type)
      $setSelection(all)
      this.selectAllMarker = this.selectionMarker(all)
      return
    }
    this.selectAllMarker = null
    $selectOffset(block, 0, length)
  }

  // Keep the caret inside block content (never on the root or containers).
  private $normalizeSelection() {
    const selection = $currentRange()
    if (!selection) return
    for (const point of [selection.anchor, selection.focus]) {
      const node = point.getNode()
      if ($isNoteContentNode(node) || $isTextNode(node) || (!$isNoteBlockNode(node) && !$isNoteChildrenNode(node) && node.getType() !== 'root')) continue
      let block: NoteBlockNode | null = null
      let atEnd = false
      if ($isNoteBlockNode(node)) {
        block = node
        atEnd = point.offset > 0
        if (atEnd) {
          const descendants = [node, ...$blocksInOrder().filter((candidate) => candidate.getParents().some((parent) => parent.is(node)))]
          block = descendants[descendants.length - 1]
        }
      } else {
        const children = ($isElementNode(node) ? node.getChildren() : []).filter($isNoteBlockNode)
        const index = Math.min(point.offset, children.length - 1)
        block = children[index] ?? null
        atEnd = point.offset >= children.length
      }
      if (!block) continue
      const content = $contentOf(block)
      const offset = atEnd ? $caretLength(content) : 0
      const leaves = $inlineLeaves(content)
      const leaf = leaves.find((candidate) => $isTextNode(candidate.node) && offset >= candidate.start && offset <= candidate.end)
      if (leaf) point.set(leaf.node.getKey(), offset - leaf.start, 'text')
      else point.set(content.getKey(), atEnd ? content.getChildrenSize() : 0, 'element')
    }
  }

  // Lexical applies DOM selection changes asynchronously; commands that act on
  // the selection (copy right after Shift+Arrow, etc.) sync it first.
  private $syncSelectionFromDOM() {
    const editor = this.editor
    const root = this.root
    const dom = document.getSelection()
    if (!editor || !root || !dom || dom.rangeCount === 0 || !dom.anchorNode || !dom.focusNode) return
    if (!root.contains(dom.anchorNode) || !root.contains(dom.focusNode)) return
    const next = $createRangeSelectionFromDom(dom, editor)
    if (!next) return
    const current = $currentRange()
    if (current && current.anchor.is(next.anchor) && current.focus.is(next.focus)) return
    $setSelection(next)
  }

  private $ensureRange(): RangeSelection | null {
    const selection = $currentRange()
    if (selection) return selection
    const target = this.$targetBlock()
    return target ? $selectEnd(target) : null
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  private handleKeyDown(event: KeyboardEvent): boolean {
    // The app consumed it (undo/redo, search, find, navigation…).
    if (event.defaultPrevented) return true
    if ((event.target as HTMLElement | null)?.closest?.('.note-check')) return true
    const editor = this.editor
    if (!editor) return false
    const mod = event.metaKey || event.ctrlKey
    const plain = !mod && !event.altKey && !event.shiftKey
    if (!event.isComposing && !this.isComposing()) this.$syncSelectionFromDOM()

    if (this.slash?.isOpen) {
      if (plain && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        this.slash.move(event.key === 'ArrowDown' ? 1 : -1)
        return true
      }
      if (plain && event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        this.slash.apply()
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        this.dismissSlash()
        return true
      }
    }

    if (event.key === 'Tab' && !mod && !event.altKey) {
      event.preventDefault()
      editor.update(() => {
        this.pendingSource = 'command'
        this.selectAllMarker = null
        this.$indentOrOutdent(event.shiftKey)
      })
      return true
    }

    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && event.altKey && !mod && !event.shiftKey) {
      event.preventDefault()
      editor.update(() => {
        this.pendingSource = 'command'
        this.selectAllMarker = null
        this.$moveCurrent(event.key === 'ArrowUp' ? 'up' : 'down')
      })
      return true
    }

    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      // Meta+Up/Down jump to the adjacent block (P-28).
      event.preventDefault()
      editor.update(() => {
        const selection = $currentRange()
        if (!selection) return
        const point = $blockPoint(selection.focus)
        if (!point) return
        const order = $blocksInOrder()
        const index = order.findIndex((block) => block.is(point.block))
        const target = order[index + (event.key === 'ArrowUp' ? -1 : 1)]
        if (target) $selectOffset(target, Math.min(point.offset, $caretLength($contentOf(target))))
      })
      return true
    }

    if (event.key === 'Escape') {
      const handled = editor.getEditorState().read(() => {
        const selection = $currentRange()
        return Boolean(selection && this.$isMultiBlock(selection))
      })
      if (handled) {
        event.preventDefault()
        editor.update(() => {
          const selection = $currentRange()
          if (!selection) return
          const edges = $selectionEdges(selection)
          this.selectAllMarker = null
          if (edges) $selectOffset(edges.end.block, edges.end.offset)
        })
      }
      // Never let rich-text blur the editor on Escape.
      return true
    }

    // Plain arrows clear a row selection first; the caret then moves natively.
    if (plain && event.key.startsWith('Arrow') && this.selectAllMarker) this.selectAllMarker = null
    return false
  }

  private $indentOrOutdent(outdent: boolean) {
    const selection = $currentRange()
    if (!selection) return
    const point = $blockPoint(selection.focus)
    if (!point) return
    const { block, offset } = point
    if (outdent) {
      if (!$parentBlock(block)) {
        if (isListKind(block.getKind())) block.setKind('paragraph')
        else return
      } else $outdentBlock(block)
    } else if (!$indentBlock(block)) return
    $selectOffset(block, offset)
  }

  private $moveCurrent(direction: 'up' | 'down') {
    const selection = $currentRange()
    if (!selection) return
    const point = $blockPoint(selection.focus)
    if (!point) return
    $moveBlock(point.block, direction)
    $selectEnd(point.block)
  }

  // Enter (P-21). Also reached from beforeinput insertParagraph (Safari/iOS).
  private $handleEnter(): boolean {
    const selection = $currentRange()
    if (!selection) return false
    this.pendingSource = 'command'
    if (!selection.isCollapsed() && !this.$collapseMultiBlockRange()) selection.removeText()
    const current = $currentRange()
    if (!current) return true
    const point = $blockPoint(current.anchor)
    if (!point) return false
    const { block, offset } = point
    const content = $contentOf(block)
    if ($isContentEmpty(content)) {
      if (block.getKind() !== 'paragraph') {
        block.setKind('paragraph')
        $selectOffset(block, 0)
      } else {
        const next = $createBlock('paragraph')
        block.insertAfter(next)
        $selectOffset(next, 0)
      }
      return true
    }
    const leaves = $inlineLeaves(content)
    if (offset === 0 && !(leaves[0] && $isNoteImageNode(leaves[0].node) && current.anchor.type === 'element' && current.anchor.offset > 0)) {
      // At the very start: a new empty block of the same kind goes above and
      // the caret stays with the text (contract R-09, decided: conventional).
      const above = $createBlock(block.getKind())
      block.insertBefore(above)
      $selectOffset(block, 0)
      return true
    }
    current.insertParagraph()
    return true
  }

  private $handleLineBreak(): boolean {
    const selection = $currentRange()
    if (!selection) return false
    this.pendingSource = 'typing'
    if (this.$collapseMultiBlockRange()) {
      $currentRange()?.insertLineBreak()
      return true
    }
    return false
  }

  private $handleRangeRemoval(): boolean {
    const selection = $currentRange()
    if (!selection || selection.isCollapsed()) return false
    const rows = this.$rowSelection(selection)
    if (rows) {
      this.pendingSource = 'command'
      this.selectAllMarker = null
      $deleteRows(rows)
      return true
    }
    if (this.$isMultiBlock(selection)) {
      this.pendingSource = 'command'
      return this.$collapseMultiBlockRange()
    }
    return false
  }

  // Backspace / Delete and their word / line variants (P-23..P-25, P-39).
  private $handleDelete(isBackward: boolean, unit: 'character' | 'word' | 'line'): boolean {
    const selection = $currentRange()
    if (!selection) return false
    if (!selection.isCollapsed()) return this.$handleRangeRemoval()
    const point = $blockPoint(selection.anchor)
    if (!point) return false
    const { block, offset } = point
    const content = $contentOf(block)

    if (unit === 'line' && isBackward && $plainText(content) === '' && !$hasImage(content) && !content.getChildren().some($isLineBreakNode)) {
      // Meta+Backspace on an empty block removes it (P-24).
      this.pendingSource = 'command'
      const order = $blocksInOrder()
      const index = order.findIndex((candidate) => candidate.is(block))
      if (order.length === 1) {
        if (block.getKind() !== 'paragraph') block.setKind('paragraph')
        $selectOffset(block, 0)
        return true
      }
      const previous = order[index - 1]
      $removeBlockKeepingChildren(block)
      const target = previous && previous.isAttached() ? previous : $blocksInOrder()[0]
      if (target) $selectEnd(target)
      return true
    }

    const leaves = $inlineLeaves(content)
    if (isBackward) {
      const atStart = offset === 0 && !(leaves[0] && $isNoteImageNode(leaves[0].node) && selection.anchor.type === 'element' && selection.anchor.offset > 0)
      if (!atStart) return false
      if (unit === 'line' && !$isContentEmpty(content)) return true
      return this.$backspaceAtStart(block)
    }
    const length = $caretLength(content)
    const tail = offset >= length ? '' : this.$tailText(block, offset)
    const trailingImage = leaves.some((leaf) => $isNoteImageNode(leaf.node) && leaf.start >= offset && offset < length)
    if (tail.trim() !== '' || trailingImage) return false
    if (unit === 'line' && offset < length) return false
    return this.$deleteAtEnd(block)
  }

  private $tailText(block: NoteBlockNode, offset: number): string {
    let text = ''
    for (const leaf of $inlineLeaves($contentOf(block))) {
      if (leaf.end <= offset) continue
      if ($isTextNode(leaf.node)) text += leaf.node.getTextContent().slice(Math.max(0, offset - leaf.start))
    }
    return text
  }

  private $backspaceAtStart(block: NoteBlockNode): boolean {
    this.pendingSource = 'command'
    if (block.getKind() !== 'paragraph') {
      block.setKind('paragraph')
      $selectOffset(block, 0)
      return true
    }
    const order = $blocksInOrder()
    const index = order.findIndex((candidate) => candidate.is(block))
    const content = $contentOf(block)
    if (index > 0) {
      const previous = order[index - 1]
      if ($isContentEmpty($contentOf(previous)) && $childBlocks(previous).length === 0) {
        $removeBlock(previous)
        $selectOffset(block, 0)
      } else {
        $mergeBlocks(previous, block)
      }
      return true
    }
    if (!$isContentEmpty(content)) return true
    if (order.length === 1) {
      content.clear()
      $selectOffset(block, 0)
      return true
    }
    $removeBlockKeepingChildren(block)
    const first = $blocksInOrder()[0]
    if (first) $selectEnd(first)
    return true
  }

  private $deleteAtEnd(block: NoteBlockNode): boolean {
    this.pendingSource = 'command'
    const order = $blocksInOrder()
    const index = order.findIndex((candidate) => candidate.is(block))
    const next = order[index + 1]
    if (!next) return true
    if ($isContentEmpty($contentOf(block)) && $childBlocks(block).length === 0) {
      $removeBlock(block)
      $selectOffset(next, 0)
    } else {
      $mergeBlocks(block, next)
    }
    return true
  }

  // -------------------------------------------------------------------------
  // Slash menu
  // -------------------------------------------------------------------------

  private $updateSlashMenu() {
    const slash = this.slash
    const editor = this.editor
    if (!slash || !editor) return
    const selection = $currentRange()
    if (!selection || !selection.isCollapsed() || !this.hasFocus()) {
      if (!this.hasFocus()) return
      slash.close()
      return
    }
    const point = $blockPoint(selection.anchor)
    const content = point ? $readContent(point.block) : null
    const text = content ? $textWithBreaks(content) : ''
    const match = SLASH_PATTERN.exec(text)
    if (!point || !match) {
      slash.close()
      this.slashDismissed = null
      return
    }
    const key = point.block.getKey()
    if (this.slashDismissed === `${key}:${text}`) return
    this.slashDismissed = null
    const dom = editor.getElementByKey(key)
    const blockDom = dom?.firstElementChild as HTMLElement | null
    if (!blockDom) return
    slash.open(blockDom, key, match[1].toLowerCase())
  }

  private dismissSlash() {
    const slash = this.slash
    if (!slash) return
    const key = slash.blockKey
    slash.close()
    const text = key ? this.editor?.getEditorState().read(() => {
      const block = $getNodeByKey(key)
      return $isNoteBlockNode(block) ? $textWithBreaks($contentOf(block)) : ''
    }) : ''
    this.slashDismissed = key ? `${key}:${text}` : null
  }

  private applySlashCommand(command: SlashCommand) {
    const slash = this.slash
    const key = slash?.blockKey
    slash?.close()
    if (!key) return
    this.runCommand(() => {
      const block = $getNodeByKey(key)
      if (!$isNoteBlockNode(block)) return
      if (block.getKind() !== command.kind) block.setKind(command.kind)
      if (command.kind === 'checklist') block.setDone(false)
      $contentOf(block).clear()
      $selectOffset(block, 0)
    })
    if (!this.hasFocus()) this.root?.focus({ preventScroll: true })
  }

  // -------------------------------------------------------------------------
  // Mouse: checkboxes and links
  // -------------------------------------------------------------------------

  private handleClick(event: MouseEvent) {
    const target = event.target as HTMLElement
    const editor = this.editor
    if (!editor) return
    const check = target.closest<HTMLInputElement>('input.note-check')
    if (check) {
      event.stopPropagation()
      const checked = check.checked
      editor.update(() => {
        const block = $blockOf($getNearestNodeFromDOMNode(check))
        if (!block) return
        this.pendingSource = 'command'
        const rows = this.$rowSelection()
        const targets = rows && rows.some((row) => row.is(block)) ? rows : [block]
        for (const row of targets) {
          if (row.getKind() === 'checklist' && row.getDone() !== checked) row.setDone(checked)
        }
      }, { discrete: true, tag: SKIP_DOM_SELECTION_TAG })
      return
    }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = target.closest<HTMLAnchorElement>('a[href]')
    if (anchor && this.root?.contains(anchor)) {
      event.preventDefault()
      const href = anchor.getAttribute('href') ?? ''
      const link = this.internalLinkFor(href, anchor.textContent ?? '')
      if (link) this.callbacks?.onOpenLink(link)
      else if (isURL(href)) void openExternalURL(href)
      return
    }
    const selection = document.getSelection()
    if (selection && !selection.isCollapsed) return
    const hit = this.internalLinkAt(event.clientX, event.clientY)
    if (hit) {
      event.preventDefault()
      this.callbacks?.onOpenLink(hit)
    }
  }

  private internalLinkFor(href: string, label: string): ItemLink | null {
    const noteId = noteIdFromURL(href)
    if (noteId) {
      const note = this.context.notes.find((candidate) => candidate.id === noteId)
      if (note?.deletedAt) return null
      return { kind: 'note', noteId, label: note?.title.trim() || label || 'Untitled note' }
    }
    const projectId = projectIdFromURL(href)
    if (projectId !== null) return { kind: 'projects', projectId, label: 'Project vibes' }
    if (isGoalStatsURL(href)) return { kind: 'goalStats', label: 'Goal stats' }
    return null
  }

  private internalLinkAt(x: number, y: number): ItemLink | null {
    for (const { range, link } of this.internalLinks) {
      for (const rect of Array.from(range.getClientRects())) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return link
      }
    }
    return null
  }

  private trackLinkHover(event: MouseEvent) {
    if (this.internalLinks.length === 0 || this.hoverFrame) return
    const { clientX, clientY } = event
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0
      this.root?.classList.toggle('note-link-hover', this.internalLinkAt(clientX, clientY) !== null)
    })
  }

  // Display-only internal links (P-18): painted with a CSS highlight over the
  // real text, never inserted into the document or persisted.
  private refreshInternalLinks() {
    const editor = this.editor
    const highlights = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights
    const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
    if (!editor || !highlights || !HighlightCtor) return
    const { listTemplates, metrics, notes } = this.context
    const hasNames = listTemplates.length > 0 || metrics.length > 0
    const links: Array<{ range: Range; link: ItemLink }> = []
    editor.getEditorState().read(() => {
      for (const block of $blocksInOrder()) {
        const content = $readContent(block)
        if (!content) continue
        const key = block.getKey()
        const text = $plainText(content)
        if (!hasNames && !text.includes('balance://')) continue
        let cached = this.segmentCache.get(key)
        if (!cached || cached.text !== text) {
          cached = { text, segments: linkifyItemText(text, listTemplates, metrics, notes) }
          this.segmentCache.set(key, cached)
        }
        if (!cached.segments.some((segment) => segment.link)) continue
        const dom = editor.getElementByKey(content.getKey())?.querySelector(':scope > .note-text')
        if (!dom) continue
        // Skip text already inside a stored anchor.
        const nodes: Text[] = []
        const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
        let offset = 0
        for (const segment of cached.segments) {
          const start = offset
          offset += segment.text.length
          if (!segment.link) continue
          const range = rangeForOffsets(nodes, start, offset)
          if (range && !range.commonAncestorContainer.parentElement?.closest('a')) links.push({ range, link: segment.link })
        }
      }
    })
    this.internalLinks = links
    if (links.length === 0) highlights.delete(INTERNAL_LINK_HIGHLIGHT)
    else highlights.set(INTERNAL_LINK_HIGHLIGHT, new HighlightCtor(...links.map((entry) => entry.range)))
  }

  private clearInternalLinkHighlight() {
    const highlights = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights
    highlights?.delete(INTERNAL_LINK_HIGHLIGHT)
    this.internalLinks = []
  }

  // -------------------------------------------------------------------------
  // Clipboard
  // -------------------------------------------------------------------------

  private $handleCopy(event: ClipboardEvent | KeyboardEvent | null, cut: boolean): boolean {
    if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false
    this.$syncSelectionFromDOM()
    const selection = $currentRange()
    if (!selection || selection.isCollapsed()) return true
    const edges = $selectionEdges(selection)
    if (!edges) return true
    const rows = this.$rowSelection(selection, edges)
    const blocks: ClipboardBlock[] = []
    const describe = (block: NoteBlockNode, html: string) => ({
      kind: block.getKind(),
      depth: $depthOf(block),
      html,
      done: block.getKind() === 'checklist' && block.getDone(),
      number: $numberOf(block),
    })
    if (rows && rows.length >= 2) {
      for (const row of rows) blocks.push(describe(row, $serializeInline($contentOf(row))))
    } else {
      const range = $blocksBetween(edges.start.block, edges.end.block)
      for (const block of range) {
        const content = $contentOf(block)
        const from = block.is(edges.start.block) ? edges.start.offset : 0
        const to = block.is(edges.end.block) ? edges.end.offset : Number.POSITIVE_INFINITY
        blocks.push(describe(block, $serializeInline(content, from, to)))
      }
      if (blocks.length === 1 && blocks[0].kind !== 'quote' && !blocks[0].html.includes('<br>')) return true
    }
    event.preventDefault()
    const plainText = clipboardPlainText(blocks)
    const html = imageClipboardHTML(clipboardHTML(blocks))
    event.clipboardData.setData('text/plain', plainText)
    event.clipboardData.setData('text/html', html)
    if (isTauri()) {
      setTimeout(() => {
        void invoke('write_note_clipboard', { plainText, html: `<meta charset='utf-8'>${html}` }).catch(() => {})
      }, 0)
    }
    if (cut) {
      this.pendingSource = 'command'
      if (rows && rows.length >= 2) {
        this.selectAllMarker = null
        $deleteRows(rows)
      } else if (!this.$collapseMultiBlockRange()) selection.removeText()
    }
    return true
  }

  private $handlePaste(event: ClipboardEvent | InputEvent | KeyboardEvent): boolean {
    const data = event instanceof ClipboardEvent ? event.clipboardData : event instanceof InputEvent ? event.dataTransfer : null
    if (!data) return false
    event.preventDefault()
    const plain = data.getData('text/plain')
    const html = data.getData('text/html')
    this.$syncSelectionFromDOM()
    const selection = this.$ensureRange()
    if (!selection) return true
    this.pendingSource = 'paste'

    let items: PastedBlock[] = parseChecklistClipboard(plain, html)
    if (items.length === 0 && !html) items = parsePlainTextClipboard(plain)
    if (items.length === 0 && html) items = parseClipboardHTML(html)

    if (items.length === 0 || (countPasted(items) === 1 && items[0].kind === 'paragraph')) {
      if (this.$collapseMultiBlockRange()) {
        const inline = html ? sanitizeInlineHTML(html) : escapeHTML(plain).replace(/\r?\n/g, '<br>')
        this.$insertInlineHTML(inline)
        return true
      }
      const trimmed = plain.trim()
      if (!selection.isCollapsed() && trimmed && isLinkTarget(trimmed)) {
        this.$wrapSelectionInLink(trimmed)
        return true
      }
      this.$insertInlineHTML(linkifyExternalURLs(html || escapeHTML(plain).replace(/\r?\n/g, '<br>')))
      return true
    }

    if (!selection.isCollapsed() && !this.$collapseMultiBlockRange()) selection.removeText()
    this.$pasteBlocks(items)
    return true
  }

  private $insertInlineHTML(html: string) {
    const cleaned = html.replace(/(?:<br>)+$/, '')
    const nodes = $nodesFromInlineHTML(cleaned)
    const selection = $currentRange()
    if (!selection || nodes.length === 0) return
    selection.insertNodes(nodes)
  }

  private $wrapSelectionInLink(url: string) {
    const selection = $currentRange()
    if (!selection) return
    const edges = $selectionEdges(selection)
    if (!edges || !edges.start.block.is(edges.end.block)) return
    const { block } = edges.start
    const inner = stripAnchors($serializeInline($contentOf(block), edges.start.offset, edges.end.offset))
    $removeInlineRange(block, edges.start.offset, edges.end.offset)
    const link = $createNoteLinkNode(url)
    const nodes = $nodesFromInlineHTML(inner)
    if (nodes.length === 0) return
    link.append(...nodes)
    $selectOffset(block, edges.start.offset)
    $currentRange()?.insertNodes([link])
  }

  // Multi-block paste (P-43 step 8).
  private $pasteBlocks(items: PastedBlock[]) {
    const selection = $currentRange()
    if (!selection) return
    const point = $blockPoint(selection.anchor)
    if (!point) return
    const { block, offset } = point
    const content = $contentOf(block)
    const afterHTML = $serializeInline(content, offset)
    $removeInlineRange(block, offset, $caretLength(content))
    const build = (item: PastedBlock): NoteBlockNode => {
      const node = $createBlock(item.kind, item.done)
      const inline = $nodesFromInlineHTML(item.html)
      if (inline.length > 0) $contentOf(node).append(...inline)
      $appendChildBlocks(node, item.children.map(build))
      return node
    }
    const [first, ...rest] = items
    block.setKind(first.kind)
    block.setDone(first.kind === 'checklist' && first.done)
    const firstInline = $nodesFromInlineHTML(first.html)
    if (firstInline.length > 0) content.append(...firstInline)
    const pastedChildren = first.children.map(build)
    $prependChildBlocks(block, pastedChildren)
    let previous = block
    const following: NoteBlockNode[] = []
    for (const item of rest) {
      const node = build(item)
      previous.insertAfter(node)
      previous = node
      following.push(node)
    }
    const deepestLast = (node: NoteBlockNode): NoteBlockNode => {
      const children = $childBlocks(node)
      return children.length > 0 ? deepestLast(children[children.length - 1]) : node
    }
    const last = following.length > 0
      ? deepestLast(following[following.length - 1])
      : pastedChildren.length > 0 ? deepestLast(pastedChildren[pastedChildren.length - 1]) : block
    const lastContent = $contentOf(last)
    const caret = $caretLength(lastContent)
    const afterInline = $nodesFromInlineHTML(afterHTML)
    if (afterInline.length > 0) lastContent.append(...afterInline)
    $selectOffset(last, caret)
  }

  // -------------------------------------------------------------------------
  // Images: the shared image action edits the DOM directly; mirror its
  // changes back into the model.
  // -------------------------------------------------------------------------

  private resyncImages() {
    const editor = this.editor
    if (!editor) return
    const changed: Array<{ key: NodeKey; html: string }> = []
    editor.getEditorState().read(() => {
      for (const block of $blocksInOrder()) {
        const content = $readContent(block)
        if (!content) continue
        const dom = editor.getElementByKey(content.getKey())?.querySelector<HTMLElement>(':scope > .note-text')
        if (!dom) continue
        const domImages = Array.from(dom.querySelectorAll('img[data-balance-image]')).map((image) => image.outerHTML.length > 0 ? `${image.getAttribute('data-balance-image')}:${image.getAttribute('width')}x${image.getAttribute('height')}:${image.getAttribute('data-image-layout')}` : '')
        const modelImages = $inlineLeaves(content).filter((leaf) => $isNoteImageNode(leaf.node)).map((leaf) => {
          const image = leaf.node as unknown as { __imageId: string; __width: number; __height: number; __layout: string }
          return `${image.__imageId}:${image.__width}x${image.__height}:${image.__layout}`
        })
        if (domImages.join('|') === modelImages.join('|')) continue
        let html = sanitizeInlineHTML(dom.innerHTML)
        const modelHTML = this.$htmlOf(content)
        const modelBreaks = (modelHTML.match(/(?:<br>)+$/)?.[0].length ?? 0) / 4
        const domBreaks = (html.match(/(?:<br>)+$/)?.[0].length ?? 0) / 4
        if (domBreaks > modelBreaks) html = html.slice(0, html.length - (domBreaks - modelBreaks) * 4)
        changed.push({ key: content.getKey(), html })
      }
    })
    if (changed.length === 0) return
    editor.update(() => {
      this.pendingSource = 'image'
      for (const { key, html } of changed) {
        const content = $getNodeByKey(key)
        if (!$isNoteContentNode(content)) continue
        content.clear()
        const nodes = $nodesFromInlineHTML(html)
        if (nodes.length > 0) content.append(...nodes)
      }
    }, { discrete: true })
  }
}

function rangeForOffsets(nodes: Text[], start: number, end: number): Range | null {
  let offset = 0
  let startPoint: [Text, number] | null = null
  let endPoint: [Text, number] | null = null
  for (const node of nodes) {
    const length = node.length
    if (!startPoint && start <= offset + length) startPoint = [node, start - offset]
    if (!endPoint && end <= offset + length) {
      endPoint = [node, end - offset]
      break
    }
    offset += length
  }
  if (!startPoint || !endPoint) return null
  const range = document.createRange()
  range.setStart(startPoint[0], startPoint[1])
  range.setEnd(endPoint[0], endPoint[1])
  return range
}

function setData(element: HTMLElement, key: string, value: string | null) {
  if (value === null) {
    if (key in element.dataset) delete element.dataset[key]
  } else if (element.dataset[key] !== value) element.dataset[key] = value
}

function setAttr(element: HTMLElement, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value)
}

export function createLexicalNoteEditor(): NoteEditorView {
  return new LexicalNoteEditorView()
}
