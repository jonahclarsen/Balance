// Shift is allowed because many keyboard layouts use it for double quotes.
export function isQuoteKey(event: KeyboardEvent): boolean {
  return !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 &&
    !event.metaKey && !event.ctrlKey && !event.altKey &&
    (event.key === "'" || event.key === '"')
}

// Insert only at the boundaries so links, formatting and line breaks survive.
export function wrapRangeInQuotes(range: Range, quote: string): Range {
  const closing = document.createTextNode(quote)
  const end = range.cloneRange()
  end.collapse(false)
  end.insertNode(closing)
  const opening = document.createTextNode(quote)
  const start = range.cloneRange()
  start.collapse(true)
  start.insertNode(opening)
  const wrapped = document.createRange()
  wrapped.setStartAfter(opening)
  wrapped.setEndBefore(closing)
  return wrapped
}
