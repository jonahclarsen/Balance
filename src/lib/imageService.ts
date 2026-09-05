import { writable } from 'svelte/store'
import type { ImageAsset } from './types'

export type ImageImport = { blob: Blob; resolve: (blob: Blob | null) => void }
export const imageImport = writable<ImageImport | null>(null)
export const imageViewer = writable<string | null>(null)
export const imageError = writable('')
export type SelectedImage = { image: HTMLImageElement; editor: HTMLElement; commit: () => void }
export const selectedImage = writable<SelectedImage | null>(null)
export const imageSources = new Map<string, string>()
export const imageAssets = new Map<string, ImageAsset>()
let saveAsset: ((asset: ImageAsset) => void) | null = null
let importQueue = Promise.resolve()

export function setImageSaver(save: (asset: ImageAsset) => void) { saveAsset = save }

export async function decodeImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally { URL.revokeObjectURL(url) }
}

export function blobDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read this image.'))
    reader.readAsDataURL(blob)
  })
}

export function importImage(original: Blob): Promise<ImageAsset | null> {
  const result = importQueue.then(async () => {
    if (!/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(original.type)) throw new Error('This image format is not supported. Use PNG, JPEG, WebP, GIF, AVIF, or BMP.')
    const blob = original.size > 1_000_000
      ? await new Promise<Blob | null>((resolve) => imageImport.set({ blob: original, resolve }))
      : original
    if (!blob) return null
    const decoded = await decodeImage(blob)
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const asset: ImageAsset = { id, dataURL: await blobDataURL(blob), width: decoded.naturalWidth, height: decoded.naturalHeight, bytes: blob.size }
    if (!saveAsset) throw new Error('Image storage is not ready.')
    saveAsset(asset)
    return asset
  })
  importQueue = result.then(() => {}, () => {})
  return result
}

export function reportImageError(error: unknown) { imageError.set(error instanceof Error ? error.message : String(error)) }


// Clipboard bytes are self-contained: a copy remains usable after all database
// references expire, and external rich-text applications receive an actual image.
export function imageClipboardHTML(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const image of template.content.querySelectorAll<HTMLImageElement>('img[data-balance-image]')) {
    const asset = imageAssets.get(image.dataset.balanceImage ?? '')
    if (!asset) continue
    image.src = asset.dataURL
    image.dataset.imageSourceWidth = String(asset.width)
    image.dataset.imageSourceHeight = String(asset.height)
  }
  return template.innerHTML
}

export function stageClipboardImages(html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const image of template.content.querySelectorAll<HTMLImageElement>('img[data-balance-image]')) {
    const id = image.dataset.balanceImage ?? ''
    const dataURL = image.getAttribute('src') ?? ''
    if (!/^[a-f0-9]{64}$/.test(id)) continue
    const existing = imageAssets.get(id)
    if (existing) { saveAsset?.(existing); continue }
    if (!/^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,[A-Za-z0-9+/=]+$/.test(dataURL)) continue
    try {
      const bytes = atob(dataURL.slice(dataURL.indexOf(',') + 1)).length
      saveAsset?.({ id, dataURL, bytes, width: Math.max(1, Number(image.dataset.imageSourceWidth) || image.width), height: Math.max(1, Number(image.dataset.imageSourceHeight) || image.height) })
    } catch { /* Ignore malformed clipboard assets; native storage verifies hashes. */ }
  }
}
