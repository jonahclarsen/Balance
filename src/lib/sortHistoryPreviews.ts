import type { ProjectSort } from './projectSort'
import { parseNavigationURL } from './navigationLinks'

// Decorate the live anchors without inserting anything into Lexical's
// editable document or copying image bytes into the note and its operations.
export function sortHistoryPreviews(root: HTMLElement, sorts: ProjectSort[]) {
  let previousSorts: ProjectSort[] | undefined
  const previews = new Map<string, string>()
  function decorate(anchor: HTMLAnchorElement) {
    const target = parseNavigationURL(anchor.getAttribute('href') ?? '')
    const preview = target?.kind === 'project-sort' && previews.get(target.id)
    if (preview) anchor.style.setProperty('--sort-history-image', 'var(' + preview + ')')
    else anchor.style.removeProperty('--sort-history-image')
    anchor.classList.toggle('history-sort-link', !!preview)
  }
  function visit(node: Node) {
    if (!(node instanceof Element)) return
    if (node instanceof HTMLAnchorElement) decorate(node)
    for (const a of node.querySelectorAll<HTMLAnchorElement>('a[href^="balance://project-sort/"]'))
      decorate(a)
  }
  function update(sorts: ProjectSort[]) {
    if (sorts === previousSorts) return
    previousSorts = sorts
    for (const property of previews.values()) root.style.removeProperty(property)
    previews.clear()
    for (const sort of sorts) {
      if (!sort.savedAt || !sort.preview || !/^data:image\/(?:jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(sort.preview)) continue
      const property = '--history-image-' + previews.size
      previews.set(sort.id, property)
      root.style.setProperty(property, 'url("' + sort.preview + '")')
    }
    visit(root)
  }
  update(sorts)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') visit(record.target)
      else for (const node of record.addedNodes) visit(node)
    }
  })
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] })
  return { update, destroy: () => observer.disconnect() }
}
