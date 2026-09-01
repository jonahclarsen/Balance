export type CaretPoint = { node: Node; offset: number }

export function caretPointFromCoordinates(root: HTMLElement, clientX: number, clientY: number): CaretPoint | null {
  const rect = root.getBoundingClientRect()
  const x = Math.min(Math.max(clientX, rect.left + 1), rect.right - 1)
  const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1)
  const documentWithCaretAPI = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const position = documentWithCaretAPI.caretPositionFromPoint?.(x, y)
  const point = position
    ? { node: position.offsetNode, offset: position.offset }
    : (() => {
        const range = documentWithCaretAPI.caretRangeFromPoint?.(x, y)
        return range ? { node: range.startContainer, offset: range.startOffset } : null
      })()
  return point && root.contains(point.node) ? point : null
}

export function collapsedCaretClientX(root: HTMLElement): number | null {
  const selection = document.getSelection()
  if (!selection?.isCollapsed || selection.rangeCount === 0) return null

  const caret = selection.getRangeAt(0)
  if (!root.contains(caret.startContainer)) return null

  const direct = caret.getBoundingClientRect()
  if (direct.height > 0) return direct.left

  // Empty contenteditables have no text range to measure. Their content-box
  // edge is the visible caret column, including indentation applied by lists.
  if (!(root.textContent?.length ?? 0)) {
    const rect = root.getBoundingClientRect()
    const style = getComputedStyle(root)
    const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
    return rect.left + borderLeft + paddingLeft
  }

  const node = caret.startContainer
  const offset = caret.startOffset
  if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.length) return null

  const probe = document.createRange()
  if (offset < node.textContent.length) {
    probe.setStart(node, offset)
    probe.setEnd(node, offset + 1)
    return probe.getBoundingClientRect().left
  }

  probe.setStart(node, offset - 1)
  probe.setEnd(node, offset)
  return probe.getBoundingClientRect().right
}
