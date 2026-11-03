import { get, writable } from 'svelte/store'
import { PEAKS_PER_SECOND } from './voiceClips'
import type { VoiceClip } from './types'

export const VOICE_BITRATE = 128_000
// WebM/Opus records in Chromium and WebKit and decodes in both.
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=opus', 'audio/ogg;codecs=opus']

export type VoiceRecordingState =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'recording'; startedAt: number; level: number }
  | { state: 'saving' }

export const voiceRecording = writable<VoiceRecordingState>({ state: 'idle' })
export const voiceRecordingError = writable<string | null>(null)

type AndroidVoiceInput = {
  permissions(): 'granted' | 'missing' | 'pending'
  requestPermissions(): void
  recordingStarted(startedAt: number): void
  recordingStopped(): void
}

const androidVoiceInput = () => (window as unknown as { BalanceVoiceInput?: AndroidVoiceInput }).BalanceVoiceInput

// Android only routes a Bluetooth headset's microphone to the WebView once
// Balance may connect to Bluetooth devices, and only shows the recording
// notification with its own permission (both asked at runtime).
async function allowNativeRecording() {
  const bridge = androidVoiceInput()
  if (!bridge || bridge.permissions() !== 'missing') return
  bridge.requestPermissions()
  const deadline = Date.now() + 60_000
  while (bridge.permissions() === 'pending' && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 200))
  }
}

// Chromium on Android lists a connected headset as its own input; elsewhere
// the system's current input (often the headphones already) is used.
async function headsetInput(): Promise<string | undefined> {
  if (!/android/i.test(navigator.userAgent)) return undefined
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.find((device) => device.kind === 'audioinput' && /bluetooth/i.test(device.label))?.deviceId
}

async function openMicrophone(): Promise<MediaStream> {
  await allowNativeRecording()
  let stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const headset = await headsetInput()
  if (headset && stream.getAudioTracks()[0]?.getSettings().deviceId !== headset) {
    stream.getTracks().forEach((track) => track.stop())
    stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: headset } } })
  }
  return stream
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export function peaksFromSamples(samples: Float32Array, sampleRate: number): number[] {
  const size = Math.max(1, Math.round(sampleRate / PEAKS_PER_SECOND))
  const peaks: number[] = []
  let loudest = 1e-4
  for (let start = 0; start < samples.length; start += size) {
    let sum = 0
    const end = Math.min(samples.length, start + size)
    for (let index = start; index < end; index += 1) sum += samples[index]! * samples[index]!
    const rms = Math.sqrt(sum / (end - start))
    peaks.push(rms)
    loudest = Math.max(loudest, rms)
  }
  // Normalized so quiet headset microphones still draw a readable waveform.
  return peaks.map((rms) => Math.round(Math.min(1, rms / loudest) * 255))
}

type RecordedClip = Pick<VoiceClip, 'dataURL' | 'durationMs' | 'peaks'>

let session: {
  recorder: MediaRecorder
  stream: MediaStream
  context: AudioContext
  chunks: Blob[]
  meter: number
  save: (clip: RecordedClip) => void | Promise<void>
} | null = null

// `save` runs whoever stops the recording, even after leaving Ideas.
export async function startVoiceRecording(save: (clip: RecordedClip) => void | Promise<void>) {
  if (session) return
  voiceRecordingError.set(null)
  voiceRecording.set({ state: 'starting' })
  try {
    const stream = await openMicrophone()
    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: VOICE_BITRATE })
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    context.createMediaStreamSource(stream).connect(analyser)
    const buffer = new Float32Array(analyser.fftSize)
    const startedAt = Date.now()
    const meter = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buffer)
      const level = Math.min(1, Math.sqrt(buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length) * 4)
      voiceRecording.set({ state: 'recording', startedAt, level })
    }, 80)
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
    session = { recorder, stream, context, chunks, meter, save }
    recorder.start(1000)
    androidVoiceInput()?.recordingStarted(startedAt)
    voiceRecording.set({ state: 'recording', startedAt, level: 0 })
  } catch (error) {
    voiceRecording.set({ state: 'idle' })
    voiceRecordingError.set(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Microphone access is off' : 'Could not record')
    console.error('Could not start recording', error)
  }
}

function release(current: NonNullable<typeof session>) {
  window.clearInterval(current.meter)
  current.stream.getTracks().forEach((track) => track.stop())
  void current.context.close()
  session = null
}

export function cancelVoiceRecording() {
  if (!session) return
  session.recorder.stop()
  release(session)
  voiceRecording.set({ state: 'idle' })
  androidVoiceInput()?.recordingStopped()
}

async function encodedClip(current: NonNullable<typeof session>): Promise<RecordedClip | null> {
  const blob = new Blob(current.chunks, { type: current.recorder.mimeType || 'audio/webm' })
  if (blob.size === 0) return null
  const decoded = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await blob.arrayBuffer())
  // Nothing audible was captured.
  if (decoded.duration < 0.3) return null
  return {
    dataURL: await blobToDataURL(blob),
    durationMs: Math.round(decoded.duration * 1000),
    peaks: peaksFromSamples(decoded.getChannelData(0), decoded.sampleRate),
  }
}

export async function finishVoiceRecording() {
  const current = session
  if (!current) return
  voiceRecording.set({ state: 'saving' })
  const stopped = new Promise((resolve) => { current.recorder.onstop = resolve })
  current.recorder.stop()
  await stopped
  release(current)
  try {
    const clip = await encodedClip(current)
    if (clip) await current.save(clip)
  } catch (error) {
    voiceRecordingError.set('Could not save')
    console.error('Could not save recording', error)
  } finally {
    voiceRecording.set({ state: 'idle' })
    androidVoiceInput()?.recordingStopped()
  }
}

if (typeof window !== 'undefined') {
  // The Android notification's Stop button.
  window.addEventListener('balance-voice-stop', () => {
    if (session) void finishVoiceRecording()
    else if (get(voiceRecording).state !== 'saving') androidVoiceInput()?.recordingStopped()
  })
  // A fresh page has no recording, so a notification left from before is stale.
  androidVoiceInput()?.recordingStopped()
}

// Decoding resamples to the context's rate: 16 kHz for Parakeet, 48 kHz to play.
export async function decodeClip(dataURL: string, sampleRate = 48_000): Promise<AudioBuffer> {
  const bytes = await (await fetch(dataURL)).arrayBuffer()
  return new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(bytes)
}
