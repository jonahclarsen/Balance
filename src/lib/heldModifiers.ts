// Alt and Shift as currently held on a hardware keyboard.
//
// Android (Samsung DeX, a Bluetooth keyboard and mouse) does not always report
// held modifiers on pointer events, so drags also read them from key events.

export type HeldModifiers = { altKey: boolean; shiftKey: boolean }

const held: HeldModifiers = { altKey: false, shiftKey: false }
let installed = false

function track(event: KeyboardEvent) {
  const down = event.type === 'keydown'
  held.altKey = event.key === 'Alt' ? down : event.altKey
  held.shiftKey = event.key === 'Shift' ? down : event.shiftKey
}

function reset() {
  held.altKey = false
  held.shiftKey = false
}

export function installHeldModifiers() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', track, true)
  window.addEventListener('keyup', track, true)
  window.addEventListener('blur', reset)
}

export function modifiersFor(event: { altKey: boolean; shiftKey: boolean }): HeldModifiers {
  return { altKey: event.altKey || held.altKey, shiftKey: event.shiftKey || held.shiftKey }
}
