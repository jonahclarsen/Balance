// Only internal, content-addressed images survive rich-text sanitization.
export const IMAGE_SELECTOR = 'img[data-balance-image]'
export const IMAGE_CLIPBOARD_TYPE = 'application/x-balance-inline-images'
export type ImageLayout = 'inline' | 'left' | 'right'

export function imageHTML(id: string, width: number, height: number, layout: ImageLayout = 'inline'): string {
  if (!/^[a-f0-9]{64}$/.test(id)) return ''
  const w = Math.max(1, Math.min(30000, Math.round(width) || 1))
  const h = Math.max(1, Math.min(30000, Math.round(height) || 1))
  return `<img data-balance-image="${id}" width="${w}" height="${h}" data-image-layout="${layout}" alt="Image" draggable="true">`
}

export function sanitizeImage(element: Element): string {
  const layout = element.getAttribute('data-image-layout')
  return imageHTML(element.getAttribute('data-balance-image') ?? '', Number(element.getAttribute('width')), Number(element.getAttribute('height')), layout === 'left' || layout === 'right' ? layout : 'inline')
}

export function initialImageScale(width: number, height: number): number {
  return Math.max(1, Math.min(100, Math.round(1500 / Math.min(width, height) * 100)))
}

export function clipboardHasDirectImage(data: DataTransfer): boolean {
  if (!Array.from(data.items).some((item) => item.kind === 'file' && item.type.startsWith('image/'))) return false
  // A browser selection may offer a raster representation as well as text.
  // Import only a copied image, never the pictures in a selected web passage.
  const html = data.getData('text/html')
  if (!html) return true
  const template = document.createElement('template')
  template.innerHTML = html
  return !template.content.textContent?.trim()
}
