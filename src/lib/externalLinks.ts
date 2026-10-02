import { invoke, isTauri } from '@tauri-apps/api/core'
import { isURL, itemLinkFromAnchor, type ItemLink } from './planner'

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

// Markup rendered with {@html} has no Svelte handlers on its anchors, so route
// a click on one explicitly instead of letting the webview navigate away.
export function openClickedLink(event: MouseEvent, onInternalLink: (link: ItemLink) => void) {
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
  if (!anchor) return
  event.preventDefault()
  const link = itemLinkFromAnchor(anchor)
  if (link) onInternalLink(link)
  else if (isURL(anchor.href)) void openExternalURL(anchor.href)
}
