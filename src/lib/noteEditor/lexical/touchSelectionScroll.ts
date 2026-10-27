// Chrome on Android doesn't scroll while a selection handle is dragged, so a
// touch selection couldn't reach text past the visible part of the note
// (behind the keyboard, under the docked toolbar or off the screen). Scroll
// the note whenever the dragged end nears or passes a visible edge.

const EDGE = 40
const MAX_REVEAL = 160

export function scrollParent(node: HTMLElement): HTMLElement | null {
  let scroller = node.parentElement
  while (scroller && scroller !== document.scrollingElement) {
    if (['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)
      && scroller.scrollHeight > scroller.clientHeight) return scroller
    scroller = scroller.parentElement
  }
  return document.scrollingElement as HTMLElement | null
}

function pointRect(node: Node, offset: number): DOMRect | null {
  const range = document.createRange()
  range.setStart(node, offset)
  const rect = range.getClientRects()[0]
  if (rect?.height) return rect
  const child = node.childNodes[offset] ?? node.childNodes[offset - 1] ?? node
  const element = child instanceof Element ? child : child.parentElement
  const box = element?.getBoundingClientRect()
  return box?.height ? box : null
}

// The part of the scroller the reader can see, excluding the keyboard and the
// sticky or keyboard-docked formatting toolbar.
function visibleBounds(root: HTMLElement, scroller: HTMLElement) {
  const viewport = window.visualViewport
  const box = scroller === document.scrollingElement
    ? { top: 0, bottom: window.innerHeight }
    : scroller.getBoundingClientRect()
  let top = Math.max(box.top, viewport?.offsetTop ?? 0)
  let bottom = Math.min(box.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight))
  const noteDocument = root.closest('.note-document')
  for (const toolbar of document.querySelectorAll<HTMLElement>('[data-note-editor-toolbar]')) {
    const position = getComputedStyle(toolbar).position
    if (position === 'fixed') bottom = Math.min(bottom, toolbar.getBoundingClientRect().top)
    else if (position === 'sticky' && noteDocument?.contains(toolbar)) top = Math.max(top, toolbar.getBoundingClientRect().bottom)
  }
  return { top, bottom }
}

export function touchSelectionScroll(root: HTMLElement): () => void {
  let touch = false
  let anchor: [Node | null, number] = [null, 0]
  let focus: [Node | null, number] = [null, 0]
  let scroller: HTMLElement | null = null
  let target = 0
  let frame: number | null = null

  function step() {
    frame = null
    if (!scroller) return
    const remaining = target - scroller.scrollTop
    const before = scroller.scrollTop
    scroller.scrollTop += Math.abs(remaining) < 2 ? remaining : remaining * 0.3
    // Stop at the end of the note, where scrollTop can no longer move.
    if (Math.abs(target - scroller.scrollTop) >= 1 && scroller.scrollTop !== before) frame = requestAnimationFrame(step)
  }

  function onPointerDown(event: PointerEvent) {
    touch = event.pointerType !== 'mouse'
  }

  function onSelectionChange() {
    const selection = document.getSelection()
    const previousAnchor = anchor
    const previousFocus = focus
    anchor = [selection?.anchorNode ?? null, selection?.anchorOffset ?? 0]
    focus = [selection?.focusNode ?? null, selection?.focusOffset ?? 0]
    if (!touch || !selection || selection.isCollapsed || !selection.focusNode || !root.contains(selection.focusNode)) return
    const moved = focus[0] !== previousFocus[0] || focus[1] !== previousFocus[1] ? focus
      : anchor[0] !== previousAnchor[0] || anchor[1] !== previousAnchor[1] ? anchor
        : null
    if (!moved?.[0]) return
    const rect = pointRect(moved[0], moved[1])
    scroller = scrollParent(root)
    if (!rect || !scroller) return
    const { top, bottom } = visibleBounds(root, scroller)
    const reveal = Math.max(EDGE + 16, Math.min(MAX_REVEAL, (bottom - top) / 4))
    let delta = 0
    if (rect.bottom > bottom - EDGE) delta = rect.bottom - (bottom - reveal)
    else if (rect.top < top + EDGE) delta = rect.top - (top + reveal)
    if (!delta) return
    target = scroller.scrollTop + delta / (scroller.currentCSSZoom || 1)
    if (frame === null) frame = requestAnimationFrame(step)
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('selectionchange', onSelectionChange)
  return () => {
    if (frame !== null) cancelAnimationFrame(frame)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('selectionchange', onSelectionChange)
  }
}
