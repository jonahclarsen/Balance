import { invoke, isTauri } from '@tauri-apps/api/core'
import { imageHTML, IMAGE_CLIPBOARD_TYPE } from './imageMarkup'
import { importImage, reportImageError, stageClipboardImages } from './imageService'
import { inlineTextStyle } from './inlineTextStyle'

// AppKit exports fonts in local CSS classes; Notesnook exports semantic HTML.
// Inline just the permitted text styles before discarding the stylesheet.
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
  for (const element of doc.body.querySelectorAll<HTMLElement>('*')) {
    if (/^H[1-6]$/.test(element.tagName) && !element.style.fontSize) {
      element.style.fontSize = `${[32, 24, 20, 18, 16, 14][Number(element.tagName[1]) - 1]}px`
      element.style.fontWeight = 'bold'
    }
    const style = inlineTextStyle(element.style.cssText)
    element.removeAttribute('style')
    if (style) element.setAttribute('style', style)
  }
  return doc.body.innerHTML
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
    image.outerHTML = imageHTML(asset.id, width, height)
  }
  return template.innerHTML
}

// Capture above all three note editors, then replay through their normal paste
// handlers. Their selection replacement and single-step undo stay authoritative.
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
      let richHTML = html
      let text = plain
      // WebKit can synthesize incomplete HTML from RTFD (including unusable
      // attachment file URLs). Prefer the self-contained native conversion.
      if (isTauri()) {
        const native = await invoke<{ html?: string; plainText?: string }>('read_balance_clipboard').catch(() => null)
        richHTML = native?.html || richHTML
        text = native?.plainText ?? text
      }
      if (richHTML) richHTML = await importNotePasteImages(normalizeNotePasteHTML(richHTML), files)
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
