// Loads the precomputed field described in warpNoiseField.ts.

let field: Promise<string | null> | null = null

// Built once per session off the main thread. Until it's ready, or if a
// worker can't run, the warp draws its noise live.
export function warpNoiseURL(): Promise<string | null> {
  field ??= new Promise((resolve) => {
    try {
      const worker = new Worker(new URL('./warpNoise.worker.ts', import.meta.url), { type: 'module' })
      const done = (url: string | null) => { worker.terminate(); resolve(url) }
      worker.onmessage = async (event: MessageEvent<ArrayBuffer | null>) => {
        if (!event.data) return done(null)
        const url = URL.createObjectURL(new Blob([event.data], { type: 'image/bmp' }))
        // Decode now so the first warp that uses it doesn't.
        const image = new Image()
        image.src = url
        try { await image.decode() } catch { return done(null) }
        done(url)
      }
      worker.onerror = () => done(null)
      worker.postMessage(crypto.getRandomValues(new Uint32Array(1))[0]! % 1000)
    } catch {
      resolve(null)
    }
  })
  return field
}
