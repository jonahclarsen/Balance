import { invoke, isTauri } from '@tauri-apps/api/core'

const SHORTCUT_REPEAT_WINDOW_MS = 500
let lastShortcutURL = ''
let lastShortcutOpenAt = Number.NEGATIVE_INFINITY

export async function openExternalURL(url: string) {
  if (isTauri()) {
    await invoke('open_external_url', { url })
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

export function openExternalURLFromShortcut(url: string) {
  const now = performance.now()
  if (url === lastShortcutURL && now - lastShortcutOpenAt < SHORTCUT_REPEAT_WINDOW_MS) return

  lastShortcutURL = url
  lastShortcutOpenAt = now
  void openExternalURL(url)
}
