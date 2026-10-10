// Lexical node vocabulary for the Notes editor (Notes).
//
// The document mirrors `NoteItem` exactly:
//
//   root
//   └─ NoteBlockNode (kind, done, itemId)            → div.note-item
//      ├─ NoteContentNode (inline content)           → div.note-block > [input.note-check] div.note-text
//      └─ NoteChildrenNode (only while non-empty)    → div.note-children
//         └─ NoteBlockNode …
//
// Any kind can hold children of any kind at any depth, so a paragraph under a
// heading or a quote under a bullet is representable and round-trips exactly.
// Inline content is limited to the persisted vocabulary: text with
// bold / italic / underline, line breaks, links and Balance images.

import {
  $applyNodeReplacement,
  DecoratorNode,
  ElementNode,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type RangeSelection,
  type SerializedElementNode,
  type SerializedLexicalNode,
  type SerializedTextNode,
  type Spread,
} from 'lexical'
import type { NoteItemKind } from '../../types'
import type { ImageLayout } from '../../imageMarkup'

export const LIST_KINDS: ReadonlySet<NoteItemKind> = new Set(['bullet', 'numbered', 'checklist'])

export function isListKind(kind: NoteItemKind): boolean {
  return LIST_KINDS.has(kind)
}

// Lexical text format bits we allow (bold, italic, underline).
export const FORMAT_BOLD = 1
export const FORMAT_ITALIC = 2
export const FORMAT_UNDERLINE = 8
export const ALLOWED_FORMATS = FORMAT_BOLD | FORMAT_ITALIC | FORMAT_UNDERLINE

const KIND_CLASSES: Record<NoteItemKind, string[]> = {
  paragraph: [],
  heading: ['note-heading'],
  quote: ['note-quote'],
  bullet: ['note-list-item', 'note-bullet'],
  numbered: ['note-list-item', 'note-numbered'],
  checklist: ['note-list-item', 'note-checklist'],
}
const ALL_KIND_CLASSES = [...new Set(Object.values(KIND_CLASSES).flat())]

// ---------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------

type SerializedNoteBlockNode = Spread<{ kind: NoteItemKind; done: boolean; itemId: string | null }, SerializedElementNode>

export class NoteBlockNode extends ElementNode {
  __kind: NoteItemKind
  __done: boolean
  __itemId: string | null

  static getType(): string {
    return 'note-block'
  }

  static clone(node: NoteBlockNode): NoteBlockNode {
    return new NoteBlockNode(node.__kind, node.__done, node.__itemId, node.__key)
  }

  constructor(kind: NoteItemKind = 'paragraph', done = false, itemId: string | null = null, key?: NodeKey) {
    super(key)
    this.__kind = kind
    this.__done = done
    this.__itemId = itemId
  }

  static importJSON(json: SerializedNoteBlockNode): NoteBlockNode {
    return $createNoteBlockNode(json.kind, json.done, null).updateFromJSON(json)
  }

  updateFromJSON(json: LexicalUpdateJSON<SerializedNoteBlockNode>): this {
    return super.updateFromJSON(json)
  }

  exportJSON(): SerializedNoteBlockNode {
    return { ...super.exportJSON(), kind: this.getKind(), done: this.getDone(), itemId: null }
  }

  createDOM(): HTMLElement {
    const dom = document.createElement('div')
    dom.classList.add('note-item')
    applyBlockAttributes(dom, this)
    return dom
  }

  updateDOM(prevNode: NoteBlockNode, dom: HTMLElement): boolean {
    if (prevNode.__kind !== this.__kind || prevNode.__done !== this.__done || prevNode.__itemId !== this.__itemId) {
      applyBlockAttributes(dom, this)
    }
    return false
  }

  getKind(): NoteItemKind {
    return this.getLatest().__kind
  }

  getDone(): boolean {
    return this.getLatest().__done
  }

  getItemId(): string | null {
    return this.getLatest().__itemId
  }

  setKind(kind: NoteItemKind): this {
    const self = this.getWritable()
    self.__kind = kind
    if (kind !== 'checklist') self.__done = false
    // The checkbox lives in the content node's DOM.
    this.getFirstChild()?.markDirty()
    return self
  }

  setDone(done: boolean): this {
    const self = this.getWritable()
    self.__done = done
    this.getFirstChild()?.markDirty()
    return self
  }

