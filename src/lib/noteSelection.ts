// Count semantic line breaks as characters, just as a note's persisted text
// does. Range.toString() omits <br>, which otherwise moves restored carets.
function textNodes(root: Node) {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => node.nodeType === Node.TEXT_NODE || node.nodeName === 'BR'
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  })
}

export function noteTextOffset(editor: HTMLElement, node: Node, offset: number) {
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.setEnd(node, offset)
  const walker = textNodes(range.cloneContents())
  let length = 0
  for (let child = walker.nextNode(); child; child = walker.nextNode()) {
    length += child.nodeName === 'BR' ? 1 : child.textContent?.length ?? 0
  }
  return length
}

export function noteTextPoint(editor: HTMLElement, requestedOffset: number): { node: Node; offset: number } {
  const walker = textNodes(editor)
  let remaining = Math.max(0, requestedOffset)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeName === 'BR') {
      const parent = node.parentNode!
      const index = Array.from(parent.childNodes).indexOf(node as ChildNode)
      if (remaining <= 1) return { node: parent, offset: index + remaining }
      remaining -= 1
    } else {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) return { node, offset: remaining }
      remaining -= length
    }
  }
  return { node: editor, offset: requestedOffset <= 0 ? 0 : editor.childNodes.length }
}
