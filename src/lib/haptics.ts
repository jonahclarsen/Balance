import { invoke, isTauri } from '@tauri-apps/api/core'
import { vibrate } from '@tauri-apps/plugin-haptics'

const STEP_HAPTIC_MS = 16
const STEP_HAPTIC_PAUSE_MS = 24

export function vibrateSteps(count = 1) {
  if (count < 1) return

  if (isTauri()) {
    // Tauri reaches AppKit on macOS and the native vibrator service on
    // Android; Android WebViews can silently ignore navigator.vibrate().
    void vibrateNatively(count).catch(() => vibrateInBrowser(count))
    return
  }

  vibrateInBrowser(count)
}

async function vibrateNatively(count: number) {
  for (let index = 0; index < count; index += 1) {
    const handledByMacos = await invoke<boolean>('perform_alignment_haptic')
    if (!handledByMacos) {
      const result = await vibrate(STEP_HAPTIC_MS)
      if (result.status === 'error') throw new Error('Native haptic feedback failed')
    }
    if (index < count - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, STEP_HAPTIC_PAUSE_MS))
    }
  }
}

function vibrateInBrowser(count: number) {
  if (typeof navigator.vibrate !== 'function') return

  // Pointer events can skip several discrete values during a quick swipe. A
  // pulse pattern preserves one tactile tick per crossed value instead of
  // collapsing them into one buzz.
  const pattern = Array.from(
    { length: count * 2 - 1 },
    (_, index) => (index % 2 === 0 ? STEP_HAPTIC_MS : STEP_HAPTIC_PAUSE_MS),
  )
  navigator.vibrate(pattern)
}

export function hapticSlider(node: HTMLInputElement) {
  let pointerActive = false
  let lastValue = node.value

  function beginPointer(event: PointerEvent) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    pointerActive = true
    lastValue = node.value
  }

  function handleInput() {
    if (!pointerActive || node.value === lastValue) return
    lastValue = node.value
    vibrateSteps()
  }

  function endPointer() {
    pointerActive = false
  }

  node.addEventListener('pointerdown', beginPointer)
  node.addEventListener('input', handleInput)
  window.addEventListener('pointerup', endPointer)
  window.addEventListener('pointercancel', endPointer)

  return {
    destroy() {
      node.removeEventListener('pointerdown', beginPointer)
      node.removeEventListener('input', handleInput)
      window.removeEventListener('pointerup', endPointer)
      window.removeEventListener('pointercancel', endPointer)
    },
  }
}
