import { invoke, isTauri } from '@tauri-apps/api/core'
import { imageHTML, IMAGE_CLIPBOARD_TYPE } from './imageMarkup'
import { importImage, reportImageError, stageClipboardImages } from './imageService'
import { isUnboldedBold, textStyleTags } from './textStyleTags'

const HEADING = 'h1, h2, h3, h4, h5, h6'

// AppKit exports fonts in local CSS classes; Notesnook exports semantic HTML.
// Resolve the stylesheet into Balance's own vocabulary (heading, bold, italic,
// underline) so pasted text never keeps another app's font, size or color.
export function normalizeNotePasteHTML(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const sheet of doc.querySelectorAll('style')) {
    for (const match of (sheet.textContent ?? '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const selector of match[1].split(',').map((s) => s.trim())) {
        if (!/^(?:[a-z][\w-]*)?\.[\w-]+$/i.test(selector)) continue
        for (const element of doc.querySelectorAll<HTMLElement>(selector)) {
          element.style.cssText = `${match[2]};${element.style.cssText}`
        }
      }
    }
    sheet.remove()
  }
  doc.querySelectorAll('script, iframe, object, link, meta').forEach((node) => node.remove())
  promoteLargeBlocksToHeadings(doc.body)
  for (const element of Array.from(doc.body.querySelectorAll<HTMLElement>('*'))) {
    if (element.tagName === 'IMG') {
      for (const dimension of ['width', 'height'] as const) {
        const value = element.style[dimension]
        if (!element.hasAttribute(dimension) && /^\d+(?:\.\d+)?px$/.test(value)) {
          element.setAttribute(dimension, String(parseFloat(value)))
        }
      }
      if (element.style.float === 'left' || element.style.float === 'right') element.dataset.imageLayout = element.style.float
      element.removeAttribute('style')
      continue
    }
    const inHeading = Boolean(element.closest(HEADING))
    // Headings are already bold; a nested bold would render heavier still.
    if (/^(B|STRONG)$/.test(element.tagName) && (inHeading || isUnboldedBold(element))) {
      element.replaceWith(...element.childNodes)
      continue
    }
    const own = ({ B: 'strong', STRONG: 'strong', I: 'em', EM: 'em', U: 'u' } as Record<string, string>)[element.tagName]
    for (const mark of textStyleTags(element)) {
      if (mark === own || (mark === 'strong' && inHeading)) continue
      const wrapper = doc.createElement(mark)
      wrapper.append(...element.childNodes)
      element.append(wrapper)
    }
    element.removeAttribute('style')
  }
  return doc.body.innerHTML
}

// AppKit marks Apple Notes titles and headings only by font size. Promote
// blocks clearly larger than the note's body text to a heading.
function promoteLargeBlocksToHeadings(body: HTMLElement) {
  const blocks = Array.from(body.querySelectorAll<HTMLElement>('p, div'))
    .filter((block) => block.textContent?.trim() && !block.querySelector(`p, div, ul, ol, blockquote, ${HEADING}`) && !block.closest(`li, blockquote, ${HEADING}`))
    .map((block) => ({ block, size: blockFontSize(block) }))
  const weights = new Map<number, number>()
  for (const { block, size } of blocks) if (size) weights.set(size, (weights.get(size) ?? 0) + block.textContent!.length)
  const bodySize = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!bodySize) return
  for (const { block, size } of blocks) {
    if (!size || size < bodySize * 1.25 || block.querySelector('img')) continue
    const heading = block.ownerDocument.createElement('h1')
    heading.append(...block.childNodes)
    block.replaceWith(heading)
  }
}

// The one font size shared by all of a block's text, in pixels.
function blockFontSize(block: HTMLElement): number | null {
  let size: number | null = null
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!text.textContent?.trim()) continue
    let element = text.parentElement
    while (element && element !== block && !element.style.fontSize) element = element.parentElement
    const match = element?.style.fontSize.match(/^(\d+(?:\.\d+)?)(px|pt)$/)
    const value = match ? Number(match[1]) * (match[2] === 'pt' ? 4 / 3 : 1) : null
    if (value === null || (size !== null && value !== size)) return null
    size = value
  }
  return size
}

