import { AUDIO_SELECTOR } from './audioMarkup'
import { formatClipDuration } from './voiceClips'
import type { AudioAsset } from './types'


const assets = new Map<string, AudioAsset>()
const sources = new Map<string, string>()
const BARS = 40
let player: HTMLAudioElement | null = null
let playingId: string | null = null
let frame = 0

const SVG = 'http://www.w3.org/2000/svg'

// Fills an audio placeholder with a play button, waveform and duration. The
// chip is not editable text; rich text stores only the empty placeholder.
export function renderAudioChip(element: HTMLElement) {
  const id = element.dataset.balanceAudio ?? ''
  const asset = assets.get(id)
  const state = asset ? id : `missing:${id}`
  if (element.dataset.audioReady === state) return
  element.dataset.audioReady = state
  element.contentEditable = 'false'
  element.classList.add('audio-chip')
  element.replaceChildren()
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'audio-chip-play'
  button.setAttribute('aria-label', asset ? `Play recording, ${formatClipDuration(asset.durationMs)}` : 'Recording unavailable')
  button.disabled = !asset
  const wave = document.createElementNS(SVG, 'svg')
  wave.classList.add('audio-chip-wave')
  wave.setAttribute('aria-hidden', 'true')
  const peaks = asset?.peaks ?? []
  const count = Math.max(1, Math.min(BARS, peaks.length))
  wave.setAttribute('viewBox', `0 0 ${count} 16`)
  wave.setAttribute('preserveAspectRatio', 'none')
  for (let index = 0; index < count; index += 1) {
    const peak = peaks[Math.floor((index * peaks.length) / count)] ?? 0
    const height = Math.max(1.2, (peak / 255) * 16)
    const bar = document.createElementNS(SVG, 'rect')
    bar.setAttribute('x', String(index + 0.15))
    bar.setAttribute('width', '0.7')
    bar.setAttribute('y', String(8 - height / 2))
    bar.setAttribute('height', String(height))
    wave.append(bar)
  }
  const time = document.createElement('span')
  time.className = 'audio-chip-time'
  time.textContent = asset ? formatClipDuration(asset.durationMs) : '–:––'
  element.append(button, wave, time)
  element.classList.toggle('playing', playingId === id && Boolean(player && !player.paused))
}

function hydrate(root: ParentNode) {
  if (root instanceof HTMLElement && root.matches(AUDIO_SELECTOR)) renderAudioChip(root)
  for (const element of root.querySelectorAll<HTMLElement>(AUDIO_SELECTOR)) renderAudioChip(element)
}

function chips(id: string) {
  return document.querySelectorAll<HTMLElement>(`[data-balance-audio="${CSS.escape(id)}"]`)
}

function showProgress() {
  cancelAnimationFrame(frame)
  if (!player || !playingId) return
  const duration = player.duration || (assets.get(playingId)?.durationMs ?? 0) / 1000
  const progress = duration > 0 ? Math.min(1, player.currentTime / duration) : 0
  for (const chip of chips(playingId)) {
    chip.style.setProperty('--audio-progress', String(progress))
    chip.classList.toggle('playing', !player.paused)
  }
  if (!player.paused) frame = requestAnimationFrame(showProgress)
}

async function source(asset: AudioAsset): Promise<string> {
  let url = sources.get(asset.id)
  if (!url) {
    url = URL.createObjectURL(await (await fetch(asset.dataURL)).blob())
    sources.set(asset.id, url)
  }
  return url
}

async function play(id: string, fraction: number | null) {
  const asset = assets.get(id)
  if (!asset) return
  if (playingId !== id || !player) {
    stop()
    player = new Audio(await source(asset))
    playingId = id
    player.addEventListener('ended', () => { showProgress(); if (player) player.currentTime = 0 })
    player.addEventListener('pause', showProgress)
    player.addEventListener('play', showProgress)
  } else if (fraction === null && !player.paused) {
    player.pause()
    return
  }
  if (fraction !== null) player.currentTime = fraction * (player.duration || asset.durationMs / 1000)
  await player.play().catch(() => {})
}

function stop() {
  if (!player || !playingId) return
  const id = playingId
  player.pause()
  player = null
  playingId = null
  for (const chip of chips(id)) {
    chip.classList.remove('playing')
    chip.style.removeProperty('--audio-progress')
  }
}

// Keeps chips current with the store and plays them from any surface.
export function installAudioChips(subscribe: (run: (audio: AudioAsset[]) => void) => () => void): () => void {
  let previous: AudioAsset[] | null = null
  const unsubscribe = subscribe((audio) => {
    if (audio === previous) return
    previous = audio
    assets.clear()
    for (const asset of audio) assets.set(asset.id, asset)
    for (const [id, url] of sources) if (!assets.has(id)) { URL.revokeObjectURL(url); sources.delete(id) }
    if (playingId && !assets.has(playingId)) stop()
    hydrate(document)
  })
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) hydrate(node)
  })
  observer.observe(document.body, { subtree: true, childList: true })
  const target = (event: Event) => event.target instanceof Element ? event.target.closest<HTMLElement>(AUDIO_SELECTOR) : null
  // The chip sits in editable text; pressing it must not move the caret.
  const press = (event: Event) => { if (target(event)) event.preventDefault() }
  const click = (event: MouseEvent) => {
    const chip = target(event)
    if (!chip || !(event.target instanceof Element)) return
    event.preventDefault()
    event.stopPropagation()
    const id = chip.dataset.balanceAudio ?? ''
    const wave = event.target.closest('.audio-chip-wave')
    if (wave) {
      const rect = wave.getBoundingClientRect()
      void play(id, rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0)
    } else void play(id, null)
  }
  document.addEventListener('mousedown', press, true)
  document.addEventListener('click', click, true)
  return () => {
    unsubscribe()
    observer.disconnect()
    document.removeEventListener('mousedown', press, true)
    document.removeEventListener('click', click, true)
    stop()
    for (const url of sources.values()) URL.revokeObjectURL(url)
    sources.clear()
    assets.clear()
  }
}
