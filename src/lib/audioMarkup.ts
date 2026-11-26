import type { AppState, AudioAsset } from './types'

// Rich text holds only an audio asset's id; the bytes live in the `audio`
// collection while some text still references them.
export const AUDIO_SELECTOR = '[data-balance-audio]'
const ID = /^[A-Za-z0-9_-]{1,128}$/

export function audioHTML(id: string): string {
  return ID.test(id) ? `<span data-balance-audio="${id}"></span>` : ''
}

export function sanitizeAudio(element: Element): string {
  return audioHTML(element.getAttribute('data-balance-audio') ?? '')
}

const EMPTY: ReadonlySet<string> = new Set()
const cache = new WeakMap<object, ReadonlySet<string>>()
const SKIPPED = new Set(['audio', 'images', 'voiceClips', 'operations'])

export function audioReferences(value: unknown): ReadonlySet<string> {
  if (typeof value === 'string') {
    if (!value.includes('data-balance-audio="')) return EMPTY
    return new Set(Array.from(value.matchAll(/data-balance-audio="([A-Za-z0-9_-]{1,128})"/g), (match) => match[1]!))
  }
  if (!value || typeof value !== 'object') return EMPTY
  const cached = cache.get(value)
  if (cached) return cached
  const ids = new Set<string>()
  if (Array.isArray(value)) {
    for (const child of value) for (const id of audioReferences(child)) ids.add(id)
  } else {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (SKIPPED.has(key)) continue
      for (const id of audioReferences(record[key])) ids.add(id)
    }
  }
  cache.set(value, ids)
  return ids
}

// Assets seen this session, so a reference that comes back (paste after cut,
// moving text between notes) restores its bytes in the same commit.
const known = new Map<string, AudioAsset>()

export function rememberAudio(asset: AudioAsset) {
  known.set(asset.id, asset)
}

// Drops audio no text references and restores known audio that text
// references again, in the commit that changed the references.
export function reconcileAudio(state: AppState): AppState {
  for (const asset of state.audio) known.set(asset.id, asset)
  if (state.audio.length === 0 && known.size === 0) return state
  const referenced = audioReferences(state)
  const present = new Set(state.audio.map((asset) => asset.id))
  const kept = state.audio.filter((asset) => referenced.has(asset.id))
  const restored = [...referenced].flatMap((id) => !present.has(id) && known.has(id) ? [known.get(id)!] : [])
  if (kept.length === state.audio.length && restored.length === 0) return state
  return { ...state, audio: [...kept, ...restored] }
}
