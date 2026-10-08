// Inline content <-> persisted HTML, and plain-text caret offsets.
//
// Export writes exactly the allowlisted vocabulary (<strong>, <em>, <u>,
// <br>, <a>, <img data-balance-image>) straight from the Lexical model — no
// DOM parsing per keystroke. Import turns sanitized inline HTML into nodes.
//
// Internal offsets count text characters and one per line break or image.
// Public NoteEditorCaret offsets still count zero per image; translate at the
// adapter boundary so editing ranges can distinguish either side of an image.

import {
  $createLineBreakNode,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type PointType,
  type TextNode,
} from 'lexical'
import { escapeHTML } from '../../planner'
import { inlineTextStyle } from '../../inlineTextStyle'
import { imageHTML, type ImageLayout } from '../../imageMarkup'
import {
  $createNoteImageNode,
  $createNoteLinkNode,
  $createNoteTextNode,
  $isNoteImageNode,
  $isNoteLinkNode,
  ALLOWED_FORMATS,
  FORMAT_BOLD,
  FORMAT_ITALIC,
  FORMAT_UNDERLINE,
  type NoteContentNode,
} from './nodes'

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function $nodesFromInlineHTML(html: string): LexicalNode[] {
  if (!html) return []
  const template = document.createElement('template')
  template.innerHTML = html
  const nodes: LexicalNode[] = []
  const walk = (parent: Node, format: number, out: LexicalNode[], style = '') => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = (child.textContent ?? '').split('\n')
        parts.forEach((part, index) => {
          if (index > 0) out.push($createLineBreakNode())
          if (part) out.push($createNoteTextNode(part).setFormat(format).setStyle(style))
        })
        continue
      }
      if (!(child instanceof HTMLElement)) continue
      const tag = child.tagName
      const nextStyle = inlineTextStyle(`${style};${child.getAttribute('style') ?? ''}`)
      if (tag === 'BR') out.push($createLineBreakNode())
      else if (tag === 'STRONG' || tag === 'B') walk(child, format | FORMAT_BOLD, out, nextStyle)
      else if (tag === 'EM' || tag === 'I') walk(child, format | FORMAT_ITALIC, out, nextStyle)
      else if (tag === 'U') walk(child, format | FORMAT_UNDERLINE, out, nextStyle)
      else if (tag === 'A' && child.getAttribute('href')) {
        const link = $createNoteLinkNode(child.getAttribute('href') ?? '')
        const inner: LexicalNode[] = []
        walk(child, format, inner, nextStyle)
        if (inner.length === 0) continue
        link.append(...inner)
        out.push(link)
      } else if (tag === 'IMG' && child.hasAttribute('data-balance-image')) {
        const layout = child.getAttribute('data-image-layout')
        out.push($createNoteImageNode(
          child.getAttribute('data-balance-image') ?? '',
          Number(child.getAttribute('width')) || 1,
          Number(child.getAttribute('height')) || 1,
          (layout === 'left' || layout === 'right' ? layout : 'inline') as ImageLayout,
        ))
      } else walk(child, format, out, nextStyle)
    }
  }
  walk(template.content, 0, nodes)
  return nodes
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const MARKS: Array<[number, string]> = [[FORMAT_BOLD, 'strong'], [FORMAT_ITALIC, 'em'], [FORMAT_UNDERLINE, 'u']]

type Leaf = { node: LexicalNode; start: number; end: number }

// Serialize an element's inline children. `from`/`to` limit the output to a
// caret-offset range (used by copy); omit them for the whole content.
export function $serializeInline(element: ElementNode, from = 0, to = Number.POSITIVE_INFINITY): string {
  const state = { offset: 0 }
  return serializeChildren(element, state, from, to)
}

