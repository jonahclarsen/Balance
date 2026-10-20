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

// Use the same destination priority for task rows and idea-sort cards.
export function openRenderedLinkFromShortcut(html: string, onInternalLink: (link: ItemLink) => void): boolean {
  const template = document.createElement('template')
  template.innerHTML = html
  const anchors = Array.from(template.content.querySelectorAll<HTMLAnchorElement>('a[href]'))
  const externalURL = anchors
    .map((anchor) => anchor.getAttribute('href')?.trim() ?? '')
    .find(isURL)
  if (externalURL) {
    openExternalURLFromShortcut(externalURL)
    return true
  }
  const internalLink = anchors.map(itemLinkFromAnchor).find((link) => link !== null)
  if (!internalLink) return false
  onInternalLink(internalLink)
  return true
}