  setItemId(itemId: string | null): this {
    const self = this.getWritable()
    self.__itemId = itemId
    return self
  }

  isInline(): false {
    return false
  }

  canBeEmpty(): false {
    return false
  }

  canIndent(): false {
    return false
  }

  isShadowRoot(): boolean {
    return false
  }
}

function applyBlockAttributes(dom: HTMLElement, node: NoteBlockNode) {
  // classList (not className) so classes other code adds — search-result
  // target, row selection, caret marker — survive reconciliation.
  dom.classList.remove(...ALL_KIND_CLASSES)
  const classes = KIND_CLASSES[node.__kind] ?? []
  if (classes.length > 0) dom.classList.add(...classes)
  dom.classList.toggle('note-done', node.__kind === 'checklist' && node.__done)
  dom.dataset.kind = node.__kind
  if (node.__itemId) {
    dom.dataset.noteItemId = node.__itemId
    dom.dataset.itemId = node.__itemId
  } else {
    delete dom.dataset.noteItemId
    delete dom.dataset.itemId
  }
}

export function $createNoteBlockNode(kind: NoteItemKind = 'paragraph', done = false, itemId: string | null = null): NoteBlockNode {
  return $applyNodeReplacement(new NoteBlockNode(kind, kind === 'checklist' && done, itemId))
}

export function $isNoteBlockNode(node: LexicalNode | null | undefined): node is NoteBlockNode {
  return node instanceof NoteBlockNode
}

// ---------------------------------------------------------------------------
// Content (the editable inline line(s) of a block)
// ---------------------------------------------------------------------------

export class NoteContentNode extends ElementNode {
  static getType(): string {
    return 'note-content'
  }

  static clone(node: NoteContentNode): NoteContentNode {
    return new NoteContentNode(node.__key)
  }

  static importJSON(json: SerializedElementNode): NoteContentNode {
    return $createNoteContentNode().updateFromJSON(json)
  }

  createDOM(): HTMLElement {
    const dom = document.createElement('div')
    dom.className = 'note-block'
    const block = this.getParent()
    if ($isNoteBlockNode(block) && block.__kind === 'checklist') dom.append(createCheckbox(block.__done))
    const text = document.createElement('div')
    text.className = 'note-text'
    dom.append(text)
    return dom
  }

  updateDOM(_prevNode: NoteContentNode, dom: HTMLElement): boolean {
    const block = this.getParent()
    const wantsCheck = $isNoteBlockNode(block) && block.__kind === 'checklist'
    const check = dom.querySelector<HTMLInputElement>(':scope > input.note-check')
    if (wantsCheck !== Boolean(check)) return true
    if (check && $isNoteBlockNode(block)) syncCheckbox(check, block.__done)
    return false
  }

  getDOMSlot(element: HTMLElement) {
    const text = element.querySelector<HTMLElement>(':scope > .note-text') ?? element
    return super.getDOMSlot(element).withElement(text)
  }

  // Enter in the middle of a block: Lexical's insertParagraph asks the block
  // for its continuation. It is a new sibling block placed after the whole
  // subtree; headings continue as paragraphs, everything else keeps its kind.
  insertNewAfter(_selection: RangeSelection, _restoreSelection?: boolean): NoteContentNode {
    const block = this.getParentOrThrow()
    const kind: NoteItemKind = $isNoteBlockNode(block) && block.getKind() !== 'heading' ? block.getKind() : 'paragraph'
    const next = $createNoteBlockNode(kind, false, null)
    const content = $createNoteContentNode()
    next.append(content)
    block.insertAfter(next)
    return content
  }

  isInline(): false {
    return false
  }

  canBeEmpty(): true {
    return true
  }

  canIndent(): false {
    return false
  }

  // Merges and deletions at block edges are handled by the Notes commands.
  collapseAtStart(): boolean {
    return false
  }

  exportJSON(): SerializedElementNode {
    return super.exportJSON()
  }
}

function createCheckbox(done: boolean): HTMLInputElement {
  const check = document.createElement('input')
  check.type = 'checkbox'
  check.className = 'check note-check'
  check.contentEditable = 'false'
  check.tabIndex = -1
  syncCheckbox(check, done)
  return check
}

