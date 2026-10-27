import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { writable } from 'svelte/store'
import { decodeClip } from './voiceRecorder'
import type { Id, VoiceClip, VoiceWord } from './types'

// Parakeet runs through Core ML, so only the macOS app transcribes.
export const canTranscribe = typeof navigator !== 'undefined' && isTauri() &&
  /Macintosh|Mac OS X/.test(navigator.userAgent) && !/iPhone|iPad|Android/.test(navigator.userAgent)

export type TranscriptionStatus =
  | { state: 'idle' }
  | { state: 'preparing'; total: number }
  | { state: 'downloading'; fraction: number }
  | { state: 'transcribing'; done: number; total: number }

export const transcriptionStatus = writable<TranscriptionStatus>({ state: 'idle' })
export const transcriptionError = writable<string | null>(null)

type HelperEvent =
  | { event: 'download'; model: string; fraction: number }
  | { event: 'model'; model: string }
  | { event: 'result'; index: number; model: string; text: string; words: VoiceWord[] }
  | { event: 'error'; message: string }

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  return btoa(binary)
}

async function pcm16(clip: VoiceClip): Promise<string> {
  const samples = (await decodeClip(clip.dataURL, 16_000)).getChannelData(0)
  const pcm = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    pcm[index] = Math.max(-32768, Math.min(32767, Math.round(samples[index]! * 32767)))
  }
  return base64(new Uint8Array(pcm.buffer))
}

let running = false

export async function transcribeClips(clips: VoiceClip[], apply: (clipId: Id, transcript: NonNullable<VoiceClip['transcript']>) => void) {
  if (running || clips.length === 0) return
  running = true
  transcriptionError.set(null)
  transcriptionStatus.set({ state: 'preparing', total: clips.length })
  let done = 0
  try {
    const samples = await Promise.all(clips.map(pcm16))
    const onEvent = new Channel<HelperEvent>()
    onEvent.onmessage = (message) => {
      if (message.event === 'download') {
        transcriptionStatus.set({ state: 'downloading', fraction: message.fraction })
      } else if (message.event === 'model') {
        transcriptionStatus.set({ state: 'transcribing', done, total: clips.length })
      } else if (message.event === 'result') {
        const clip = clips[message.index]
        if (clip) apply(clip.id, { text: message.text, words: message.words, model: message.model, transcribedAt: new Date().toISOString() })
        done += 1
        transcriptionStatus.set({ state: 'transcribing', done, total: clips.length })
      }
    }
    await invoke('transcribe_voice_clips', { clips: samples, onEvent })
  } catch (error) {
    transcriptionError.set(typeof error === 'string' ? error : 'Could not transcribe')
    console.error('Could not transcribe voice ideas', error)
  } finally {
    running = false
    transcriptionStatus.set({ state: 'idle' })
  }
}
