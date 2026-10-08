// Keeps the text caret visible above the on-screen keyboard on mobile.
//
// The browser only reveals a newly focused field, and it does so before the
// keyboard has finished resizing the viewport. This module fills that gap with
// the conventional pattern: reveal the caret when the keyboard appears or
// changes size, and after each edit or caret key press. It never reacts to
// scrolling, so the user can always scroll the caret off screen and keep
// reading; the next keystroke brings it back.

const textInputTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])
const KEYBOARD_MIN_HEIGHT = 100
const CARET_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
])

type PaddedScroller = { value: string; priority: string; base: number; applied: number }

function activeEditor(): HTMLElement | null {
  const element = document.activeElement
  if (element instanceof HTMLTextAreaElement) return element.disabled || element.readOnly ? null : element
  if (element instanceof HTMLInputElement) {
    return !element.disabled && !element.readOnly && textInputTypes.has(element.type) ? element : null
  }
  return element instanceof HTMLElement && element.isContentEditable ? element : null
}

function caretRect(editor: HTMLElement): DOMRect {
  if (editor.isContentEditable) {
    const selection = document.getSelection()
    if (selection?.focusNode && editor.contains(selection.focusNode)) {
      const caret = document.createRange()
      caret.setStart(selection.focusNode, selection.focusOffset)
      caret.collapse(true)
      const rect = caret.getClientRects()[0]
      if (rect?.height) return rect
      const block = selection.focusNode instanceof HTMLElement ? selection.focusNode : selection.focusNode.parentElement
      if (block && block !== editor && !block.textContent) return block.getBoundingClientRect()
    }
  }
  if (editor instanceof HTMLTextAreaElement) {
    // A textarea can be taller than the remaining viewport. Measure its caret
    // without changing the value, selection, focus, or composition in progress.
    const style = getComputedStyle(editor)
    const mirror = document.createElement('div')
    for (const property of style) mirror.style.setProperty(property, style.getPropertyValue(property))
    Object.assign(mirror.style, {
      position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
      left: '0', top: '0', height: 'auto', minHeight: '0', maxHeight: 'none',
      overflow: 'hidden', whiteSpace: editor.wrap === 'off' ? 'pre' : 'pre-wrap',
    })
    mirror.textContent = editor.value.slice(0, editor.selectionEnd)
    const marker = document.createElement('span')
    marker.textContent = editor.value.slice(editor.selectionEnd) || '​'
    mirror.append(marker)
    editor.parentElement!.append(mirror)
    const markerRect = marker.getClientRects()[0]
    const mirrorRect = mirror.getBoundingClientRect()
    const editorRect = editor.getBoundingClientRect()
    const zoom = editor.currentCSSZoom || 1
    const top = markerRect.top - mirrorRect.top + editorRect.top - editor.scrollTop * zoom
    const rect = new DOMRect(editorRect.left, top, 1, markerRect.height)
    mirror.remove()
    return rect
  }
  return editor.getBoundingClientRect()
}

// The scroll containers between the editor and the viewport, innermost first.
// Editing inside a fixed panel (dialogs, the Notes toolbar) never scrolls the
// page behind it.
function scrollersFor(editor: HTMLElement, padded: Map<HTMLElement, PaddedScroller>): HTMLElement[] {
  const root = document.scrollingElement as HTMLElement
  const scrollers: HTMLElement[] = []
  for (let ancestor = editor.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    if (/(auto|scroll|overlay)/.test(style.overflowY) &&
        (ancestor.scrollHeight > ancestor.clientHeight || padded.has(ancestor))) scrollers.push(ancestor)
    if (style.position === 'fixed') return scrollers
  }
  scrollers.push(root)
  return scrollers
}

