// A pinned parent row keeps at most its first three lines in view, and the
// whole pinned stack at most five, taking lines from the deepest rows first
// (every pinned row keeps at least one). A row's height in the stack is those
// lines, and while it is pinned the rest of a wrapped row is clipped away just
// above its first child, so the children scroll up into view instead of
// passing under the parent's remaining text. A pinned row whose text goes on
// past its retained lines fades out the end of the last one.

const maxRowLines = 3
const maxStackLines = 5
const shellSelector = '.item-shell, .template-item'
const textClipProperty = '--tree-sticky-text-clip'
const clipProperty = '--tree-sticky-clip'
const clipLimitProperty = '--tree-sticky-clip-limit'
const heightProperty = '--tree-sticky-height'
const fadeTopProperty = '--tree-sticky-fade-top'
const fadeEndProperty = '--tree-sticky-fade-end'

type StickyRow = {
  shell: HTMLElement
  row: HTMLElement
  property: string
  fullHeight: number
  // The row's height with its text cut to one, two, or three lines.
  lineHeights: number[]
  lineCount: number
  text: HTMLElement | null
  textBottom: number
  textLineBottoms: number[]
  // Each line's top and right end, relative to the text box.
  textLineTops: number[]
  textLineRights: number[]
  fadeLine: number
  belowText: number
  tail: HTMLElement | null
  textClip: number
  published: number | null
  clipLimit: number
  clip: number
}

const stickyRows = new Map<HTMLElement, StickyRow>()
const wrappedRows = new Set<StickyRow>()
let clipFrame = 0

// Screen pixels per CSS pixel. Browser development zooms the app with CSS, so
// layout rects and CSS lengths differ there.
function rowScale(row: HTMLElement, rowRect = row.getBoundingClientRect()) {
  return row.offsetHeight ? rowRect.height / row.offsetHeight : 1
}

// The extent of each text line. Only text boxes count, so
// block wrappers inside the editor do not merge lines.
function textLines(text: HTMLElement) {
  const lines: { top: number; bottom: number; right: number }[] = []
  const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node)
    for (const rect of range.getClientRects()) {
      if (rect.height === 0) continue
      const last = lines.at(-1)
      if (last && rect.top < last.bottom - 1) {
        last.bottom = Math.max(last.bottom, rect.bottom)
        last.right = Math.max(last.right, rect.right)
      } else lines.push({ top: rect.top, bottom: rect.bottom, right: rect.right })
    }
  }
  return lines
}

// Generated list rows show static text instead of an editor.
function measure(entry: StickyRow) {
  const { row } = entry
  entry.fullHeight = row.offsetHeight
  entry.lineHeights = []
  entry.lineCount = 0
  const text = row.querySelector<HTMLElement>('[data-rich-text-input], .item-text-display')
  if (text !== entry.text) {
    setFadeLine(entry, -1)
    entry.text = text
  }
  if (!text) return
  const lines = textLines(text)
  const bottoms = lines.map((line) => line.bottom)
  // Keep the text's bottom padding and any row chrome below the text.
  const rowRect = row.getBoundingClientRect()
  const scale = rowScale(row, rowRect)
  const textRect = text.getBoundingClientRect()
  // A one-line parent still needs room for its checkbox and action buttons.
  // Clipping to text alone can cut taller controls after typography changes.
  const rowStyle = getComputedStyle(row)
  const controlHeight = Math.max(0, ...Array.from(
    row.querySelectorAll<HTMLElement>(':scope > button, :scope > .check-target, :scope > .row-actions'),
    control => control.getBoundingClientRect().height / scale,
  ))
  const minimumHeight = controlHeight + parseFloat(rowStyle.paddingTop) + parseFloat(rowStyle.paddingBottom)
    + parseFloat(rowStyle.borderTopWidth) + parseFloat(rowStyle.borderBottomWidth)
  const below = parseFloat(getComputedStyle(text).paddingBottom) * scale + Math.max(0, rowRect.bottom - textRect.bottom)
  // Narrow rows wrap goal badges below the editor. Keep that trailing content
  // with the shrinking text instead of leaving its reserved space empty.
  const tail = row.querySelector<HTMLElement>(':scope > .plan-goal-badges')
  const belowTextTail = tail && tail.offsetTop >= (textRect.bottom - rowRect.top) / scale - 0.5 ? tail : null
  if (entry.tail !== belowTextTail) entry.tail?.style.removeProperty('--tree-sticky-tail-shift')
  entry.tail = belowTextTail
  entry.tail?.style.setProperty('--tree-sticky-tail-shift', `${entry.clip}px`)
  entry.textBottom = (textRect.bottom - rowRect.top) / scale
  entry.textLineBottoms = bottoms.map((bottom) => (bottom - rowRect.top) / scale)
  entry.textLineTops = lines.map((line) => (line.top - textRect.top) / scale)
  entry.textLineRights = lines.map((line) => (line.right - textRect.left) / scale)
  // Line positions moved, so the next clip update rewrites the fade.
  entry.fadeLine = -2
  entry.belowText = below / scale
  entry.lineCount = bottoms.length
  entry.lineHeights = bottoms.slice(0, maxRowLines).map((bottom) => (
    Math.min(entry.fullHeight, Math.max(Math.ceil(minimumHeight), Math.ceil((bottom - rowRect.top + below) / scale)))
  ))
}

