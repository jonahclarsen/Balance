import encode, { init } from '@jsquash/webp/encode.js'
import wasmURL from '@jsquash/webp/codec/enc/webp_enc.wasm?url'
import simdURL from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?url'

self.onmessage = async (event: MessageEvent<{ pixels: ImageData; quality: number }>) => {
  try {
    await init({ locateFile: (path: string) => path.includes('simd') ? simdURL : wasmURL })
    const bytes = await encode(event.data.pixels, { quality: event.data.quality })
    self.postMessage({ bytes }, { transfer: [bytes] })
  } catch (error) { self.postMessage({ error: String(error) }) }
}
