import { invoke, isTauri } from '@tauri-apps/api/core'
import { vibrate } from '@tauri-apps/plugin-haptics'

const STEP_HAPTIC_MS = 16
const STEP_HAPTIC_PAUSE_MS = 24
let activeHapticDrags = 0
let nativeDragOverride: Promise<boolean> | null = null
let nativeDragRelease = Promise.resolve()
const pendingNativeHaptics = new Set<Promise<void>>()

export function beginHapticDrag() {
  activeHapticDrags += 1
  if (activeHapticDrags !== 1 || !isTauri()) return
  nativeDragOverride = nativeDragRelease
    .then(() => invoke<boolean>('begin_haptic_drag'))
    .catch(() => false)
}

export function endHapticDrag() {
  if (activeHapticDrags < 1) return
  activeHapticDrags -= 1
  if (activeHapticDrags !== 0) return

  const override = nativeDragOverride
  const pendingHaptics = [...pendingNativeHaptics]
  nativeDragOverride = null
  if (!override) return

  nativeDragRelease = override.then(async (changedSystemState) => {
    if (!changedSystemState) return
    await Promise.allSettled(pendingHaptics)
    await invoke('end_haptic_drag')
  }).catch(() => undefined)
}

export function vibrateSteps(count = 1) {
  if (count < 1) return

  if (isTauri()) {
    // Tauri reaches AppKit on macOS and the native vibrator service on
    // Android; Android WebViews can silently ignore navigator.vibrate().
    const haptic = vibrateNatively(count).catch(() => vibrateInBrowser(count))
    pendingNativeHaptics.add(haptic)
    void haptic.then(
      () => pendingNativeHaptics.delete(haptic),
      () => pendingNativeHaptics.delete(haptic),
    )
    return
  }

  vibrateInBrowser(count)
}

async function vibrateNatively(count: number) {
  const override = nativeDragOverride
  if (override) await override

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
    beginHapticDrag()
  }

  function handleInput() {
    if (!pointerActive || node.value === lastValue) return
    lastValue = node.value
    vibrateSteps()
  }

  function endPointer() {
    if (!pointerActive) return
    pointerActive = false
    endHapticDrag()
  }

  node.addEventListener('pointerdown', beginPointer)
  node.addEventListener('input', handleInput)
  window.addEventListener('pointerup', endPointer)
  window.addEventListener('pointercancel', endPointer)

  return {
    destroy() {
      if (pointerActive) endHapticDrag()
      node.removeEventListener('pointerdown', beginPointer)
      node.removeEventListener('input', handleInput)
      window.removeEventListener('pointerup', endPointer)
      window.removeEventListener('pointercancel', endPointer)
    },
  }
}
