import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

// Retro captions draw their own window buttons. They do what the macOS
// traffic lights do: close, minimize, and toggle full screen.

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Full screen goes through the backend, which on macOS fills the whole
// display, notch strips included.
const isFullscreen = () => invoke<boolean>('window_fullscreen')
const toggle = () => invoke('toggle_window_fullscreen')

export function closeWindow() {
  if (isTauri()) void getCurrentWindow().close()
}

export async function toggleFullscreen() {
  if (isTauri()) await toggle()
}

// macOS can't minimize a full-screen window and ignores the request until the
// exit animation ends, so leave full screen first and retry until it takes.
export async function minimizeWindow() {
  if (!isTauri()) return
  const window = getCurrentWindow()
  if (!(await isFullscreen())) {
    await window.minimize()
    return
  }
  await toggle()
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await pause(100)
    if (await isFullscreen()) continue
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
  const check = () => void isFullscreen().then(next => {
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
