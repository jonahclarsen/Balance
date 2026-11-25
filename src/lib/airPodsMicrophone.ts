export type AndroidAirPodsInput = {
  startAirPodsMic(): boolean
  readAirPodsMic(): string | null
  stopAirPodsMic(): void
}

const POLL_MS = 65
const START_TIMEOUT_MS = 4_500
const STALL_TIMEOUT_MS = 1_500

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

export async function openAirPodsMicrophone(context: AudioContext, bridge: AndroidAirPodsInput) {
  if (!bridge.startAirPodsMic()) return null
  let opened = false
  try {
    const deadline = performance.now() + START_TIMEOUT_MS
    let first: string | null
    do {
      first = bridge.readAirPodsMic()
      if (first === null) return null
      if (first) break
      await wait(POLL_MS)
    } while (performance.now() < deadline)
    if (!first) return null

    const source = context.createGain()
    let timer: number | undefined
    let nextTime = context.currentTime + 0.15
    let lastAudio = performance.now()
    let closed = false

    // Native sends mono signed 16-bit little-endian PCM. Queue chunks on the
    // Web Audio clock, then record them through the same graph as the phone mic.
    function enqueue(chunk: string) {
      const separator = chunk.indexOf(':')
      const rate = Number(chunk.slice(0, separator))
      const pcm = atob(chunk.slice(separator + 1))
      const samples = pcm.length / 2
      if (!Number.isInteger(samples) || samples < 1 || rate < 8_000 || rate > 96_000 || !Number.isInteger(rate)) {
        throw new Error('Invalid AirPods audio')
      }
      const buffer = context.createBuffer(1, samples, rate)
      const channel = buffer.getChannelData(0)
      for (let index = 0; index < samples; index++) {
        const sample = pcm.charCodeAt(index * 2) | (pcm.charCodeAt(index * 2 + 1) << 8)
        channel[index] = (sample << 16 >> 16) / 32768
      }
      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(source)
      node.onended = () => node.disconnect()
      nextTime = Math.max(nextTime, context.currentTime + 0.02)
      node.start(nextTime)
      nextTime += buffer.duration
      lastAudio = performance.now()
    }

    function close() {
      if (closed) return
      closed = true
      window.clearInterval(timer)
      bridge.stopAirPodsMic()
    }

    // Validate the first chunk before reporting success. Its scheduled start
    // follows MediaRecorder.start(), which runs as soon as this promise resolves.
    enqueue(first)
    opened = true
    return {
      source,
      close,
      watch(onLost: () => void) {
        timer = window.setInterval(() => {
          try {
            const chunk = bridge.readAirPodsMic()
            if (chunk) {
              enqueue(chunk)
              return
            }
            if (chunk !== null && performance.now() - lastAudio < STALL_TIMEOUT_MS) return
          } catch (error) {
            console.error('Could not read AirPods audio', error)
          }
          close()
          onLost()
        }, POLL_MS)
      },
      async drain() {
        if (!closed) {
          try {
            const chunk = bridge.readAirPodsMic()
            if (chunk) enqueue(chunk)
          } finally {
            close()
          }
        }
        if (context.state === 'running') {
          await wait(Math.min(1_100, Math.max(0, (nextTime - context.currentTime) * 1_000)))
        }
      },
    }
  } finally {
    if (!opened) bridge.stopAirPodsMic()
  }
}
