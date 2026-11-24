import { warpNoiseBitmap } from './warpNoiseField'

self.onmessage = (event: MessageEvent<number>) => {
  try {
    const bytes = warpNoiseBitmap(event.data)
    self.postMessage(bytes.buffer, { transfer: [bytes.buffer] })
  } catch {
    self.postMessage(null)
  }
}