export function syncCheckbox(check: HTMLInputElement, done: boolean) {
  if (check.checked !== done) check.checked = done
  const label = done ? 'Mark unchecked' : 'Mark checked'
  if (check.getAttribute('aria-label') !== label) check.setAttribute('aria-label', label)
}

export function $createNoteContentNode(): NoteContentNode {
  return $applyNodeReplacement(new NoteContentNode())
}

export function $isNoteContentNode(node: LexicalNode | null | undefined): node is NoteContentNode {
  return node instanceof NoteContentNode
}

// ---------------------------------------------------------------------------
// Children container
// ---------------------------------------------------------------------------

export class NoteChildrenNode extends ElementNode {
  static getType(): string {
    return 'note-children'
  }

  static clone(node: NoteChildrenNode): NoteChildrenNode {
    return new NoteChildrenNode(node.__key)
  }

  static importJSON(json: SerializedElementNode): NoteChildrenNode {
    return $createNoteChildrenNode().updateFromJSON(json)
  }

  createDOM(): HTMLElement {
    const dom = document.createElement('div')
    dom.className = 'note-children'
    return dom
  }

  updateDOM(): boolean {
    return false
  }

  isInline(): false {
    return false
  }

  canBeEmpty(): false {
    return false
  }

  canIndent(): false {
    return false
  }

  exportJSON(): SerializedElementNode {
    return super.exportJSON()
  }
}

export function $createNoteChildrenNode(): NoteChildrenNode {
  return $applyNodeReplacement(new NoteChildrenNode())
}

export function $isNoteChildrenNode(node: LexicalNode | null | undefined): node is NoteChildrenNode {
  return node instanceof NoteChildrenNode
}

// ---------------------------------------------------------------------------
// Link (inline). Rendered as a real anchor; clicks are routed by the editor.
// ---------------------------------------------------------------------------

type SerializedNoteLinkNode = Spread<{ url: string }, SerializedElementNode>

export class NoteLinkNode extends ElementNode {
  __url: string

  static getType(): string {
    return 'note-link'
  }

  static clone(node: NoteLinkNode): NoteLinkNode {
    return new NoteLinkNode(node.__url, node.__key)
  }

  constructor(url = '', key?: NodeKey) {
    super(key)
    this.__url = url
  }

  static importJSON(json: SerializedNoteLinkNode): NoteLinkNode {
    return $createNoteLinkNode(json.url).updateFromJSON(json)
  }

  exportJSON(): SerializedNoteLinkNode {
    return { ...super.exportJSON(), url: this.getURL() }
  }

  createDOM(): HTMLElement {
    const anchor = document.createElement('a')
    applyLinkAttributes(anchor, this.__url)
    return anchor
  }

  updateDOM(prevNode: NoteLinkNode, dom: HTMLElement): boolean {
    if (prevNode.__url !== this.__url) applyLinkAttributes(dom as HTMLAnchorElement, this.__url)
    return false
  }

  getURL(): string {
    return this.getLatest().__url
  }

  isInline(): true {
    return true
  }

  canBeEmpty(): false {
    return false
  }

  canInsertTextBefore(): false {
    return false
  }

  canInsertTextAfter(): false {
    return false
  }
}

function applyLinkAttributes(anchor: HTMLElement, url: string) {
  anchor.setAttribute('href', url)
  if (url.startsWith('balance://')) {
    anchor.removeAttribute('target')
    anchor.removeAttribute('rel')
    anchor.classList.add('note-internal-anchor')
  } else {
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noreferrer')
    anchor.classList.remove('note-internal-anchor')
  }
}

export function $createNoteLinkNode(url: string): NoteLinkNode {
  return $applyNodeReplacement(new NoteLinkNode(url))
}

export function $isNoteLinkNode(node: LexicalNode | null | undefined): node is NoteLinkNode {
  return node instanceof NoteLinkNode
}

// ---------------------------------------------------------------------------
// Image (inline decorator). `ImageLayer` hydrates `src` by observing the DOM.
// ---------------------------------------------------------------------------

type SerializedNoteImageNode = Spread<{ imageId: string; width: number; height: number; layout: ImageLayout }, SerializedLexicalNode>

export class NoteImageNode extends DecoratorNode<null> {
  __imageId: string
  __width: number
  __height: number
  __layout: ImageLayout

  static getType(): string {
    return 'note-image'
  }

  static clone(node: NoteImageNode): NoteImageNode {
    return new NoteImageNode(node.__imageId, node.__width, node.__height, node.__layout, node.__key)
  }

