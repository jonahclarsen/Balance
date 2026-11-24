// The idea sorter's warp displaces each card through fractal noise whose
// frequency changes every frame. Browsers recompute feTurbulence from scratch
// on every frame, which is most of the warp's cost. Fractal noise at frequency
// f is the same noise at frequency 1 scaled by 1/f, so one precomputed field,
// stretched by feImage each frame, draws the same warp for a fraction of the
// work. This is the SVG specification's reference turbulence, so the field is
// the noise feTurbulence itself draws.

// The field spans this many noise units on each axis.
export const WARP_NOISE_UNITS = 32
// Texels per noise unit, at least one per device pixel on a 2× display at the
// warp's highest frequencies.
const TEXELS_X = 64
const TEXELS_Y = 16
export const WARP_NOISE_WIDTH = WARP_NOISE_UNITS * TEXELS_X
export const WARP_NOISE_HEIGHT = WARP_NOISE_UNITS * TEXELS_Y

const B_SIZE = 0x100
const BM = 0xff
const PERLIN_N = 0x1000
const RAND_M = 2147483647
const RAND_A = 16807
const RAND_Q = 127773
const RAND_R = 2836

function random(seed: number) {
  const result = RAND_A * (seed % RAND_Q) - RAND_R * Math.floor(seed / RAND_Q)
  return result <= 0 ? result + RAND_M : result
}

// Two octaves of fractal noise for the red and green channels, the ones the
// warp's displacement maps read.
function lattice(seed: number) {
  let s = seed <= 0 ? -(seed % (RAND_M - 1)) + 1 : Math.min(seed, RAND_M - 1)
  const selector = new Int32Array(B_SIZE + B_SIZE + 2)
  const gradients = Array.from({ length: 4 }, () => new Float64Array((B_SIZE + B_SIZE + 2) * 2))
  let i = 0
  for (let channel = 0; channel < 4; channel += 1) {
    for (i = 0; i < B_SIZE; i += 1) {
      selector[i] = i
      const gradient = gradients[channel]!
      for (let axis = 0; axis < 2; axis += 1) {
        s = random(s)
        gradient[i * 2 + axis] = ((s % (B_SIZE + B_SIZE)) - B_SIZE) / B_SIZE
      }
      const length = Math.hypot(gradient[i * 2]!, gradient[i * 2 + 1]!)
      gradient[i * 2]! /= length
      gradient[i * 2 + 1]! /= length
    }
  }
  while (--i) {
    const k = selector[i]!
    s = random(s)
    const j = s % B_SIZE
    selector[i] = selector[j]!
    selector[j] = k
  }
  for (i = 0; i < B_SIZE + 2; i += 1) {
    selector[B_SIZE + i] = selector[i]!
    for (const gradient of gradients) {
      gradient[(B_SIZE + i) * 2] = gradient[i * 2]!
      gradient[(B_SIZE + i) * 2 + 1] = gradient[i * 2 + 1]!
    }
  }
  return { selector, gradients }
}

const sCurve = (t: number) => t * t * (3 - 2 * t)

function noise2(selector: Int32Array, gradient: Float64Array, x: number, y: number) {
  const tx = x + PERLIN_N
  const ty = y + PERLIN_N
  const bx0 = Math.trunc(tx) & BM
  const bx1 = (bx0 + 1) & BM
  const by0 = Math.trunc(ty) & BM
  const by1 = (by0 + 1) & BM
  const rx0 = tx - Math.trunc(tx)
  const rx1 = rx0 - 1
  const ry0 = ty - Math.trunc(ty)
  const ry1 = ry0 - 1
  const i = selector[bx0]!
  const j = selector[bx1]!
  const b00 = selector[i + by0]! * 2
  const b10 = selector[j + by0]! * 2
  const b01 = selector[i + by1]! * 2
  const b11 = selector[j + by1]! * 2
  const sx = sCurve(rx0)
  const sy = sCurve(ry0)
  let u = rx0 * gradient[b00]! + ry0 * gradient[b00 + 1]!
  let v = rx1 * gradient[b10]! + ry0 * gradient[b10 + 1]!
  const a = u + sx * (v - u)
  u = rx0 * gradient[b01]! + ry1 * gradient[b01 + 1]!
  v = rx1 * gradient[b11]! + ry1 * gradient[b11 + 1]!
  const b = u + sx * (v - u)
  return a + sy * (b - a)
}

// An uncompressed 24-bit BMP, so neither side spends time on compression:
// red and green hold the noise, and blue is unused like the warp's own.
export function warpNoiseBitmap(seed: number): Uint8Array<ArrayBuffer> {
  const { selector, gradients } = lattice(Math.round(seed))
  const width = WARP_NOISE_WIDTH
  const height = WARP_NOISE_HEIGHT
  const rowBytes = width * 3
  const header = 54
  const bytes = new Uint8Array(header + rowBytes * height)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x42
  bytes[1] = 0x4d
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, header, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  // A negative height stores rows top to bottom.
  view.setInt32(22, -height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, rowBytes * height, true)
  const channel = (index: number, x: number, y: number) => {
    const gradient = gradients[index]!
    const sum = noise2(selector, gradient, x, y) + noise2(selector, gradient, x * 2, y * 2) / 2
    return Math.max(0, Math.min(255, Math.round((sum * 255 + 255) / 2)))
  }
  for (let row = 0; row < height; row += 1) {
    const y = row / TEXELS_Y
    let offset = header + row * rowBytes
    for (let column = 0; column < width; column += 1) {
      const x = column / TEXELS_X
      bytes[offset++] = 0
      bytes[offset++] = channel(1, x, y)
      bytes[offset++] = channel(0, x, y)
    }
  }
  return bytes
}

// The highest frequencies the warp reaches on each axis.
export const WARP_MAX_FREQUENCY_X = .025
export const WARP_MAX_FREQUENCY_Y = .12
