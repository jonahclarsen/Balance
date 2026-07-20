import { writeFile } from 'node:fs/promises'
import QRCode from 'qrcode'
import pngjs from 'pngjs'

const { PNG } = pngjs

// A deterministic, valid Balance pairing key used only by the Android camera
// E2E. The matching QR is presented to the emulator as its back-camera image.
const pairingCode =
  'BALSYNC1:AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPWGDONFE'

// The emulator reads this as a landscape 4:3 camera-sensor frame, then CameraX
// fills a portrait preview from it. The image-file camera preserves the source
// x coordinate while that fill transform crops the right side, so keep the QR
// in the sensor's safe left region. CameraX analyzes this at 640x480, leaving
// more than four pixels per QR module after scaling.
const frameWidth = 960
const frameHeight = 720
const quietZoneModules = 6
const modulePixels = 8
const qr = QRCode.create(pairingCode, { errorCorrectionLevel: 'M' })
const renderedQrSize = (qr.modules.size + quietZoneModules * 2) * modulePixels
const qrLeft = 32
const qrTop = Math.floor((frameHeight - renderedQrSize) / 2)
const frame = new PNG({ width: frameWidth, height: frameHeight })

frame.data.fill(255)
for (let row = 0; row < qr.modules.size; row += 1) {
  for (let column = 0; column < qr.modules.size; column += 1) {
    if (!qr.modules.get(row, column)) continue

    const left = qrLeft + (column + quietZoneModules) * modulePixels
    const top = qrTop + (row + quietZoneModules) * modulePixels
    for (let y = top; y < top + modulePixels; y += 1) {
      for (let x = left; x < left + modulePixels; x += 1) {
        const offset = (y * frameWidth + x) * 4
        frame.data[offset] = 0
        frame.data[offset + 1] = 0
        frame.data[offset + 2] = 0
        frame.data[offset + 3] = 255
      }
    }
  }
}

await writeFile('sync-e2e-pairing.png', PNG.sync.write(frame))
await writeFile('sync-e2e-pairing-code.txt', `${pairingCode}\n`)
