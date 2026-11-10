// Browser tooltips use the host OS's chrome, which breaks the old OS themes.
// Suppress only the hovered ancestry; no document scans or mutation observer.
// Keep accessible names for icon controls whose only label was their title.
export function suppressNativeTooltips() {
  const hovered = new Map<Element, { title: string; addedLabel: boolean }>()
  const restore = () => {
    for (const [element, { title, addedLabel }] of hovered) {
      if (element.getAttribute('title') === '') element.setAttribute('title', title)
      if (addedLabel && element.getAttribute('aria-label') === title) element.removeAttribute('aria-label')
    }
    hovered.clear()
  }
  const enter = (event: PointerEvent) => {
    restore()
    if (!(event.target instanceof Element)) return
    for (let element: Element | null = event.target; element; element = element.parentElement) {
      const title = element.getAttribute('title')
      if (!title) continue
      const addedLabel = !element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby') && !element.textContent?.trim()
      hovered.set(element, { title, addedLabel })
      if (addedLabel) element.setAttribute('aria-label', title)
      // An empty title also prevents inheriting a native tooltip from a parent.
      element.setAttribute('title', '')
    }
  }
  document.addEventListener('pointerover', enter, true)
  document.addEventListener('pointerout', restore, true)
  return () => {
    restore()
    document.removeEventListener('pointerover', enter, true)
    document.removeEventListener('pointerout', restore, true)
  }
}
