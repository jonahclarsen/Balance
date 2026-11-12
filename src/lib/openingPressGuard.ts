// A surface opened by a press must not be activated by that same press. Touch
// WebViews hit-test a tap's click after the finger lifts, so a surface that
// appeared under the finger on pointerdown or pointerup receives the click.
// Until a press starts inside the surface, its pointer clicks are swallowed.
// WebKit gives keyboard clicks coordinates too. An activation key pressed
// inside the surface is a new press, just like pointerdown.
export function ignoreOpeningPress(node: HTMLElement, active = true) {
  let pressed = !active

  function down() {
    pressed = true
  }

  function keydown(event: KeyboardEvent) {
    if (!event.isComposing && (event.key === 'Enter' || event.key === ' ')) down()
  }

  function click(event: MouseEvent) {
    if (pressed) return
    // Android WebView can report a real tap with a zero detail count.
    if (event.detail === 0 && event.clientX === 0 && event.clientY === 0) return
    pressed = true
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  node.addEventListener('pointerdown', down, true)
  node.addEventListener('keydown', keydown, true)
  node.addEventListener('click', click, true)
  return {
    update(next = true) {
      if (next && !active) pressed = false
      active = next
    },
    destroy() {
      node.removeEventListener('pointerdown', down, true)
      node.removeEventListener('keydown', keydown, true)
      node.removeEventListener('click', click, true)
    },
  }
}
