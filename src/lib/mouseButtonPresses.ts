// Lets a mouse press buttons while Android's on-screen keyboard is open.
//
// A mouse press moves focus on mousedown, so the keyboard starts closing and
// the page reflows before the button is released; the click then lands on
// whatever slid under the pointer, or nowhere. A finger's tap only moves focus
// as it lifts, so touch never had this problem. For mouse presses on buttons
// this keeps the editor focused until the click arrives, then releases it just
// before the click's handlers run, the moment a tap would have.
import { activeEditor } from './mobileKeyboardScroll'

const PRESSABLE = [
  'button', 'a[href]', 'summary', 'label',
  'input:is([type="checkbox"], [type="radio"], [type="button"], [type="submit"])',
  '[role="button"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="switch"]', '[role="checkbox"]',
].join(', ')

export function installMouseButtonPresses(): () => void {
  let pointerType = ''
  let pending: HTMLElement | null = null

  function handlePointerDown(event: PointerEvent) {
    pointerType = event.pointerType
  }

  function handleMouseDown(event: MouseEvent) {
    pending = null
    // Components that keep focus themselves have already cancelled the press.
    if (pointerType !== 'mouse' || event.button !== 0 || event.defaultPrevented) return
    const editor = activeEditor()
    const target = event.target instanceof Element ? event.target.closest(PRESSABLE) : null
    if (!editor || !target || editor.contains(target)) return
    event.preventDefault()
    pending = editor
  }

  function handleClick() {
    const editor = pending
    pending = null
    // Handlers that focus something, the same editor included, still can.
    if (editor && document.activeElement === editor) editor.blur()
  }

  window.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('mousedown', handleMouseDown)
  window.addEventListener('click', handleClick, true)
  return () => {
    window.removeEventListener('pointerdown', handlePointerDown, true)
    window.removeEventListener('mousedown', handleMouseDown)
    window.removeEventListener('click', handleClick, true)
  }
}