export function installMobileKeyboardScroll(): () => void {
  const viewport = window.visualViewport
  const mobile = window.matchMedia('(pointer: coarse)')
  let fullHeight = window.innerHeight
  let fullWidth = window.innerWidth
  let frame: number | null = null
  let paddedEditor: HTMLElement | null = null
  const padded = new Map<HTMLElement, PaddedScroller>()

  function restorePadding() {
    for (const [element, original] of padded) {
      if (original.value) element.style.setProperty('padding-bottom', original.value, original.priority)
      else element.style.removeProperty('padding-bottom')
    }
    padded.clear()
    paddedEditor = null
  }

  function keyboardGeometry() {
    if (window.innerWidth !== fullWidth) {
      fullWidth = window.innerWidth
      fullHeight = window.innerHeight
    }
    fullHeight = Math.max(fullHeight, window.innerHeight)
    const height = viewport?.height ?? window.innerHeight
    const zoomed = Boolean(viewport && Math.abs(viewport.scale - 1) > 0.01)
    if (!mobile.matches || zoomed || fullHeight - height < KEYBOARD_MIN_HEIGHT) return null
    return { top: viewport?.offsetTop ?? 0, bottom: (viewport?.offsetTop ?? 0) + height }
  }

  function reveal() {
    frame = null
    const editor = activeEditor()
    const geometry = keyboardGeometry()
    if (!editor || !geometry) {
      restorePadding()
      return
    }
    if (paddedEditor !== editor) restorePadding()
    paddedEditor = editor

    let { top, bottom } = geometry
    const header = document.querySelector<HTMLElement>('.mobile-app-header')?.getBoundingClientRect()
    if (header && header.top <= top + 1 && header.bottom > top) top = header.bottom
    const toolbar = document.querySelector<HTMLElement>('.note-format-toolbar')
    if (editor.matches('[data-note-text-input]') && toolbar && getComputedStyle(toolbar).position === 'fixed') {
      bottom = Math.min(bottom, toolbar.getBoundingClientRect().top)
    }
    // Keep a comfortable gap without consuming most of a short landscape view.
    const gap = Math.min(64, Math.max(16, (bottom - top) * 0.18))
    top += 16
    bottom -= gap
    if (bottom <= top) return

    for (const scroller of scrollersFor(editor, padded)) {
      const root = scroller === document.scrollingElement
      const zoom = scroller.currentCSSZoom || 1
      const bounds = scroller.getBoundingClientRect()
      const scrollBottom = root ? window.innerHeight : bounds.bottom
      // Extra scroll room lets the last fields on a page rise above the
      // keyboard, including in dialogs whose layout did not shrink with it.
      let entry = padded.get(scroller)
      if (!entry) {
        entry = {
          value: scroller.style.getPropertyValue('padding-bottom'),
          priority: scroller.style.getPropertyPriority('padding-bottom'),
          base: parseFloat(getComputedStyle(scroller).paddingBottom) || 0,
          applied: Number.NaN,
        }
        padded.set(scroller, entry)
      }
      const extra = Math.round(Math.max(gap, scrollBottom - bottom) / zoom)
      if (entry.applied !== extra) {
        entry.applied = extra
        scroller.style.setProperty('padding-bottom', `${entry.base + extra}px`)
      }

      const rect = caretRect(editor)
      const visibleTop = root ? top : Math.max(top, bounds.top + scroller.clientTop * zoom + 16)
      const visibleBottom = root ? bottom : Math.min(bottom, bounds.bottom - 16)
      if (visibleBottom <= visibleTop) continue
      const delta = rect.bottom > visibleBottom ? rect.bottom - visibleBottom
        : rect.top < visibleTop ? rect.top - visibleTop : 0
      if (Math.abs(delta) > 1) scroller.scrollBy({ top: delta / zoom, behavior: 'instant' })
    }
  }

  function schedule() {
    // Two frames let Svelte lay out newly focused fields and the Notes toolbar
    // finish docking before measuring, and coalesce keyboard animation events.
    if (frame === null) frame = requestAnimationFrame(() => { frame = requestAnimationFrame(reveal) })
  }
  function handleInput(event: Event) {
    const editor = activeEditor()
    if (editor && event.target instanceof Node && editor.contains(event.target)) schedule()
  }
  function handleKeydown(event: KeyboardEvent) {
    if (CARET_KEYS.has(event.key) && activeEditor()) schedule()
  }

  document.addEventListener('focusin', schedule)
  document.addEventListener('focusout', schedule)
  document.addEventListener('input', handleInput)
  document.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', schedule)
  viewport?.addEventListener('resize', schedule)
  return () => {
    if (frame !== null) cancelAnimationFrame(frame)
    restorePadding()
    document.removeEventListener('focusin', schedule)
    document.removeEventListener('focusout', schedule)
    document.removeEventListener('input', handleInput)
    document.removeEventListener('keydown', handleKeydown)
    window.removeEventListener('resize', schedule)
    viewport?.removeEventListener('resize', schedule)
  }
}
