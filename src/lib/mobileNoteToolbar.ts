// Keep formatting reachable when the software keyboard shrinks or pans the
// visual viewport. A body portal avoids transformed/contained page ancestors.
export function mobileNoteToolbar(node: HTMLDivElement) {
  const parent = node.parentElement!
  const anchor = document.createComment('note toolbar')
  node.before(anchor)
  const spacer = document.createElement('div')
  const viewport = window.visualViewport
  const media = window.matchMedia('(max-width: 760px)')
  let fullHeight = window.innerHeight
  let fullWidth = window.innerWidth
  let docked = false
  let frame: number | null = null

  function restore() {
    if (!docked) return
    anchor.after(node)
    spacer.remove()
    node.removeAttribute('style')
    docked = false
  }

  function update() {
    frame = null
    if (window.innerWidth !== fullWidth) {
      fullWidth = window.innerWidth
      fullHeight = window.innerHeight
    }
    fullHeight = Math.max(fullHeight, window.innerHeight)
    const focused = document.activeElement
    const editing = focused instanceof HTMLElement &&
      ((parent.contains(focused) && focused.matches('[data-note-text-input]')) || node.contains(focused))
    const height = viewport?.height ?? window.innerHeight
    const keyboardOpen = fullHeight - height > 100
    if (!media.matches || !editing || !keyboardOpen) {
      restore()
      return
    }
    if (!docked) {
      spacer.style.height = `${node.offsetHeight}px`
      spacer.style.marginBottom = getComputedStyle(node).marginBottom
      anchor.after(spacer)
      document.body.appendChild(node)
      docked = true
    }
    const zoom = node.currentCSSZoom || 1
    node.style.position = 'fixed'
    node.style.zIndex = '25'
    node.style.margin = '0'
    node.style.left = `${((viewport?.offsetLeft ?? 0) + 8) / zoom}px`
    node.style.width = `${((viewport?.width ?? window.innerWidth) - 16) / zoom}px`
    node.style.maxWidth = 'none'
    node.style.top = `${((viewport?.offsetTop ?? 0) + height - node.getBoundingClientRect().height - 8) / zoom}px`
  }

  function schedule() {
    if (frame === null) frame = requestAnimationFrame(update)
  }

  // Prevent a formatting tap from blurring the editor and dismissing the IME.
  function preserveFocus(event: PointerEvent) {
    if (docked && event.target instanceof Element && event.target.closest('button')) event.preventDefault()
  }

  document.addEventListener('focusin', schedule)
  document.addEventListener('focusout', schedule)
  window.addEventListener('resize', schedule)
  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)
  node.addEventListener('pointerdown', preserveFocus)
  schedule()

  return {
    destroy() {
      if (frame !== null) cancelAnimationFrame(frame)
      document.removeEventListener('focusin', schedule)
      document.removeEventListener('focusout', schedule)
      window.removeEventListener('resize', schedule)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
      node.removeEventListener('pointerdown', preserveFocus)
      restore()
      anchor.remove()
    },
  }
}
