import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

// Retro captions draw their own window buttons. They do what the macOS
// traffic lights do: close, minimize, and toggle full screen.

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function closeWindow() {
  if (isTauri()) void getCurrentWindow().close()
}

export async function toggleFullscreen() {
  if (!isTauri()) return
  const window = getCurrentWindow()
  await window.setFullscreen(!(await window.isFullscreen()))
}

// macOS can't minimize a full-screen window and ignores the request until the
// exit animation ends, so leave full screen first and retry until it takes.
export async function minimizeWindow() {
  if (!isTauri()) return
  const window = getCurrentWindow()
  if (!(await window.isFullscreen())) {
    await window.minimize()
    return
  }
  await window.setFullscreen(false)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await pause(100)
    if (await window.isFullscreen()) continue
    await window.minimize()
    await pause(50)
    if (await window.isMinimized()) return
  }
}

export function setNativeWindowButtonsHidden(hidden: boolean) {
  if (isTauri()) void invoke('set_native_window_buttons_hidden', { hidden }).catch(() => {})
}

// Reports full-screen changes, however they happen (the View menu, a swipe,
// or a caption button), so the Maximize button can show Restore.
export function watchFullscreen(onChange: (fullscreen: boolean) => void): () => void {
  if (!isTauri()) return () => {}
  const window = getCurrentWindow()
  let current: boolean | null = null
  let disposed = false
  const check = () => void window.isFullscreen().then(next => {
    if (disposed || next === current) return
    current = next
    onChange(next)
  }).catch(() => {})
  check()
  const unlisten = window.onResized(check)
  return () => {
    disposed = true
    void unlisten.then(stop => stop())
  }
}
