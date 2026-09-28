// Tree helpers and structural edits over the Notes block tree. All functions
// run inside an editor update/read. Semantics follow docs/notes-contract.md
// (1.4 store functions, P-21..P-27, P-39).

import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type LexicalNode,
  type PointType,
  type RangeSelection,
} from 'lexical'
import type { NoteItemKind } from '../../types'
import {
  $caretLength,
  $offsetOfPoint,
  $pointAtOffset,
} from './inline'
import {
  $createNoteBlockNode,
  $createNoteChildrenNode,
  $createNoteContentNode,
  $isNoteBlockNode,
  $isNoteChildrenNode,
  $isNoteContentNode,
  NoteBlockNode,
  NoteContentNode,
  type NoteChildrenNode,
} from './nodes'

export function $contentOf(block: NoteBlockNode): NoteContentNode {
  const first = block.getFirstChild()
  if ($isNoteContentNode(first)) return first
  const content = $createNoteContentNode()
  if (first) first.insertBefore(content)
  else block.append(content)
  return content
}

export function $childrenContainerOf(block: NoteBlockNode): NoteChildrenNode | null {
  const last = block.getLastChild()
  return $isNoteChildrenNode(last) ? last : null
}

export function $childBlocks(block: NoteBlockNode): NoteBlockNode[] {
  return ($childrenContainerOf(block)?.getChildren() ?? []).filter($isNoteBlockNode)
}

export function $rootBlocks(): NoteBlockNode[] {
  return $getRoot().getChildren().filter($isNoteBlockNode)
}

// Visual (pre-order) list of every block.
export function $blocksInOrder(): NoteBlockNode[] {
  const out: NoteBlockNode[] = []
  const walk = (blocks: NoteBlockNode[]) => {
    for (const block of blocks) {
      out.push(block)
      walk($childBlocks(block))
    }
  }
  walk($rootBlocks())
  return out
}

export function $blockOf(node: LexicalNode | null | undefined): NoteBlockNode | null {
  let current: LexicalNode | null | undefined = node
  while (current) {
    if ($isNoteContentNode(current)) {
      const parent = current.getParent()
      return $isNoteBlockNode(parent) ? parent : null
    }
    if ($isNoteBlockNode(current)) return current
    current = current.getParent()
  }
  return null
}

export function $parentBlock(block: NoteBlockNode): NoteBlockNode | null {
  const container = block.getParent()
  if (!$isNoteChildrenNode(container)) return null
  const parent = container.getParent()
  return $isNoteBlockNode(parent) ? parent : null
}

export function $depthOf(block: NoteBlockNode): number {
  let depth = 0
  for (let parent = $parentBlock(block); parent; parent = $parentBlock(parent)) depth += 1
  return depth
}

export function $appendChildBlocks(parent: NoteBlockNode, blocks: NoteBlockNode[]) {
  if (blocks.length === 0) return
  let container = $childrenContainerOf(parent)
  if (!container) {
    container = $createNoteChildrenNode()
    parent.append(container)
  }
  container.append(...blocks)
}

export function $prependChildBlocks(parent: NoteBlockNode, blocks: NoteBlockNode[]) {
  if (blocks.length === 0) return
  const container = $childrenContainerOf(parent)
  const first = container?.getFirstChild()
  if (!container || !first) {
    $appendChildBlocks(parent, blocks)
    return
  }
  for (const block of blocks) first.insertBefore(block)
}

// Removes a children container once it has no blocks left.
export function $pruneContainer(container: LexicalNode | null) {
  if ($isNoteChildrenNode(container) && container.getChildrenSize() === 0) container.remove()
}

export function $removeBlock(block: NoteBlockNode) {
  const container = block.getParent()
  block.remove()
  $pruneContainer(container)
}

// deletePlanItemPreservingChildren: children join the previous sibling, or
// take the block's place when it has none.
export function $removeBlockKeepingChildren(block: NoteBlockNode) {
  const children = $childBlocks(block)
  const previous = block.getPreviousSibling()
  if ($isNoteBlockNode(previous)) $appendChildBlocks(previous, children)
  else for (const child of children) block.insertBefore(child)
  $removeBlock(block)
}

export function $createBlock(kind: NoteItemKind, done = false): NoteBlockNode {
  const block = $createNoteBlockNode(kind, done, null)
  block.append($createNoteContentNode())
  return block
}

export function $selectOffset(block: NoteBlockNode, start: number, end = start): RangeSelection {
  const content = $contentOf(block)
  const a = $pointAtOffset(content, start)
  const b = end === start ? a : $pointAtOffset(content, end)
  const selection = $createRangeSelection()
  selection.anchor.set(a.key, a.offset, a.type)
  selection.focus.set(b.key, b.offset, b.type)
  $setSelection(selection)
  return selection
}

export function $selectEnd(block: NoteBlockNode) {
  const length = $caretLength($contentOf(block))
  return $selectOffset(block, length)
}

export type BlockPoint = { block: NoteBlockNode; offset: number }

export function $blockPoint(point: PointType): BlockPoint | null {
  const block = $blockOf(point.getNode())
  if (!block) return null
  const content = $contentOf(block)
  // A point on the block/children container itself (rare) maps to an edge.
  const node = point.getNode()
  if ($isNoteBlockNode(node) || $isNoteChildrenNode(node)) return { block, offset: point.offset === 0 ? 0 : $caretLength(content) }
  return { block, offset: $offsetOfPoint(content, point) }
}

