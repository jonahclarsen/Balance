import { get, writable } from 'svelte/store'
import { createId } from './planner'
import { plannerStore } from './store'
import { appendVoiceChunk, removeVoiceChunks, unfinishedVoiceRecordings } from './voiceChunkStore'
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

export type VoiceMic = 'headset' | 'phone'

const MIC_KEY = 'balance-voice-mic'
const PHONE_DEVICE_KEY = 'balance-voice-phone-device'

function readSetting(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function writeSetting(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* Only a convenience. */ }
}

// Only Android routes between a headset's microphone and the phone's own.
export const canChooseVoiceMic = () => Boolean(androidVoiceInput())
export const voiceMic = writable<VoiceMic>(readSetting(MIC_KEY) === 'phone' ? 'phone' : 'headset')
export function chooseVoiceMic(mic: VoiceMic) {
  voiceMic.set(mic)
  writeSetting(MIC_KEY, mic)
}

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

// Chromium only enters Android's call mode when voice processing is on, and a
// default input selects a connected headset, so music is left alone only by
// turning processing off and naming the phone's microphone. Android lists it
// under the matching output device.
const UNPROCESSED = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

function phoneInput(devices: MediaDeviceInfo[]) {
  const inputs = devices.filter((device) => device.kind === 'audioinput' && !/bluetooth|headset|wired|usb/i.test(device.label))
  return inputs.find((device) => /speaker/i.test(device.label)) ?? inputs.find((device) => /earpiece/i.test(device.label))
}

async function openPhoneMicrophone(): Promise<MediaStream> {
  // Device names stay hidden until the microphone opens, so the last known
  // device avoids briefly selecting the headset and interrupting its music.
  const known = readSetting(PHONE_DEVICE_KEY)
  let stream = await navigator.mediaDevices.getUserMedia({ audio: { ...UNPROCESSED, ...(known ? { deviceId: { ideal: known } } : {}) } })
  const phone = phoneInput(await navigator.mediaDevices.enumerateDevices())
  if (!phone) return stream
  writeSetting(PHONE_DEVICE_KEY, phone.deviceId)
  if (stream.getAudioTracks()[0]?.getSettings().deviceId !== phone.deviceId) {
    stream.getTracks().forEach((track) => track.stop())
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...UNPROCESSED, deviceId: { exact: phone.deviceId } } })
  }
  return stream
}

const audioInputs = async () => (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput')
// Chromium on Android lists a connected Bluetooth headset as its own input.
const isBluetooth = (device: MediaDeviceInfo) => /bluetooth/i.test(device.label)

// The microphone actually open: the headset choice falls back to the phone
// while no Bluetooth microphone is connected.
export type VoiceInput = { mic: VoiceMic; headsetAvailable: boolean; label: string }
export const voiceInput = writable<VoiceInput | null>(null)

type OpenedMicrophone = { stream: MediaStream; mic: VoiceMic; headsetAvailable: boolean }

async function openMicrophone(): Promise<OpenedMicrophone> {
  await allowNativeRecording()
  // Elsewhere the system's current input (often the headphones already) is used.
  if (!canChooseVoiceMic()) return { stream: await navigator.mediaDevices.getUserMedia({ audio: true }), mic: 'headset', headsetAvailable: false }
  let headset = (await audioInputs()).find(isBluetooth)
  // Device names stay hidden until a microphone opens, so without a known
  // headset the phone's opens first: it leaves music alone.
  if (!headset || get(voiceMic) === 'phone') {
    const stream = await openPhoneMicrophone()
    headset = (await audioInputs()).find(isBluetooth)
    if (!headset || get(voiceMic) === 'phone') return { stream, mic: 'phone', headsetAvailable: Boolean(headset) }
    stream.getTracks().forEach((track) => track.stop())
  }
  return { stream: await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: headset.deviceId } } }), mic: 'headset', headsetAvailable: true }
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

// The recorder takes its audio from an AudioContext rather than the
// microphone itself, so the microphone can change mid-recording: a MediaRecorder
// stops when its stream's tracks change.
type Session = {
  id: string
  recorder: MediaRecorder
  input: MediaStream
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  context: AudioContext
  chunks: Blob[]
  meter: number
  startedAt: number
  written: Promise<unknown>
  stopping: boolean
  unwatch: () => void
}

