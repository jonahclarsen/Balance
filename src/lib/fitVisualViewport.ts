/**
 * Pin a fixed element to the visible part of the screen. Mobile keyboards
 * shrink the visual viewport but not the layout viewport that `position:
 * fixed` uses, so a dialog centered with `inset: 0` would sit half behind the
 * keyboard.
 */
export function fitVisualViewport(node: HTMLElement) {
  const viewport = window.visualViewport
  if (!viewport) return {}
  const fit = () => {
    node.style.top = `${viewport.offsetTop}px`
    node.style.height = `${viewport.height}px`
  }
  fit()
  viewport.addEventListener('resize', fit)
  viewport.addEventListener('scroll', fit)
  return {
    destroy() {
      viewport.removeEventListener('resize', fit)
      viewport.removeEventListener('scroll', fit)
    },
  }
}