export async function importNotePasteImages(html: string, files: File[] = []): Promise<string> {
  const template = document.createElement('template')
  template.innerHTML = html
  stageClipboardImages(html)
  const images = Array.from(template.content.querySelectorAll<HTMLImageElement>('img:not([data-balance-image])'))
  for (const [index, image] of images.entries()) {
    const source = image.getAttribute('src') ?? ''
    let blob: Blob
    // A browser may expose local clipboard attachments as files rather than
    // usable URLs. Cross-application blob/file URLs cannot be fetched.
    if (files.length === images.length && !source.startsWith('data:')) {
      blob = files[index]
    } else if (!/^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,/i.test(source) && !/^https?:\/\//i.test(source)) {
      const file = files[index]
      if (!file) throw new Error('The copied note contains an image that its app did not include. Copy that image separately, or copy the note with embedded images.')
      blob = file
    } else {
      const response = await fetch(source, { credentials: 'omit', referrerPolicy: 'no-referrer' })
      if (!response.ok) throw new Error('Could not load an image from the copied note.')
      blob = await response.blob()
    }
    const asset = await importImage(blob, { index: index + 1, total: images.length })
    if (!asset) { image.remove(); continue }
    const width = Number(image.getAttribute('width')) || Math.min(asset.width, 640)
    const height = Number(image.getAttribute('height')) || width * asset.height / asset.width
    const layout = image.dataset.imageLayout
    image.outerHTML = imageHTML(asset.id, width, height, layout === 'left' || layout === 'right' ? layout : 'inline')
  }
  return template.innerHTML
}

// The clipboard as the note parsers expect it: on desktop the native conversion
// (self-contained HTML from RTFD) wins over WebKit's synthesized HTML, and the
// markup is normalized before any parser sees it.
export async function readExternalPasteContent(data: DataTransfer): Promise<{ html: string; text: string }> {
  let html = data.getData('text/html')
  let text = data.getData('text/plain')
  if (isTauri()) {
    const native = await invoke<{ html?: string; plainText?: string }>('read_balance_clipboard').catch(() => null)
    html = native?.html || html
    text = native?.plainText ?? text
  }
  return { html: html ? normalizeNotePasteHTML(html) : '', text }
}

// Capture above the Notes editor, then replay through its normal paste handler.
// Selection replacement and single-step undo stay authoritative.
export function externalNotePaste(root: HTMLElement, context: string) {
  const prepared = new WeakSet<Event>()
  let busy = false
  let destroyed = false
  function paste(event: ClipboardEvent) {
    if (prepared.has(event) || event.defaultPrevented || !event.clipboardData) return
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[contenteditable="true"]') : null
    if (!target || !root.contains(target)) return
    const data = event.clipboardData
    if (data.getData(IMAGE_CLIPBOARD_TYPE)) return
    const html = data.getData('text/html')
    const plain = data.getData('text/plain')
    // Let the existing image-only handler import a standalone raster.
    if (!html && Array.from(data.files).some((file) => file.type.startsWith('image/'))) return
    if (!html && !isTauri()) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (busy) return
    busy = true
    const originalContext = context
    const selection = document.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
    const files = Array.from(data.files).filter((file) => file.type.startsWith('image/'))
    void (async () => {
      const content = await readExternalPasteContent(data)
      const text = content.text
      let richHTML = content.html
      if (richHTML) richHTML = await importNotePasteImages(richHTML, files)
      if (destroyed || context !== originalContext || !target.isConnected || !range || !root.contains(range.commonAncestorContainer)) return
      target.focus({ preventScroll: true })
      selection?.removeAllRanges()
      selection?.addRange(range)
      const clipboard = new DataTransfer()
      clipboard.setData('text/plain', text)
      if (richHTML) clipboard.setData('text/html', richHTML)
      const replay = new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true })
      prepared.add(replay)
      target.dispatchEvent(replay)
    })().catch(reportImageError).finally(() => { busy = false })
  }
  root.addEventListener('paste', paste, true)
  return {
    update(value: string) { context = value },
    destroy() { destroyed = true; root.removeEventListener('paste', paste, true) },
  }
}