let session: Session | null = null

export const voiceMicSwitching = writable(false)

export async function startVoiceRecording() {
  if (session || get(voiceRecording).state !== 'idle') return
  voiceRecordingError.set(null)
  voiceRecording.set({ state: 'starting' })
  // Created before the microphone opens, while the tap still counts as one.
  const context = new AudioContext()
  try {
    const opened = await openMicrophone()
    const input = opened.stream
    // Never awaited: without a user gesture it would wait forever.
    if (context.state === 'suspended') void context.resume()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    const output = context.createMediaStreamDestination()
    output.channelCount = 1
    analyser.connect(output)
    const source = context.createMediaStreamSource(input)
    source.connect(analyser)
    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
    const recorder = new MediaRecorder(output.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: VOICE_BITRATE })
    const buffer = new Float32Array(analyser.fftSize)
    const startedAt = Date.now()
    const meter = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buffer)
      const level = Math.min(1, Math.sqrt(buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length) * 4)
      voiceRecording.set({ state: 'recording', startedAt, level })
    }, 80)
    const chunks: Blob[] = []
    const id = createId('voice')
    const current: Session = { id, recorder, input, source, analyser, context, chunks, meter, startedAt, written: Promise.resolve(), stopping: false, unwatch: () => {} }
    let sequence = 0
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return
      chunks.push(event.data)
      // A failed write only costs recovery: the chunks in memory still save.
      current.written = appendVoiceChunk({ recordingId: id, sequence: sequence++, startedAt, mimeType: recorder.mimeType, data: event.data })
        .catch((error) => console.error('Could not keep a recording chunk', error))
    }
    session = current
    recorder.start(1000)
    showInput(opened)
    current.unwatch = watchHeadset(current)
    androidVoiceInput()?.recordingStarted(startedAt)
    voiceRecording.set({ state: 'recording', startedAt, level: 0 })
  } catch (error) {
    void context.close()
    voiceRecording.set({ state: 'idle' })
    voiceRecordingError.set(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Microphone access is off' : 'Could not record')
    console.error('Could not start recording', error)
  }
}

function showInput({ stream, mic, headsetAvailable }: OpenedMicrophone) {
  voiceInput.set({ mic, headsetAvailable, label: stream.getAudioTracks()[0]?.label ?? '' })
}

// A headset connecting enables its choice; one disconnecting mid-recording
// hands over to the phone.
function watchHeadset(current: Session) {
  if (!canChooseVoiceMic()) return () => {}
  const changed = async () => {
    const headsetAvailable = (await audioInputs()).some(isBluetooth)
    const shown = get(voiceInput)
    if (session !== current || current.stopping || !shown || get(voiceMicSwitching)) return
    if (shown.mic === 'headset' && !headsetAvailable) void reopenMicrophone(current)
    else voiceInput.set({ ...shown, headsetAvailable })
  }
  navigator.mediaDevices.addEventListener('devicechange', changed)
  return () => navigator.mediaDevices.removeEventListener('devicechange', changed)
}

// The old microphone closes first: Android may not open two at once, and
// leaving a headset's microphone open would keep its call profile on. The
// recording carries on through the gap as silence.
async function reopenMicrophone(current: Session, undoChoice?: () => void) {
  voiceMicSwitching.set(true)
  current.source.disconnect()
  current.input.getTracks().forEach((track) => track.stop())
  try {
    let opened: OpenedMicrophone
    try {
      opened = await openMicrophone()
    } catch (error) {
      if (!undoChoice) throw error
      console.error('Could not switch microphones', error)
      voiceRecordingError.set('Could not switch microphones')
      undoChoice()
      opened = await openMicrophone()
    }
    if (session !== current) {
      opened.stream.getTracks().forEach((track) => track.stop())
      return
    }
    current.input = opened.stream
    current.source = current.context.createMediaStreamSource(opened.stream)
    current.source.connect(current.analyser)
    showInput(opened)
  } catch (error) {
    // Without a microphone, keep what was recorded.
    console.error('Could not reopen the microphone', error)
    if (session === current) await finishVoiceRecording()
  } finally {
    voiceMicSwitching.set(false)
  }
}

