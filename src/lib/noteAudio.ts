import { createId } from './planner'
import { encodeOggOpus } from './oggOpus'
import { decodeClip } from './voiceRecorder'
import type { AudioAsset, VoiceClip } from './types'

// Voice notes are stored as 64 kbps mono Opus, half the recording's bitrate.
export const NOTE_VOICE_BITRATE = 64_000

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

export async function noteAudioFromClip(clip: VoiceClip): Promise<AudioAsset> {
  const decoded = await decodeClip(clip.dataURL, 48_000)
  const samples = new Float32Array(decoded.length)
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const data = decoded.getChannelData(channel)
    for (let index = 0; index < data.length; index += 1) samples[index]! += data[index]! / decoded.numberOfChannels
  }
  const bytes = await encodeOggOpus(samples, NOTE_VOICE_BITRATE)
  return {
    id: createId('audio'),
    dataURL: `data:audio/ogg;codecs=opus;base64,${base64(bytes)}`,
    durationMs: clip.durationMs,
    peaks: clip.peaks,
    bytes: bytes.length,
  }
}
