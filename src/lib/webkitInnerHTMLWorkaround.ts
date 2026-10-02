// WebKit 26 (Safari and the macOS/iOS WKWebView) can hand back stale markup
// from innerHTML. Svelte clones component templates into an inert template
// document and, when {@html} is an element's only child, assigns innerHTML
// there before inserting the element. If that same element later receives new
// markup of the same shape, WebKit's parse cache for the inert document is
// overwritten too, so the next mount that assigns the original markup renders
// the later markup instead. In the quiz modal this showed question two's text
// above question one's answer after reopening.
//
// Parsing through a context element owned by the live document avoids the
// cache entry entirely. Only elements outside the live document take this path,
// which in practice means Svelte's freshly cloned templates.
export function installWebKitInnerHTMLWorkaround() {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')
  const nativeSet = descriptor?.set
  if (!descriptor || !nativeSet || !descriptor.configurable) return

  Object.defineProperty(Element.prototype, 'innerHTML', {
    ...descriptor,
    set(this: Element, value: string) {
      if (this.ownerDocument === document || this.namespaceURI !== 'http://www.w3.org/1999/xhtml' || this.localName === 'template') {
        nativeSet.call(this, value)
        return
      }
      const context = document.createElement(this.localName)
      nativeSet.call(context, value)
      this.replaceChildren(...context.childNodes)
    },
  })
}