function nearestStickyAncestor(entry: StickyRow) {
  for (let shell = entry.shell.parentElement?.closest<HTMLElement>(shellSelector); shell; shell = shell.parentElement?.closest<HTMLElement>(shellSelector)) {
    const ancestor = stickyRows.get(shell)
    if (ancestor) return ancestor
  }
  return null
}

// Gives each row its share of the stack's lines and publishes its height.
function layoutStack() {
  const stackLines = new Map<StickyRow, number>()
  const ownLines = new Map<StickyRow, number>()
  const linesThrough = (entry: StickyRow): number => {
    const known = stackLines.get(entry)
    if (known !== undefined) return known
    const ancestor = nearestStickyAncestor(entry)
    const above = ancestor ? linesThrough(ancestor) : 0
    const own = Math.min(maxRowLines, Math.max(1, maxStackLines - above))
    ownLines.set(entry, own)
    stackLines.set(entry, above + Math.min(own, Math.max(1, entry.lineCount)))
    return stackLines.get(entry)!
  }
  for (const entry of stickyRows.values()) {
    linesThrough(entry)
    if (entry.fullHeight === 0) continue
    const own = ownLines.get(entry)!
    const height = entry.lineCount > own ? entry.lineHeights[own - 1] : entry.fullHeight
    if (height !== entry.published) {
      entry.published = height
      entry.shell.style.setProperty(entry.property, `${height}px`)
      entry.shell.style.setProperty(heightProperty, `${height}px`)
    }
    if (entry.fullHeight - height !== entry.clipLimit) {
      entry.clipLimit = entry.fullHeight - height
      // Set on the shell for both the row and its children, and set even when
      // zero so nested rows do not inherit an ancestor's limit.
      entry.shell.style.setProperty(clipLimitProperty, `${entry.clipLimit}px`)
    }
    setWrapped(entry, entry.clipLimit > 0)
  }
  if (wrappedRows.size) scheduleClipUpdate()
}

function updateClips() {
  clipFrame = 0
  const entries = [...wrappedRows]
  // Read every displacement before writing any clip.
  const clips = entries.map((entry) => {
    const rowRect = entry.row.getBoundingClientRect()
    const pinnedBy = (rowRect.top - entry.shell.getBoundingClientRect().top) / rowScale(entry.row, rowRect)
    return Math.round(Math.min(entry.clipLimit, Math.max(0, pinnedBy)))
  })
  entries.forEach((entry, index) => setClip(entry, clips[index]))
}

function scheduleClipUpdate() {
  if (!clipFrame) clipFrame = requestAnimationFrame(updateClips)
}

