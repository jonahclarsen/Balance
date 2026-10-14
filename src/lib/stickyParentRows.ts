// A pinned parent row keeps only its first line in view. Its height for the
// stack is that one line, and while it is pinned the rest of a wrapped row is
// clipped away just above its first child, so the children scroll up into view
// instead of passing under several lines of parent text.

type StickyRow = { shell: HTMLElement; row: HTMLElement; clipLimit: number; clip: number }

const clipProperty = '--tree-sticky-clip'
const wrappedRows = new Set<StickyRow>()
let clipFrame = 0

// Screen pixels per CSS pixel. Browser development zooms the app with CSS, so
// layout rects and CSS lengths differ there.
function rowScale(row: HTMLElement, rowRect = row.getBoundingClientRect()) {
  return row.offsetHeight ? rowRect.height / row.offsetHeight : 1
}

// The row's height in CSS pixels with its text cut to the first line.
// Generated list rows show static text instead of an editor.
function pinnedHeight(row: HTMLElement) {
  const height = row.offsetHeight
  const text = row.querySelector<HTMLElement>('[data-rich-text-input], .item-text-display')
  if (!text) return height
  const range = document.createRange()
  range.selectNodeContents(text)
  const lines = [...range.getClientRects()].filter((rect) => rect.height > 0)
  if (lines.length === 0) return height
  const firstLineBottom = Math.max(...lines.filter((rect) => rect.top < lines[0].bottom - 1).map((rect) => rect.bottom))
  // Keep the text's bottom padding and any row chrome below the text.
  const rowRect = row.getBoundingClientRect()
  const textRect = text.getBoundingClientRect()
  const scale = rowScale(row, rowRect)
  const below = parseFloat(getComputedStyle(text).paddingBottom) * scale + Math.max(0, rowRect.bottom - textRect.bottom)
  return Math.min(height, Math.ceil((firstLineBottom - rowRect.top + below) / scale))
}

function updateClips() {
  clipFrame = 0
  // Read every displacement before writing any clip.
  const clips = [...wrappedRows].map((entry) => {
    const rowRect = entry.row.getBoundingClientRect()
    const pinnedBy = (rowRect.top - entry.shell.getBoundingClientRect().top) / rowScale(entry.row, rowRect)
    return Math.round(Math.min(entry.clipLimit, Math.max(0, pinnedBy)))
  })
  ;[...wrappedRows].forEach((entry, index) => setClip(entry, clips[index]))
}

function scheduleClipUpdate() {
  if (!clipFrame) clipFrame = requestAnimationFrame(updateClips)
}

function setClip(entry: StickyRow, clip: number) {
  if (clip === entry.clip) return
  entry.clip = clip
  if (clip > 0) entry.row.style.setProperty(clipProperty, `${clip}px`)
  else entry.row.style.removeProperty(clipProperty)
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

// The bottom edge of what a pinned row still shows.
export function stickyRowVisibleBottom(row: Element) {
  const rowRect = row.getBoundingClientRect()
  if (!(row instanceof HTMLElement)) return rowRect.bottom
  return rowRect.bottom - (parseFloat(row.style.getPropertyValue(clipProperty)) || 0) * rowScale(row, rowRect)
}

// Publishes a sticky row's pinned height on its shell as `property`, so
// descendants stack below it, and clips the row while it is pinned.
export function trackStickyParentRow(shell: HTMLElement, row: HTMLElement, property: string) {
  const entry: StickyRow = { shell, row, clipLimit: 0, clip: 0 }
  const observer = new ResizeObserver(() => {
    const height = pinnedHeight(row)
    shell.style.setProperty(property, `${height}px`)
    entry.clipLimit = row.offsetHeight - height
    setWrapped(entry, entry.clipLimit > 0)
    if (entry.clipLimit > 0) scheduleClipUpdate()
  })
  observer.observe(row)
  return () => {
    observer.disconnect()
    setWrapped(entry, false)
    shell.style.removeProperty(property)
  }
}
