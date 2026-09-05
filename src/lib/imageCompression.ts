// Each preview can be cancelled, including an in-progress WASM encode. No
// images leave the device and stale slider positions cannot queue up work.
export function encodeWebP(pixels: ImageData, quality: number, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./imageEncoder.worker.ts', import.meta.url), { type: 'module' })
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(new DOMException('Preview replaced', 'AbortError')) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<{ bytes?: ArrayBuffer; error?: string }>) => {
      cleanup()
      if (event.data.bytes) resolve(new Blob([event.data.bytes], { type: 'image/webp' }))
      else reject(new Error(event.data.error ?? 'Could not encode this image.'))
    }
    worker.onerror = (event) => { cleanup(); reject(new Error(event.message || 'Could not start the image encoder.')) }
    worker.postMessage({ pixels, quality }, [pixels.data.buffer])
  })
}
