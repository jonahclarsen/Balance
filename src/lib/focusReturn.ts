export type FocusReturn = {
  /** Refocuses the remembered element and puts its caret or selection back. */
  restore: () => void
}

// Remembers the focused element and its caret so a transient surface (find
// bar, quick add) can hand both back when it closes.
export function rememberFocusReturn(exclude?: Element | null): FocusReturn | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body || exclude?.contains(active)) return null

  const selection = window.getSelection()
  const caret = selection?.anchorNode && selection.focusNode
    && active.contains(selection.anchorNode) && active.contains(selection.focusNode)
    ? [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] as const : null
  const inputSelection = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
    && active.selectionStart !== null && active.selectionEnd !== null
    ? [active.selectionStart, active.selectionEnd, active.selectionDirection ?? 'none'] as const : null

  return {
    restore() {
      if (!active.isConnected || !active.getClientRects().length) return
      active.focus({ preventScroll: true })
      if (inputSelection && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
        active.setSelectionRange(...inputSelection)
      } else if (caret && active.contains(caret[0]) && active.contains(caret[2])) {
        try {
          window.getSelection()?.setBaseAndExtent(...caret)
        } catch {
          // The editor re-rendered and the old offsets no longer fit.
        }
      }
    },
  }
}