function serializeChildren(element: ElementNode, state: { offset: number }, from: number, to: number): string {
  let html = ''
  const open: string[] = []
  const closeAll = () => {
    while (open.length > 0) html += `</${open.pop()}>`
  }
  const setMarks = (format: number) => {
    const wanted = MARKS.filter(([flag]) => format & flag).map(([, tag]) => tag)
    // Keep the longest prefix of open marks that is still wanted.
    let keep = 0
    while (keep < open.length && wanted.includes(open[keep])) keep += 1
    while (open.length > keep) html += `</${open.pop()}>`
    for (const tag of wanted) {
      if (!open.includes(tag)) {
        html += `<${tag}>`
        open.push(tag)
      }
    }
  }

  for (const child of element.getChildren()) {
    if ($isTextNode(child)) {
      const text = child.getTextContent()
      const start = state.offset
      state.offset += text.length
      const sliceStart = Math.max(0, from - start)
      const sliceEnd = Math.min(text.length, to - start)
      if (sliceEnd <= sliceStart) continue
      const part = text.slice(sliceStart, sliceEnd)
      if (!part) continue
      setMarks(child.getFormat() & ALLOWED_FORMATS)
      const style = inlineTextStyle(child.getStyle())
      html += style ? `<span style="${escapeHTML(style)}">${escapeHTML(part)}</span>` : escapeHTML(part)
    } else if ($isLineBreakNode(child)) {
      const start = state.offset
      state.offset += 1
      if (start >= from && start < to) {
        html += '<br>'
      }
    } else if ($isNoteImageNode(child)) {
      const start = state.offset++
      if (start >= from && start < to) {
        setMarks(0)
        html += imageHTML(child.__imageId, child.__width, child.__height, child.__layout)
      }
    } else if ($isNoteLinkNode(child)) {
      const inner = serializeChildren(child, state, from, to)
      if (!inner) continue
      closeAll()
      const url = child.getURL()
      html += url.startsWith('balance://')
        ? `<a href="${escapeHTML(url)}">${inner}</a>`
        : `<a href="${escapeHTML(url)}" target="_blank" rel="noreferrer">${inner}</a>`
    } else if ($isElementNode(child)) {
      html += serializeChildren(child, state, from, to)
    }
  }
  closeAll()
  return html
}

// ---------------------------------------------------------------------------
// Leaves, text, offsets
// ---------------------------------------------------------------------------

// Inline leaves in document order with their caret-offset spans.
export function $inlineLeaves(content: ElementNode): Leaf[] {
  const leaves: Leaf[] = []
  let offset = 0
  const walk = (element: ElementNode) => {
    for (const child of element.getChildren()) {
      if ($isTextNode(child)) {
        const length = child.getTextContentSize()
        leaves.push({ node: child, start: offset, end: offset + length })
        offset += length
      } else if ($isLineBreakNode(child)) {
        leaves.push({ node: child, start: offset, end: offset + 1 })
        offset += 1
      } else if ($isElementNode(child)) walk(child)
      else {
        const length = $isNoteImageNode(child) ? 1 : 0
        leaves.push({ node: child, start: offset, end: offset + length })
        offset += length
      }
    }
  }
  walk(content)
  return leaves
}

export function $caretLength(content: ElementNode): number {
  const leaves = $inlineLeaves(content)
  return leaves.length > 0 ? leaves[leaves.length - 1].end : 0
}

// `NoteItem.text`: text only; a line break contributes nothing.
export function $plainText(content: ElementNode): string {
  let text = ''
  const walk = (element: ElementNode) => {
    for (const child of element.getChildren()) {
      if ($isTextNode(child)) text += child.getTextContent()
      else if ($isElementNode(child)) walk(child)
    }
  }
  walk(content)
  return text
}

// Text with "\n" for line breaks (markdown triggers, slash queries).
export function $textWithBreaks(content: ElementNode): string {
  let text = ''
  const walk = (element: ElementNode) => {
    for (const child of element.getChildren()) {
      if ($isTextNode(child)) text += child.getTextContent()
      else if ($isLineBreakNode(child)) text += '\n'
      else if ($isElementNode(child)) walk(child)
    }
  }
  walk(content)
  return text
}

export function $hasImage(content: ElementNode): boolean {
  let found = false
  const walk = (element: ElementNode) => {
    for (const child of element.getChildren()) {
      if (found) return
      if ($isNoteImageNode(child)) found = true
      else if ($isElementNode(child)) walk(child)
    }
  }
  walk(content)
  return found
}