function setClip(entry: StickyRow, clip: number) {
  if (clip !== entry.clip) {
    entry.clip = clip
    entry.tail?.style.setProperty('--tree-sticky-tail-shift', `${clip}px`)
    if (clip > 0) entry.row.style.setProperty(clipProperty, `${clip}px`)
    else entry.row.style.removeProperty(clipProperty)
  }
  // The paper edge moves continuously with the children, but text disappears
  // one complete line at a time. Padding below the final retained line must
  // never expose the top of the next line (even when fully pinned).
  const available = entry.fullHeight - clip - entry.belowText
  const lastIndex = entry.textLineBottoms.findLastIndex((bottom) => bottom <= available + 0.5)
  const lastLine = entry.textLineBottoms[lastIndex] ?? 0
  const textClip = clip > 0 ? Math.max(0, entry.textBottom - lastLine) : 0
  if (textClip !== entry.textClip) {
    entry.textClip = textClip
    if (textClip > 0) entry.text?.style.setProperty(textClipProperty, `${textClip}px`)
    else entry.text?.style.removeProperty(textClipProperty)
  }
  setFadeLine(entry, clip > 0 && lastIndex >= 0 && lastIndex < entry.lineCount - 1 ? lastIndex : -1)
}

// Fades the end of the last retained line so a cut-off parent reads as
// continuing rather than ending mid-sentence.
function setFadeLine(entry: StickyRow, line: number) {
  if (line === entry.fadeLine) return
  entry.fadeLine = line
  const style = entry.text?.style
  if (!style) return
  if (line < 0) {
    style.removeProperty(fadeTopProperty)
    style.removeProperty(fadeEndProperty)
    return
  }
  style.setProperty(fadeTopProperty, `${entry.textLineTops[line]}px`)
  style.setProperty(fadeEndProperty, `${entry.textLineRights[line]}px`)
}

function setWrapped(entry: StickyRow, wrapped: boolean) {
  if (wrapped === wrappedRows.has(entry)) return
  if (wrapped) {
    if (wrappedRows.size === 0) document.addEventListener('scroll', scheduleClipUpdate, { capture: true, passive: true })
    wrappedRows.add(entry)
    return
  }
  wrappedRows.delete(entry)
  setClip(entry, 0)
  if (wrappedRows.size === 0) document.removeEventListener('scroll', scheduleClipUpdate, { capture: true })
}

let layoutQueued = false
function queueLayoutStack() {
  if (layoutQueued) return
  layoutQueued = true
  queueMicrotask(() => {
    layoutQueued = false
    layoutStack()
  })
}

let observer: ResizeObserver | null = null
const entriesByRow = new Map<Element, StickyRow>()

function rowsResized(changes: ResizeObserverEntry[]) {
  for (const change of changes) {
    const entry = entriesByRow.get(change.target)
    if (entry) measure(entry)
  }
  layoutStack()
}

// The bottom edge of what a pinned row still shows.
export function stickyRowVisibleBottom(row: Element) {
  const rowRect = row.getBoundingClientRect()
  if (!(row instanceof HTMLElement)) return rowRect.bottom
  return rowRect.bottom - (parseFloat(row.style.getPropertyValue(clipProperty)) || 0) * rowScale(row, rowRect)
}

// Publishes a sticky row's pinned height on its shell as `property`, so
// descendants stack below it, and clips the row while it is pinned.
export function trackStickyParentRow(shell: HTMLElement, row: HTMLElement, property: string) {
  const entry: StickyRow = {
    shell, row, property, fullHeight: 0, lineHeights: [], lineCount: 0, published: null, clipLimit: 0, clip: 0,
    text: null, textBottom: 0, textLineBottoms: [], textLineTops: [], textLineRights: [], fadeLine: -1,
    belowText: 0, tail: null, textClip: 0,
  }
  shell.style.setProperty(clipLimitProperty, '0px')
  stickyRows.set(shell, entry)
  entriesByRow.set(row, entry)
  observer ??= new ResizeObserver(rowsResized)
  observer.observe(row)
  return () => {
    observer?.unobserve(row)
    stickyRows.delete(shell)
    entriesByRow.delete(row)
    setWrapped(entry, false)
    entry.tail?.style.removeProperty('--tree-sticky-tail-shift')
    shell.style.removeProperty(clipLimitProperty)
    shell.style.removeProperty(property)
    shell.style.removeProperty(heightProperty)
    // Rows below this one may now have more lines to show.
    queueLayoutStack()
  }
}
