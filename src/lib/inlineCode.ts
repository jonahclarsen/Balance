// Backticks format inline code: pressing ` over a selection toggles code, and
// typing `text` turns the span into code when the closing backtick lands.

export function isBacktickKey(event: KeyboardEvent): boolean {
  return !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 &&
    !event.metaKey && !event.ctrlKey && !event.altKey && event.key === '`'
}

// `before` is the text up to the caret, ending with the just-typed closing
// backtick; line breaks are "\n" and images U+FFFC. Returns the opening
// backtick's offset when `text` should become code. A double backtick before
// the opening one is left alone so code fences can still be typed.
export function inlineCodeOpening(before: string): number | null {
  if (!before.endsWith('`')) return null
  const open = before.lastIndexOf('`', before.length - 2)
  if (open < 0 || before[open - 1] === '`') return null
  const inner = before.slice(open + 1, -1)
  if (!inner.trim() || /[\n\uFFFC]/.test(inner)) return null
  return open
}

// ---------------------------------------------------------------------------
// Contenteditable editors (tasks, days, lists). Offsets count text characters
// plus one per <br> or image, like the editor's saved selections.
// ---------------------------------------------------------------------------

function caretText(parent: Node): string {
  let text = ''
  for (const node of Array.from(parent.childNodes)) {
    if (node instanceof Text) text += node.data
    else if (node.nodeName === 'BR') text += '\n'
    else if (node.nodeName === 'IMG') text += '\uFFFC'
    else text += caretText(node)
  }
  return text
}

function offsetOf(root: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange()
  range.selectNodeContents(root)
  range.setEnd(container, offset)
  return caretText(range.cloneContents()).length
}

function codeOf(root: HTMLElement, node: Node): HTMLElement | null {
  const code = (node instanceof Element ? node : node.parentElement)?.closest('code')
  return code instanceof HTMLElement && root.contains(code) ? code : null
}

function textSpans(root: HTMLElement): Array<{ node: Text; start: number }> {
  const spans: Array<{ node: Text; start: number }> = []
  let offset = 0
  const walk = (parent: Node) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node instanceof Text) {
        spans.push({ node, start: offset })
        offset += node.length
      } else if (node.nodeName === 'BR' || node.nodeName === 'IMG') offset += 1
      else walk(node)
    }
  }
  walk(root)
  return spans
}

// Splits text nodes so [start, end) is covered by whole nodes, and returns them.
function textNodesBetween(root: HTMLElement, start: number, end: number): Text[] {
  const nodes: Text[] = []
  for (const span of textSpans(root)) {
    const spanEnd = span.start + span.node.length
    if (spanEnd <= start || span.start >= end) continue
    let node = span.node
    if (start > span.start) node = node.splitText(start - span.start)
    const nodeStart = Math.max(start, span.start)
    if (end < spanEnd) node.splitText(end - nodeStart)
    if (node.length > 0) nodes.push(node)
  }
  return nodes
}

// A text position for `offset`; at a boundary between two text nodes, the
// earlier one ends a range and the later one starts it.
function pointAt(root: HTMLElement, offset: number, preferEarlier: boolean): { node: Node; offset: number } {
  const containing = textSpans(root).filter((span) => span.start <= offset && offset <= span.start + span.node.length)
  const span = (preferEarlier ? undefined : containing.find((candidate) => offset < candidate.start + candidate.node.length)) ?? containing[0]
  return span ? { node: span.node, offset: offset - span.start } : { node: root, offset: root.childNodes.length }
}

function wrapInCode(root: HTMLElement, nodes: Text[]) {
  for (const node of nodes) {
    if (codeOf(root, node)) continue
    const code = document.createElement('code')
    node.replaceWith(code)
    code.append(node)
  }
  for (const code of Array.from(root.querySelectorAll('code'))) {
    if (!code.isConnected) continue
    while (code.nextSibling instanceof HTMLElement && code.nextSibling.tagName === 'CODE') {
      const next = code.nextSibling
      code.append(...Array.from(next.childNodes))
      next.remove()
    }
  }
}

// Moves `node` out of its code element, keeping code on either side of it.
function unwrapFromCode(code: HTMLElement, node: Text) {
  const before = document.createRange()
  before.setStart(code, 0)
  before.setEndBefore(node)
  const after = document.createRange()
  after.setStartAfter(node)
  after.setEnd(code, code.childNodes.length)
  const tail = after.extractContents()
  const head = before.extractContents()
  for (const [part, insert] of [[head, 'before'], [tail, 'after']] as const) {
    if (!caretText(part)) continue
    const piece = document.createElement('code')
    piece.append(part)
    code[insert](piece)
  }
  code.replaceWith(...Array.from(code.childNodes))
}

// Backtick over a selection: code it, or uncode it when it is all code already.
export function toggleSelectionCode(root: HTMLElement): boolean {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return false
  const backward = selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset
  const start = offsetOf(root, range.startContainer, range.startOffset)
  const end = offsetOf(root, range.endContainer, range.endOffset)
  const nodes = textNodesBetween(root, start, end)
  if (nodes.length === 0) return false
  if (nodes.every((node) => codeOf(root, node))) {
    for (const node of nodes) unwrapFromCode(codeOf(root, node)!, node)
  } else wrapInCode(root, nodes)
  root.normalize()
  const a = pointAt(root, start, false)
  const b = pointAt(root, end, true)
  if (backward) selection.setBaseAndExtent(b.node, b.offset, a.node, a.offset)
  else selection.setBaseAndExtent(a.node, a.offset, b.node, b.offset)
  return true
}

// Called before a typed character is inserted. Returns true when it handled
// the input: a closing backtick turned `text` into code, or a character typed
// at the end of code went after it instead of extending it.
export function insertTextAroundCode(root: HTMLElement, data: string): boolean {
  const selection = document.getSelection()
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return false
  const code = codeOf(root, range.startContainer)
  // Ordinary text outside code needs no DOM clone or offset walk.
  if (!code && data !== '`') return false
  const caret = offsetOf(root, range.startContainer, range.startOffset)

  if (code) {
    if (offsetOf(root, code, code.childNodes.length) !== caret) return false
    const next = code.nextSibling
    const node = next instanceof Text ? next : document.createTextNode('')
    if (node !== next) code.after(node)
    // Like the browser, keep a space at the end of the line visible.
    const text = data === ' ' && node.length === 0 ? '\u00a0' : data
    node.insertData(0, text)
    selection.collapse(node, text.length)
    return true
  }

  if (data !== '`') return false
  const open = inlineCodeOpening(caretText(root).slice(0, caret) + data)
  if (open === null) return false
  const [opening] = textNodesBetween(root, open, open + 1)
  if (!opening || codeOf(root, opening)) return false
  opening.remove()
  wrapInCode(root, textNodesBetween(root, open, caret - 1))
  root.normalize()
  const end = pointAt(root, caret - 1, true)
  selection.collapse(end.node, end.offset)
  return true
}
