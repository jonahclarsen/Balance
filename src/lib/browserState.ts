import type { AppState } from './types'

const IMAGE_REFERENCE = 'balance:browser-image:'
const ENCODING_VERSION = 1

// Browser snapshots repeat image bytes in the current assets and operation
// fallback values/patches. WebKit counts UTF-16 bytes toward its storage quota.
// Keep the first data URL intact and encode later copies only on disk; native
// operations and the live store always retain their original payloads.
export function serializeBrowserState(state: AppState): string {
  const images = new Map<string, number>()
  return JSON.stringify({ ...state, browserImageEncoding: ENCODING_VERSION }, (_key, value: unknown) => {
    if (typeof value !== 'string') return value
    if (value.startsWith(IMAGE_REFERENCE)) return `${IMAGE_REFERENCE}:${value}`
    if (!value.startsWith('data:image/') || value.length < 1024) return value
    const index = images.get(value)
    if (index !== undefined) return `${IMAGE_REFERENCE}${index}`
    images.set(value, images.size)
    return value
  })
}

export function parseBrowserState(raw: string): unknown {
  const stored = JSON.parse(raw)
  if (stored?.browserImageEncoding !== ENCODING_VERSION) return stored
  const images: string[] = []
  const decoded = JSON.parse(raw, (_key, value: unknown) => {
    if (typeof value !== 'string') return value
    if (value.startsWith(`${IMAGE_REFERENCE}:`)) return value.slice(IMAGE_REFERENCE.length + 1)
    if (value.startsWith(IMAGE_REFERENCE)) {
      const index = value.slice(IMAGE_REFERENCE.length)
      if (!/^\d+$/.test(index) || images[Number(index)] === undefined) throw new Error('Invalid browser image reference')
      return images[Number(index)]
    }
    if (value.startsWith('data:image/') && value.length >= 1024) images.push(value)
    return value
  })
  delete decoded.browserImageEncoding
  return decoded
}
