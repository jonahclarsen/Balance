import { expect, test } from '@playwright/test'

// The precomputed field must be the noise feTurbulence itself draws.
test('the warp noise field matches feTurbulence', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const path = '/src/lib/warpNoiseField.ts'
    const { warpNoiseBitmap, WARP_NOISE_WIDTH } = await import(/* @vite-ignore */ path)
    const seed = 417
    const bytes: Uint8Array = warpNoiseBitmap(seed)
    const width = 256
    const height = 64
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><filter id="n" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="${1 / 64} ${1 / 16}" numOctaves="2" seed="${seed}"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1"/></filter><rect width="${width}" height="${height}" filter="url(#n)"/></svg>`
    const image = new Image()
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const drawn = context.getImageData(0, 0, width, height).data
    let total = 0
    let worst = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        // Browsers sample each pixel one unit past its corner.
        const field = 54 + ((y + 1) * WARP_NOISE_WIDTH + x + 1) * 3
        for (const [channel, offset] of [[0, 2], [1, 1]] as const) {
          const difference = Math.abs(drawn[(y * width + x) * 4 + channel]! - bytes[field + offset]!)
          total += difference
          worst = Math.max(worst, difference)
        }
      }
    }
    return { mean: total / (width * height * 2), worst }
  })
  console.log(`WARP_NOISE_FIELD ${JSON.stringify(result)}`)
  expect(result.mean).toBeLessThan(1)
})
