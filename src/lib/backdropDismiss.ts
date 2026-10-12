// Closes a modal when a click lands on its backdrop. The press must also start
// on the backdrop, so dragging a text selection out of the card keeps it open.
export function dismissOnBackdropClick(node: HTMLElement, onDismiss: () => void) {
  let dismiss = onDismiss
  let pressedBackdrop = false

  function handlePointerDown(event: PointerEvent) {
    pressedBackdrop = event.target === node
  }

  function handleClick(event: MouseEvent) {
    const fromBackdrop = pressedBackdrop && event.target === node
    pressedBackdrop = false
    if (fromBackdrop) dismiss()
  }

  node.addEventListener('pointerdown', handlePointerDown)
  node.addEventListener('click', handleClick)
  return {
    update(next: () => void) {
      dismiss = next
    },
    destroy() {
      node.removeEventListener('pointerdown', handlePointerDown)
      node.removeEventListener('click', handleClick)
    },
  }
}
