const textInputTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

function activeEditor(): HTMLElement | null {
  const element = document.activeElement
  if (element instanceof HTMLTextAreaElement) return element.disabled || element.readOnly ? null : element
  if (element instanceof HTMLInputElement) {
    return !element.disabled && !element.readOnly && textInputTypes.has(element.type) ? element : null
  }
  return element instanceof HTMLElement && element.isContentEditable ? element : null
}

function editingRect(editor: HTMLElement): DOMRect {
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
    marker.textContent = editor.value.slice(editor.selectionEnd) || '\u200b'
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

// One lifecycle for every editing surface, including dialogs and rich text.
// Native focus scrolling often runs before the IME finishes resizing/panning.
export function installMobileKeyboardScroll(): () => void {
  const viewport = window.visualViewport
  const mobile = window.matchMedia('(pointer: coarse)')
  let fullHeight = window.innerHeight
  let fullWidth = window.innerWidth
  let frame: number | null = null
  let paddedEditor: HTMLElement | null = null
  const padding = new Map<HTMLElement, { value: string; priority: string; base: number }>()

  function restorePadding() {
    for (const [element, original] of padding) {
      if (original.value) element.style.setProperty('padding-bottom', original.value, original.priority)
      else element.style.removeProperty('padding-bottom')
    }
    padding.clear()
    paddedEditor = null
  }

  function update() {
    frame = null
    if (window.innerWidth !== fullWidth) {
      fullWidth = window.innerWidth
      fullHeight = window.innerHeight
    }
    fullHeight = Math.max(fullHeight, window.innerHeight)
    const editor = activeEditor()
    const height = viewport?.height ?? window.innerHeight
    if (!mobile.matches || !editor || (viewport && Math.abs(viewport.scale - 1) > 0.01) || fullHeight - height < 100) {
      restorePadding()
      return
    }
    if (paddedEditor !== editor) restorePadding()
    paddedEditor = editor

    let top = viewport?.offsetTop ?? 0
    let bottom = top + height
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

    const root = document.scrollingElement as HTMLElement
    const scrollers: HTMLElement[] = []
    let insideFixedPanel = false
    for (let ancestor = editor.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      if (/(auto|scroll|overlay)/.test(style.overflowY) &&
          (ancestor.scrollHeight > ancestor.clientHeight || padding.has(ancestor))) scrollers.push(ancestor)
      if (style.position === 'fixed') {
        insideFixedPanel = true
        break
      }
    }
    if (!insideFixedPanel) scrollers.push(root)
    for (const scroller of scrollers) {
      const zoom = scroller.currentCSSZoom || 1
      const bounds = scroller.getBoundingClientRect()
      const scrollBottom = scroller === root ? window.innerHeight : bounds.bottom
      if (!padding.has(scroller)) {
        padding.set(scroller, {
          value: scroller.style.getPropertyValue('padding-bottom'),
          priority: scroller.style.getPropertyPriority('padding-bottom'),
          base: parseFloat(getComputedStyle(scroller).paddingBottom) || 0,
        })
      }
      // Extra scroll room is essential for the last field on short pages and
      // for dialogs whose layout viewport did not shrink with the keyboard.
      scroller.style.setProperty('padding-bottom', `${padding.get(scroller)!.base + Math.max(gap, scrollBottom - bottom) / zoom}px`)
      const rect = editingRect(editor)
      const visibleTop = Math.max(top, scroller === root ? top : bounds.top + scroller.clientTop * zoom + 16)
      const visibleBottom = Math.min(bottom, scroller === root ? bottom : bounds.bottom - 16)
      if (visibleBottom <= visibleTop) continue
      const delta = rect.bottom > visibleBottom ? rect.bottom - visibleBottom
        : rect.top < visibleTop ? rect.top - visibleTop : 0
      if (Math.abs(delta) > 1) scroller.scrollBy({ top: delta / zoom, behavior: 'instant' })
    }
  }

  function schedule() {
    // Two frames let Svelte lay out newly focused fields and the Notes toolbar
    // finish docking before measuring. Coalesce keyboard animation events.
    if (frame === null) frame = requestAnimationFrame(() => { frame = requestAnimationFrame(update) })
  }
  function editingChanged(event: Event) {
    const editor = activeEditor()
    if (editor && (event.type === 'selectionchange' || (event.target instanceof Node && editor.contains(event.target)))) schedule()
  }
  document.addEventListener('focusin', schedule)
  document.addEventListener('focusout', schedule)
  document.addEventListener('input', editingChanged)
  document.addEventListener('selectionchange', editingChanged)
  document.addEventListener('pointerup', editingChanged)
  window.addEventListener('resize', schedule)
  viewport?.addEventListener('resize', schedule)
  // Do not follow ordinary document scroll events: users can still scroll away
  // from a focused field. Visual viewport panning is separate (e.g. iOS IME).
  viewport?.addEventListener('scroll', schedule)
  return () => {
    if (frame !== null) cancelAnimationFrame(frame)
    restorePadding()
    document.removeEventListener('focusin', schedule)
    document.removeEventListener('focusout', schedule)
    document.removeEventListener('input', editingChanged)
    document.removeEventListener('selectionchange', editingChanged)
    document.removeEventListener('pointerup', editingChanged)
    window.removeEventListener('resize', schedule)
    viewport?.removeEventListener('resize', schedule)
    viewport?.removeEventListener('scroll', schedule)
  }
}
