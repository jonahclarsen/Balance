type TextPiece = { node: Text; start: number; end: number }

// Every highlighted range slows painting on older WebKit, and nobody steps
// through more than this many matches.
export const maxFindMatches = 1000

// Keep offsets in the original UTF-16 text: lowercasing can change its length
// (for example, İ becomes i + a combining dot).
export function normalizeFindText(value: string) {
  let text = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const character of value) {
    const end = offset + character.length
    const normalized = /\s/u.test(character) ? ' ' : character.toLowerCase()
    if (normalized === ' ' && text.endsWith(' ')) {
      ends[ends.length - 1] = end
    } else {
      text += normalized
      for (let index = 0; index < normalized.length; index += 1) {
        starts.push(offset)
        ends.push(end)
      }
    }
    offset = end
  }
  return { text, starts, ends }
}

export function findTextRanges(root: HTMLElement, query: string): Range[] {
  const needle = normalizeFindText(query).text.trim()
  if (!needle) return []
  const ranges: Range[] = []
  let text = ''
  let pieces: TextPiece[] = []

  function flush() {
    if (ranges.length >= maxFindMatches) {
      text = ''
      pieces = []
      return
    }
    const normalized = normalizeFindText(text)
    let pieceIndex = 0
    let previousEnd = -1
    for (let index = normalized.text.indexOf(needle); index !== -1; index = normalized.text.indexOf(needle, index + needle.length)) {
      const start = normalized.starts[index]!
      const end = normalized.ends[index + needle.length - 1]!
      // A case expansion must not produce duplicate ranges for one character.
      if (start < previousEnd) continue
      while (pieces[pieceIndex] && pieces[pieceIndex]!.end <= start) pieceIndex += 1
      const startPiece = pieces[pieceIndex]
      while (pieces[pieceIndex] && pieces[pieceIndex]!.end < end) pieceIndex += 1
      const endPiece = pieces[pieceIndex]
      if (!startPiece || !endPiece || start < startPiece.start || end <= endPiece.start) continue
      const range = document.createRange()
      range.setStart(startPiece.node, start - startPiece.start)
      range.setEnd(endPiece.node, end - endPiece.start)
      if (range.getClientRects().length) ranges.push(range)
      if (ranges.length >= maxFindMatches) break
      previousEnd = end
    }
    text = ''
    pieces = []
  }

  function visit(node: Node) {
    if (node instanceof Text) {
      const start = text.length
      text += node.data
      pieces.push({ node, start, end: text.length })
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.matches('script, style, noscript, input, textarea, select, [hidden], [aria-hidden="true"], [inert]')) {
      flush()
      return
    }
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility !== 'visible' || style.contentVisibility === 'hidden') {
      flush()
      return
    }
    if (node.tagName === 'BR') {
      text += '\n'
      return
    }
    // Inline formatting belongs to the same phrase; separate paragraphs,
    // controls and task rows must never be accidentally concatenated.
    const boundary = style.display !== 'inline' && style.display !== 'contents'
    if (boundary) flush()
    for (const child of node.childNodes) visit(child)
    if (boundary) flush()
  }

  visit(root)
  flush()
  return ranges
}

// Like browser find, start from what is on screen instead of jumping to the top.
export function firstVisibleFindIndex(ranges: readonly Range[]) {
  if (!ranges.length) return -1
  const index = ranges.findIndex((range) => range.getBoundingClientRect().bottom > 0)
  return index === -1 ? 0 : index
}

export function scrollFindRangeIntoView(range: Range) {
  const element = range.startContainer.parentElement
  if (!element) return
  // Scroll the range, not the editor: a note can be much taller than its viewport.
  // Matches already in view stay put, so stepping through them does not jump.
  for (let container: HTMLElement | null = element; container; container = container.parentElement) {
    const style = getComputedStyle(container)
    const rect = range.getBoundingClientRect()
    const bounds = container.getBoundingClientRect()
    const zoom = container.currentCSSZoom || 1
    if (/(auto|scroll|overlay)/.test(style.overflowY) && container.scrollHeight > container.clientHeight
      && (rect.top < bounds.top || rect.bottom > bounds.bottom)) {
      container.scrollTop += (rect.top - bounds.top - (bounds.height - rect.height) / 2) / zoom
    }
    if (/(auto|scroll|overlay)/.test(style.overflowX) && container.scrollWidth > container.clientWidth
      && (rect.left < bounds.left || rect.right > bounds.right)) {
      container.scrollLeft += (rect.left - bounds.left - (bounds.width - rect.width) / 2) / zoom
    }
  }
  const rect = range.getBoundingClientRect()
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    window.scrollBy({ top: rect.top - (window.innerHeight - rect.height) / 2, behavior: 'instant' })
  }
}