// Empty for Enter/Backspace purposes: no visible text and no image.
export function $isContentEmpty(content: ElementNode): boolean {
  return $plainText(content).trim() === '' && !$hasImage(content)
}

function isAncestorOrSelf(ancestor: LexicalNode, node: LexicalNode): boolean {
  let current: LexicalNode | null = node
  while (current) {
    if (current.is(ancestor)) return true
    current = current.getParent()
  }
  return false
}

// Caret offset of a Lexical point inside `content`.
export function $offsetOfPoint(content: NoteContentNode, point: PointType): number {
  const node = point.getNode()
  const leaves = $inlineLeaves(content)
  if (point.type === 'text') {
    const leaf = leaves.find((candidate) => candidate.node.is(node))
    return leaf ? leaf.start + Math.min(point.offset, leaf.end - leaf.start) : 0
  }
  // Element point: before child `offset` of `node` (or at its end).
  if (!$isElementNode(node)) {
    const leaf = leaves.find((candidate) => candidate.node.is(node))
    return leaf ? (point.offset > 0 ? leaf.end : leaf.start) : 0
  }
  const children = node.getChildren()
  const boundary = children[point.offset]
  if (!boundary) {
    // End of `node`: after its last leaf.
    let end = 0
    for (const leaf of leaves) if (isAncestorOrSelf(node, leaf.node)) end = leaf.end
    if (node.is(content)) return leaves.length > 0 ? leaves[leaves.length - 1].end : 0
    return end
  }
  const first = leaves.find((leaf) => isAncestorOrSelf(boundary, leaf.node))
  if (first) return first.start
  // Boundary without leaves (empty inline element): sum of leaves before it.
  let before = 0
  for (const leaf of leaves) {
    if (leaf.node.isBefore(boundary)) before = leaf.end
  }
  return before
}

export type PointSpec = { key: string; offset: number; type: 'text' | 'element' }

export function $publicOffset(content: NoteContentNode, offset: number): number {
  return offset - $inlineLeaves(content).filter((leaf) => $isNoteImageNode(leaf.node) && leaf.end <= offset).length
}

export function $internalOffset(content: NoteContentNode, offset: number): number {
  let internal = offset
  for (const leaf of $inlineLeaves(content)) {
    if ($isNoteImageNode(leaf.node) && leaf.start <= internal) internal += 1
  }
  return Math.min($caretLength(content), internal)
}

// Resolve a caret offset to a Lexical point, preferring text positions.
export function $pointAtOffset(content: NoteContentNode, target: number): PointSpec {
  const leaves = $inlineLeaves(content)
  let fallback: PointSpec | null = null
  for (const leaf of leaves) {
    if ($isTextNode(leaf.node)) {
      if (target >= leaf.start && target <= leaf.end) {
        // At a boundary between two text leaves prefer the earlier one, unless
        // it is inside a link and the next one is not (typing continues plain).
        return { key: leaf.node.getKey(), offset: target - leaf.start, type: 'text' }
      }
    } else if (target <= leaf.start) {
      const parent = leaf.node.getParentOrThrow()
      fallback = fallback ?? { key: parent.getKey(), offset: leaf.node.getIndexWithinParent(), type: 'element' }
      if (target === leaf.start) return fallback
    }
  }
  if (fallback) return fallback
  const last = leaves[leaves.length - 1]
  if (last && $isTextNode(last.node)) return { key: last.node.getKey(), offset: (last.node as TextNode).getTextContentSize(), type: 'text' }
  return { key: content.getKey(), offset: content.getChildrenSize(), type: 'element' }
}

// Remove the first `count` caret characters (markdown markers) from content.
export function $removeLeadingCharacters(content: NoteContentNode, count: number) {
  let remaining = count
  for (const leaf of $inlineLeaves(content)) {
    if (remaining <= 0) break
    const node = leaf.node
    if ($isTextNode(node)) {
      const length = node.getTextContentSize()
      if (length <= remaining) {
        remaining -= length
        node.remove()
      } else {
        node.spliceText(0, remaining, '', false)
        remaining = 0
      }
    } else if ($isLineBreakNode(node)) {
      remaining -= 1
      node.remove()
    }
  }
}