export async function switchVoiceMic(mic: VoiceMic) {
  const current = session
  if (!current || current.stopping || mic === get(voiceInput)?.mic || get(voiceMicSwitching)) return
  const previous = get(voiceMic)
  chooseVoiceMic(mic)
  await reopenMicrophone(current, () => chooseVoiceMic(previous))
}

function release(current: Session) {
  window.clearInterval(current.meter)
  current.unwatch()
  voiceInput.set(null)
  current.input.getTracks().forEach((track) => track.stop())
  void current.context.close()
  session = null
}

type Recording = { id: string; startedAt: number; mimeType: string; chunks: Blob[] }

// Null when nothing audible was captured.
async function encodedClip(recording: Recording): Promise<Pick<VoiceClip, 'id' | 'createdAt' | 'dataURL' | 'durationMs' | 'peaks'> | null> {
  const blob = new Blob(recording.chunks, { type: recording.mimeType || 'audio/webm' })
  if (blob.size === 0) return null
  const decoded = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await blob.arrayBuffer())
  if (decoded.duration < 0.3) return null
  return {
    // The recording's id makes saving it twice impossible, if the app dies
    // between saving a clip and removing its chunks.
    id: recording.id,
    createdAt: new Date(recording.startedAt).toISOString(),
    dataURL: await blobToDataURL(blob),
    durationMs: Math.round(decoded.duration * 1000),
    peaks: peaksFromSamples(decoded.getChannelData(0), decoded.sampleRate),
  }
}

export type VoiceIdeaText = { text: string; html: string }

async function saveRecording(clip: NonNullable<Awaited<ReturnType<typeof encodedClip>>>, typed?: VoiceIdeaText) {
  plannerStore.addVoiceIdea(clip, typed)
  // The app may be in the background, where it can be frozen at any time.
  await plannerStore.flushPendingOperations()
}

// Typed text, from the Add idea dialog, goes in the clip's idea.
export async function finishVoiceRecording(typed?: VoiceIdeaText) {
  const current = session
  if (!current || current.stopping) return
  current.stopping = true
  // The meter would otherwise report recording again.
  window.clearInterval(current.meter)
  voiceRecording.set({ state: 'saving' })
  const stopped = new Promise((resolve) => { current.recorder.onstop = resolve })
  current.recorder.stop()
  await stopped
  release(current)
  let pendingText = typed
  try {
    const clip = await encodedClip({ id: current.id, startedAt: current.startedAt, mimeType: current.recorder.mimeType, chunks: current.chunks })
    const save = clip ? saveRecording(clip, pendingText) : saveTyped(pendingText)
    pendingText = undefined
    await save
    await current.written
    await removeVoiceChunks(current.id)
  } catch (error) {
    voiceRecordingError.set('Could not save')
    console.error('Could not save recording', error)
    // The chunks stay for recovery; the words can't wait for it.
    await saveTyped(pendingText).catch((saveError) => console.error('Could not save the typed idea', saveError))
  } finally {
    voiceRecording.set({ state: 'idle' })
    androidVoiceInput()?.recordingStopped()
  }
}

async function saveTyped(typed?: VoiceIdeaText) {
  if (!typed?.text.trim()) return
  plannerStore.addIdea(typed.text, 'proposition', typed.html)
  await plannerStore.flushPendingOperations()
}

// Saves what was on disk when the app last closed mid-recording. Runs once the
// workspace has loaded; the clips then sync like any other.
export async function recoverVoiceRecordings() {
  try {
    for (const recording of await unfinishedVoiceRecordings()) {
      if (recording.id === session?.id) continue
      let clip: Awaited<ReturnType<typeof encodedClip>> = null
      try {
        clip = await encodedClip(recording)
      } catch (error) {
        // Without its first chunk the audio can never decode; don't keep it.
        console.error('Could not decode an unfinished recording', error)
      }
      if (clip) await saveRecording(clip)
      await removeVoiceChunks(recording.id)
    }
  } catch (error) {
    // The chunks stay on disk for the next launch.
    console.error('Could not recover a recording', error)
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
