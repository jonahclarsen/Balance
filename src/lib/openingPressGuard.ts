// A surface opened by a press must not be activated by that same press. Touch
// WebViews hit-test a tap's click after the finger lifts, so a surface that
// appeared under the finger on pointerdown or pointerup receives the click.
// Until a press starts inside the surface, its pointer clicks are swallowed.
// Keyboard and programmatic clicks carry neither a click count nor coordinates.
export function ignoreOpeningPress(node: HTMLElement, active = true) {
  let pressed = !active

  function down() {
    pressed = true
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
  node.addEventListener('click', click, true)
  return {
    update(next = true) {
      if (next && !active) pressed = false
      active = next
    },
    destroy() {
      node.removeEventListener('pointerdown', down, true)
      node.removeEventListener('click', click, true)
    },
  }
}
