// WebKit up to Safari/WKWebView 26.x repaints a custom highlight only when
// ranges are added to or removed from a Highlight object. Deleting a
// registered Highlight, or replacing it through CSS.highlights.set(), leaves
// its old paint on screen (https://bugs.webkit.org/show_bug.cgi?id=266250).
// Keep one registered Highlight per style and only ever change its ranges.
export const allFindHighlightName = 'balance-document-find-all'
export const activeFindHighlightName = 'balance-document-find-match'

export type FindHighlights = {
  show: (ranges: readonly Range[], active: Range | undefined) => void
  setActive: (active: Range | undefined) => void
  dispose: () => void
}

export function createFindHighlights(): FindHighlights {
  if (!CSS.highlights || typeof Highlight === 'undefined') {
    return { show() {}, setActive() {}, dispose() {} }
  }
  const all = new Highlight()
  const active = new Highlight()
  active.priority = 1
  let registered = false

  function register() {
    if (registered) return
    registered = true
    CSS.highlights.set(allFindHighlightName, all)
    CSS.highlights.set(activeFindHighlightName, active)
  }

  function setActive(range: Range | undefined) {
    active.clear()
    if (range) active.add(range)
  }

  return {
    show(ranges, range) {
      all.clear()
      for (const match of ranges) all.add(match)
      setActive(range)
      // Registering empty highlights is harmless, but an empty registry keeps
      // closed or never-matched find invisible to anything inspecting it.
      if (ranges.length) register()
    },
    setActive,
    dispose() {
      // Clear first: only removing ranges repaints them on older WebKit.
      all.clear()
      active.clear()
      if (CSS.highlights.get(allFindHighlightName) === all) CSS.highlights.delete(allFindHighlightName)
      if (CSS.highlights.get(activeFindHighlightName) === active) CSS.highlights.delete(activeFindHighlightName)
      registered = false
    },
  }
}