// Selection start/end as (block, offset), in document order.
export function $selectionEdges(selection: RangeSelection): { start: BlockPoint; end: BlockPoint; anchor: BlockPoint; focus: BlockPoint } | null {
  const anchor = $blockPoint(selection.anchor)
  const focus = $blockPoint(selection.focus)
  if (!anchor || !focus) return null
  const backward = anchor.block.is(focus.block) ? anchor.offset > focus.offset : focus.block.isBefore(anchor.block)
  return backward ? { start: focus, end: anchor, anchor, focus } : { start: anchor, end: focus, anchor, focus }
}

export function $currentRange(): RangeSelection | null {
  const selection = $getSelection()
  return $isRangeSelection(selection) ? selection : null
}

// Blocks from `from` to `to` inclusive in visual order.
export function $blocksBetween(from: NoteBlockNode, to: NoteBlockNode): NoteBlockNode[] {
  const order = $blocksInOrder()
  const a = order.findIndex((block) => block.is(from))
  const b = order.findIndex((block) => block.is(to))
  if (a === -1 || b === -1) return []
  return order.slice(Math.min(a, b), Math.max(a, b) + 1)
}

// Removes the caret-offset range [from, to) from a block's inline content.
export function $removeInlineRange(block: NoteBlockNode, from: number, to: number) {
  if (to <= from) return
  const content = $contentOf(block)
  const a = $pointAtOffset(content, from)
  const b = $pointAtOffset(content, to)
  const selection = $createRangeSelection()
  selection.anchor.set(a.key, a.offset, a.type)
  selection.focus.set(b.key, b.offset, b.type)
  $setSelection(selection)
  selection.removeText()
}

// Moves the inline content of `source` to the end of `target`.
export function $appendInline(target: NoteBlockNode, source: NoteBlockNode) {
  const into = $contentOf(target)
  const nodes = $contentOf(source).getChildren()
  if (nodes.length > 0) into.append(...nodes)
}

// Merge `source` into `target` (backspaceNoteItemAtStart semantics): target
// keeps its kind; inline content is appended; source's children are appended
// to target's children. Returns the join offset.
export function $mergeBlocks(target: NoteBlockNode, source: NoteBlockNode): number {
  const join = $caretLength($contentOf(target))
  $appendInline(target, source)
  $appendChildBlocks(target, $childBlocks(source))
  $removeBlock(source)
  $selectOffset(target, join)
  return join
}

// Cross-block range deletion (P-39, text semantics): the start block keeps
// its kind, the tail of the end block joins it, and blocks in between are
// removed with their children hoisted. Leaves a collapsed caret at the join.
export function $deleteTextRange(start: BlockPoint, end: BlockPoint): BlockPoint {
  if (start.block.is(end.block)) {
    $removeInlineRange(start.block, start.offset, end.offset)
    $selectOffset(start.block, start.offset)
    return { block: start.block, offset: start.offset }
  }
  const between = $blocksBetween(start.block, end.block).slice(1)
  $removeInlineRange(end.block, 0, end.offset)
  $removeInlineRange(start.block, start.offset, $caretLength($contentOf(start.block)))
  $appendInline(start.block, end.block)
  for (const block of between) {
    if (block.isAttached()) $removeBlockKeepingChildren(block)
  }
  $selectOffset(start.block, start.offset)
  return { block: start.block, offset: start.offset }
}

// Row deletion (P-39 row selection): removes rows with their subtrees and
// returns the block that should take the caret (end of the block now at the
// first deleted index), or null when the note became empty.
export function $deleteRows(rows: NoteBlockNode[]): NoteBlockNode | null {
  const order = $blocksInOrder()
  const firstIndex = order.findIndex((block) => block.is(rows[0]))
  for (const row of rows) if (row.isAttached()) $removeBlock(row)
  const after = $blocksInOrder()
  if (after.length === 0) {
    $setSelection(null)
    return null
  }
  const target = after[Math.min(Math.max(0, firstIndex), after.length - 1)]
  $selectEnd(target)
  return target
}

// Indent (P-26): become the last child of the previous sibling.
export function $indentBlock(block: NoteBlockNode): boolean {
  const previous = block.getPreviousSibling()
  if (!$isNoteBlockNode(previous)) return false
  const container = block.getParent()
  $appendChildBlocks(previous, [block])
  $pruneContainer(container)
  return true
}

// Outdent (P-26): move after the parent; following siblings become children.
export function $outdentBlock(block: NoteBlockNode): boolean {
  const parent = $parentBlock(block)
  if (!parent) return false
  const container = block.getParent()
  const following = block.getNextSiblings().filter($isNoteBlockNode)
  parent.insertAfter(block)
  $appendChildBlocks(block, following)
  $pruneContainer(container)
  return true
}

// Alt+Up/Down (P-27): swap with the adjacent sibling in the same level.
export function $moveBlock(block: NoteBlockNode, direction: 'up' | 'down'): boolean {
  if (direction === 'up') {
    const previous = block.getPreviousSibling()
    if (!$isNoteBlockNode(previous)) return false
    previous.insertBefore(block)
  } else {
    const next = block.getNextSibling()
    if (!$isNoteBlockNode(next)) return false
    next.insertAfter(block)
  }
  return true
}

export function $ensureAtLeastOneBlock(): NoteBlockNode {
  const first = $rootBlocks()[0]
  if (first) return first
  const block = $createBlock('paragraph')
  $getRoot().append(block)
  return block
}