  constructor(imageId = '', width = 1, height = 1, layout: ImageLayout = 'inline', key?: NodeKey) {
    super(key)
    this.__imageId = imageId
    this.__width = width
    this.__height = height
    this.__layout = layout
  }

  static importJSON(json: SerializedNoteImageNode): NoteImageNode {
    return $createNoteImageNode(json.imageId, json.width, json.height, json.layout)
  }

  exportJSON(): SerializedNoteImageNode {
    return { ...super.exportJSON(), imageId: this.__imageId, width: this.__width, height: this.__height, layout: this.__layout }
  }

  createDOM(): HTMLElement {
    const image = document.createElement('img')
    image.setAttribute('data-balance-image', this.__imageId)
    image.setAttribute('width', String(this.__width))
    image.setAttribute('height', String(this.__height))
    image.setAttribute('data-image-layout', this.__layout)
    image.setAttribute('alt', 'Image')
    image.setAttribute('draggable', 'true')
    return image
  }

  updateDOM(prevNode: NoteImageNode): boolean {
    return prevNode.__imageId !== this.__imageId || prevNode.__width !== this.__width ||
      prevNode.__height !== this.__height || prevNode.__layout !== this.__layout
  }

  setDimensionsAndLayout(width: number, height: number, layout: string | null): void {
    const node = this.getWritable()
    node.__width = Math.max(1, Math.min(30000, Math.round(width) || 1))
    node.__height = Math.max(1, Math.min(30000, Math.round(height) || 1))
    node.__layout = layout === 'left' || layout === 'right' ? layout : 'inline'
  }

  decorate(): null {
    return null
  }

  isInline(): true {
    return true
  }

  isKeyboardSelectable(): boolean {
    return true
  }

  getTextContent(): string {
    return ''
  }
}

export function $createNoteImageNode(imageId: string, width: number, height: number, layout: ImageLayout): NoteImageNode {
  return $applyNodeReplacement(new NoteImageNode(imageId, width, height, layout))
}

export function $isNoteImageNode(node: LexicalNode | null | undefined): node is NoteImageNode {
  return node instanceof NoteImageNode
}

// ---------------------------------------------------------------------------
// Text: renders marks as real <strong>/<em>/<u> elements (the persisted
// vocabulary) instead of Lexical's default span + theme class for underline.
// ---------------------------------------------------------------------------

function markTags(format: number): string[] {
  const tags: string[] = []
  if (format & FORMAT_BOLD) tags.push('strong')
  if (format & FORMAT_ITALIC) tags.push('em')
  if (format & FORMAT_UNDERLINE) tags.push('u')
  return tags
}

function innermost(element: HTMLElement): HTMLElement {
  let current = element
  while (current.firstElementChild instanceof HTMLElement) current = current.firstElementChild
  return current
}

export class NoteTextNode extends TextNode {
  static getType(): string {
    return 'note-text'
  }

  static clone(node: NoteTextNode): NoteTextNode {
    return new NoteTextNode(node.__text, node.__key)
  }

  static importJSON(json: SerializedTextNode): NoteTextNode {
    return $createNoteTextNode(json.text).updateFromJSON(json)
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const tags = markTags(this.__format)
    const outer = document.createElement(tags[0] ?? 'span')
    let inner = outer
    for (const tag of tags.slice(1)) {
      const next = document.createElement(tag)
      inner.append(next)
      inner = next
    }
    inner.append(document.createTextNode(this.__text))
    return outer
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    if (prevNode.__format !== this.__format) return true
    return super.updateDOM(prevNode, dom, config)
  }

  getDOMSlot(element: HTMLElement) {
    return super.getDOMSlot(element).withElement(innermost(element))
  }

  exportJSON(): SerializedTextNode {
    return super.exportJSON()
  }
}

export function $createNoteTextNode(text = ''): NoteTextNode {
  return $applyNodeReplacement(new NoteTextNode(text))
}

export const NOTE_NODES = [
  NoteBlockNode,
  NoteContentNode,
  NoteChildrenNode,
  NoteLinkNode,
  NoteImageNode,
  NoteTextNode,
  {
    replace: TextNode,
    with: (node: TextNode) => new NoteTextNode(node.__text),
    withKlass: NoteTextNode,
  },
]
