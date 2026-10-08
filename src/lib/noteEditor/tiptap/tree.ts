// Pure helpers between the ProseMirror document and the note block tree.
//
// Structural edits (split, merge, indent, outdent, move, range replace, paste)
// are done on a small mutable mirror of the block tree (`WBlock`) with exactly
// the store's semantics, then written back as one transaction. Inline content
// stays a ProseMirror Fragment throughout, so formatting is never re-parsed and
// untouched lines keep their Fragment objects (and their cached HTML).

import { DOMParser as PMDOMParser, Fragment, type Mark, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { imageHTML } from '../../imageMarkup'
import { inlineTextStyle } from '../../inlineTextStyle'
import { escapeHTML } from '../../planner'
import type { NoteItemKind } from '../../types'
import type { NoteBlock } from '../noteItems'
import { isInternalHref } from './schema'

export const LIST_KINDS: ReadonlySet<NoteItemKind> = new Set(['bullet', 'numbered', 'checklist'])

export type WBlock = {
  id: string | null
  kind: NoteItemKind
  done: boolean
  content: Fragment
  children: WBlock[]
  // Position of the block node in the document it was read from (-1 if new).
  pos: number
}

export function newBlock(kind: NoteItemKind, content: Fragment = Fragment.empty, done = false): WBlock {
  return { id: null, kind, done, content, children: [], pos: -1 }
}

// ---------------------------------------------------------------------------
// Document <-> tree
// ---------------------------------------------------------------------------

export function docToTree(doc: PMNode): WBlock[] {
  const read = (parent: PMNode, start: number, skipFirst: boolean): WBlock[] => {
    const result: WBlock[] = []
    parent.forEach((child, offset, index) => {
      if (skipFirst && index === 0) return
      const pos = start + offset
      result.push({
        id: child.attrs.id ?? null,
        kind: child.attrs.kind,
        done: Boolean(child.attrs.done),
        content: child.firstChild!.content,
        children: read(child, pos + 1, true),
        pos,
      })
    })
    return result
  }
  return read(doc, 0, false)
}

export function flattenTree(tree: WBlock[]): WBlock[] {
  const out: WBlock[] = []
  const walk = (list: WBlock[]) => {
    for (const block of list) {
      out.push(block)
      walk(block.children)
    }
  }
  walk(tree)
  return out
}

export function findBlockByPos(tree: WBlock[], pos: number): WBlock | null {
  return flattenTree(tree).find((block) => block.pos === pos) ?? null
}

export type Location = { list: WBlock[]; index: number; parent: WBlock | null }

export function locate(tree: WBlock[], target: WBlock): Location | null {
  const search = (list: WBlock[], parent: WBlock | null): Location | null => {
    for (let index = 0; index < list.length; index += 1) {
      if (list[index] === target) return { list, index, parent }
      const found = search(list[index].children, list[index])
      if (found) return found
    }
    return null
  }
  return search(tree, null)
}

// Builds the document content for a tree and reports where each block's line
// content starts in the new document.
export function buildFragment(schema: Schema, tree: WBlock[]): { fragment: Fragment; lineStarts: Map<WBlock, number> } {
  const blockType = schema.nodes.noteBlock
  const lineType = schema.nodes.noteLine
  const build = (block: WBlock): PMNode => blockType.create(
    { id: block.id, kind: block.kind, done: block.kind === 'checklist' ? block.done : false },
    [lineType.create(null, block.content), ...block.children.map(build)],
  )
  const fragment = Fragment.from(tree.map(build))
  const lineStarts = new Map<WBlock, number>()
  const flat = flattenTree(tree)
  let index = 0
  fragment.descendants((node, pos) => {
    if (node.type === blockType) {
      lineStarts.set(flat[index], pos + 2)
      index += 1
    }
    return node.type === blockType
  })
  return { fragment, lineStarts }
}

// ---------------------------------------------------------------------------
// Tree operations with the store's semantics (planner.ts)
// ---------------------------------------------------------------------------

export function removeBlock(tree: WBlock[], target: WBlock): void {
  const location = locate(tree, target)
  if (location) location.list.splice(location.index, 1)
}

// deletePlanItemPreservingChildren
export function deletePreservingChildren(tree: WBlock[], target: WBlock): void {
  const location = locate(tree, target)
  if (!location) return
  const { list, index } = location
  if (index > 0) {
    list[index - 1].children.push(...target.children)
    list.splice(index, 1)
  } else {
    list.splice(index, 1, ...target.children)
  }
}

export function insertAfter(tree: WBlock[], anchor: WBlock, blocks: WBlock[]): void {
  const location = locate(tree, anchor)
  if (location) location.list.splice(location.index + 1, 0, ...blocks)
}

export function insertBefore(tree: WBlock[], anchor: WBlock, block: WBlock): void {
  const location = locate(tree, anchor)
  if (location) location.list.splice(location.index, 0, block)
}

// backspacePlanItemAtStart: merge `current` into the block before it in visual
// order, or delete that block when it is empty and childless. Returns the
// caret target, or null when `current` is the first block.
export function mergeIntoPrevious(tree: WBlock[], current: WBlock): { block: WBlock; offset: number } | null {
  const flat = flattenTree(tree)
  const index = flat.indexOf(current)
  if (index <= 0) return null
  const previous = flat[index - 1]
  if (isContentEmpty(previous.content) && previous.children.length === 0) {
    removeBlock(tree, previous)
    return { block: current, offset: 0 }
  }
  const offset = caretLength(previous.content)
  previous.content = previous.content.append(current.content)
  previous.children = [...previous.children, ...current.children]
  removeBlock(tree, current)
  return { block: previous, offset }
}

// Indent: become the last child of the previous sibling.
export function indentBlock(tree: WBlock[], block: WBlock): boolean {
  const location = locate(tree, block)
  if (!location || location.index === 0) return false
  const target = location.list[location.index - 1]
  location.list.splice(location.index, 1)
  target.children.push(block)
  return true
}

// outdentItem: move after the parent; following siblings become children.
export function outdentBlock(tree: WBlock[], block: WBlock): boolean {
  const location = locate(tree, block)
  if (!location || !location.parent) return false
  const parent = location.parent
  const parentLocation = locate(tree, parent)
  if (!parentLocation) return false
  const following = parent.children.slice(location.index + 1)
  parent.children = parent.children.slice(0, location.index)
  block.children = [...block.children, ...following]
  parentLocation.list.splice(parentLocation.index + 1, 0, block)
  return true
}

export function moveWithinLevel(tree: WBlock[], block: WBlock, direction: 'up' | 'down'): boolean {
  const location = locate(tree, block)
  if (!location) return false
  const target = direction === 'up' ? location.index - 1 : location.index + 1
  if (target < 0 || target >= location.list.length) return false
  location.list.splice(location.index, 1)
  location.list.splice(target, 0, block)
  return true
}

// updateNoteChecklistItems: cascade `value` from the selected checklists to
// their checklist descendants and reconcile every other checklist with its
// checklist frontier. Mutates; returns true when anything changed.
export function reconcileChecklists(tree: WBlock[], selected: ReadonlySet<WBlock> = new Set(), value = false): boolean {
  let changed = false
  const update = (list: WBlock[], cascade: boolean): WBlock[] => {
    const frontier: WBlock[] = []
    for (const block of list) {
      const nextCascade = cascade || (block.kind === 'checklist' && selected.has(block))
      const childFrontier = update(block.children, nextCascade)
      if (block.kind === 'checklist') {
        let next = block.done
        if (nextCascade) next = value
        else if (childFrontier.length > 0) next = childFrontier.every((child) => child.done)
        if (next !== block.done) {
          block.done = next
          changed = true
        }
        frontier.push(block)
      } else {
        frontier.push(...childFrontier)
      }
    }
    return frontier
  }
  update(tree, false)
  return changed
}

// ---------------------------------------------------------------------------
// Inline content helpers
// ---------------------------------------------------------------------------

export function hasImage(content: Fragment): boolean {
  let found = false
  content.forEach((node) => {
    if (node.type.name === 'balanceImage') found = true
  })
  return found
}

// Plain text as `NoteItem.text` counts it: <br> and images contribute nothing.
export function plainText(content: Fragment): string {
  let text = ''
  content.forEach((node) => {
    if (node.isText) text += node.text
  })
  return text
}

export function isContentEmpty(content: Fragment): boolean {
  return !hasImage(content) && plainText(content).trim() === ''
}

// Caret offsets count characters, each <br> as one, images as zero.
export function caretLength(content: Fragment): number {
  let length = 0
  content.forEach((node) => {
    if (node.isText) length += node.text!.length
    else if (node.type.name === 'hardBreak') length += 1
  })
  return length
}

export function offsetToPos(content: Fragment, contentStart: number, offset: number): number {
  let remaining = Math.max(0, offset)
  let pos = contentStart
  let result = -1
  content.forEach((node) => {
    if (result >= 0) return
    if (node.isText) {
      const length = node.text!.length
      if (remaining <= length) {
        result = pos + remaining
        return
      }
      remaining -= length
    } else if (node.type.name === 'hardBreak') {
      if (remaining === 0) {
        result = pos
        return
      }
      remaining -= 1
    }
    pos += node.nodeSize
  })
  return result >= 0 ? result : contentStart + content.size
}

export function posToOffset(content: Fragment, relativePos: number): number {
  let offset = 0
  let pos = 0
  content.forEach((node) => {
    if (pos >= relativePos) return
    const end = pos + node.nodeSize
    if (node.isText) offset += Math.min(end, relativePos) - pos
    else if (node.type.name === 'hardBreak') offset += 1
    pos = end
  })
  return offset
}

// ---------------------------------------------------------------------------
// Inline HTML <-> Fragment
// ---------------------------------------------------------------------------

// Load-time HTML for each Fragment we parsed. An untouched line reads back as
// exactly the string it was loaded from, so a no-op round trip is
// byte-identical even where the stored HTML is not in canonical form.
const loadedHTML = new WeakMap<Fragment, string>()

const parsers = new WeakMap<Schema, PMDOMParser>()
function parserFor(schema: Schema): PMDOMParser {
  let parser = parsers.get(schema)
  if (!parser) {
    parser = PMDOMParser.fromSchema(schema)
    parsers.set(schema, parser)
  }
  return parser
}

export function parseInline(schema: Schema, html: string, remember = false): Fragment {
  if (!html) return Fragment.empty
  const template = document.createElement('template')
  template.innerHTML = html
  // ProseMirror has one mark per type. Carry inherited text properties into
  // nested spans so a highlight does not erase the surrounding font size.
  for (const span of template.content.querySelectorAll<HTMLElement>('span[style]')) {
    const parent = span.parentElement?.closest<HTMLElement>('span[style]')
    if (parent) span.style.cssText = inlineTextStyle(`${parent.style.cssText};${span.style.cssText}`)
  }
  const line = parserFor(schema).parse(template.content, {
    topNode: schema.nodes.noteLine.create(),
    preserveWhitespace: 'full',
  })
  const content = line.content
  if (remember && content !== Fragment.empty) loadedHTML.set(content, html)
  return content
}

function openTag(mark: Mark): string {
  switch (mark.type.name) {
    case 'bold': return '<strong>'
    case 'italic': return '<em>'
    case 'underline': return '<u>'
    case 'importedTextStyle': return `<span style="${escapeHTML(inlineTextStyle(mark.attrs.style))}">`
    case 'link': {
      const href = String(mark.attrs.href ?? '').trim()
      return isInternalHref(href)
        ? `<a href="${escapeHTML(href)}">`
        : `<a href="${escapeHTML(href)}" target="_blank" rel="noreferrer">`
    }
    default: return ''
  }
}

function closeTag(mark: Mark): string {
  switch (mark.type.name) {
    case 'bold': return '</strong>'
    case 'italic': return '</em>'
    case 'underline': return '</u>'
    case 'importedTextStyle': return '</span>'
    case 'link': return '</a>'
    default: return ''
  }
}

// Serializes inline content to the Notes HTML allowlist.
export function serializeInline(content: Fragment): string {
  if (content.size === 0) return ''
  const cached = loadedHTML.get(content)
  if (cached !== undefined) return cached
  let html = ''
  let open: readonly Mark[] = []
  content.forEach((node) => {
    const marks = node.marks
    let keep = 0
    while (keep < open.length && keep < marks.length && open[keep].eq(marks[keep])) keep += 1
    for (let index = open.length - 1; index >= keep; index -= 1) html += closeTag(open[index])
    for (let index = keep; index < marks.length; index += 1) html += openTag(marks[index])
    open = marks
    if (node.isText) html += escapeHTML(node.text!)
    else if (node.type.name === 'hardBreak') html += '<br>'
    else if (node.type.name === 'balanceImage') html += imageHTML(node.attrs.id, node.attrs.width, node.attrs.height, node.attrs.layout)
  })
  for (let index = open.length - 1; index >= 0; index -= 1) html += closeTag(open[index])
  return html
}

// ---------------------------------------------------------------------------
// NoteBlock <-> document
// ---------------------------------------------------------------------------

export function blocksToFragment(schema: Schema, blocks: NoteBlock[]): Fragment {
  const blockType = schema.nodes.noteBlock
  const lineType = schema.nodes.noteLine
  const build = (block: NoteBlock): PMNode => blockType.create(
    { id: block.id, kind: block.kind, done: block.kind === 'checklist' ? block.done : false },
    [lineType.create(null, parseInline(schema, block.html, true)), ...block.children.map(build)],
  )
  return Fragment.from(blocks.map(build))
}

export type ReadResult = { blocks: NoteBlock[]; positions: Map<NoteBlock, number> }

export function readDocBlocks(doc: PMNode): ReadResult {
  const positions = new Map<NoteBlock, number>()
  const read = (parent: PMNode, start: number, skipFirst: boolean): NoteBlock[] => {
    const result: NoteBlock[] = []
    parent.forEach((child, offset, index) => {
      if (skipFirst && index === 0) return
      const pos = start + offset
      const kind = child.attrs.kind as NoteItemKind
      const block: NoteBlock = {
        id: child.attrs.id ?? null,
        kind,
        html: serializeInline(child.firstChild!.content),
        done: kind === 'checklist' ? Boolean(child.attrs.done) : false,
        children: read(child, pos + 1, true),
      }
      positions.set(block, pos)
      result.push(block)
    })
    return result
  }
  return { blocks: read(doc, 0, false), positions }
}
