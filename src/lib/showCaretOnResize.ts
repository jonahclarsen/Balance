// WebKit can leave the caret in its blink-off phase through an edit, so a modal
// that moves as its text grows appears to jump ahead of the caret. Reselecting
// in the same tick shows the caret in the frame the new layout paints.
export function showCaretOnResize(node: HTMLElement) {
  let height = node.offsetHeight
  let composing = false
  const startComposing = () => { composing = true }
  const stopComposing = () => { composing = false }
  const observer = new ResizeObserver(() => {
    const nextHeight = node.offsetHeight
    if (nextHeight === height) return
    height = nextHeight
    // Changing the selection would end an IME composition.
    if (composing) return
    const selection = document.getSelection()
    if (!selection?.rangeCount || !selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    if (!node.contains(range.startContainer)) return
    selection.removeAllRanges()
    selection.addRange(range)
  })
  observer.observe(node)
  node.addEventListener('compositionstart', startComposing)
  node.addEventListener('compositionend', stopComposing)
  return {
    destroy() {
      observer.disconnect()
      node.removeEventListener('compositionstart', startComposing)
      node.removeEventListener('compositionend', stopComposing)
    },
  }
}
