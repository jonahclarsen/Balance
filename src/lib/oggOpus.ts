// Encodes mono audio to Opus with WebCodecs and wraps it in an Ogg stream
// (RFC 7845), which Chromium and WebKit both play and decode.

const RATE = 48_000
// libopus's lookahead at 48 kHz, for encoders that don't report an OpusHead.
const DEFAULT_PRE_SKIP = 312

let crcTable: Uint32Array | null = null

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index << 24
      for (let bit = 0; bit < 8; bit += 1) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1
      crcTable[index] = value >>> 0
    }
  }
  let crc = 0
  for (const byte of bytes) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 0xff]!) >>> 0
  return crc
}

function page(packets: Uint8Array[], granule: number, sequence: number, flags: number): Uint8Array {
  const lacing: number[] = []
  for (const packet of packets) {
    for (let left = packet.length; ; left -= 255) {
      lacing.push(Math.min(255, left))
      if (left < 255) break
    }
  }
  const body = packets.reduce((sum, packet) => sum + packet.length, 0)
  const bytes = new Uint8Array(27 + lacing.length + body)
  const view = new DataView(bytes.buffer)
  bytes.set([0x4f, 0x67, 0x67, 0x53], 0)
  bytes[5] = flags
  view.setBigUint64(6, BigInt(granule), true)
  view.setUint32(14, 0x42616c61, true)
  view.setUint32(18, sequence, true)
  bytes[26] = lacing.length
  bytes.set(lacing, 27)
  let offset = 27 + lacing.length
  for (const packet of packets) {
    bytes.set(packet, offset)
    offset += packet.length
  }
  view.setUint32(22, crc32(bytes), true)
  return bytes
}

// Samples at 48 kHz in an Opus packet, from its TOC byte (RFC 6716 §3.1).
export function opusPacketSamples(packet: Uint8Array): number {
  const toc = packet[0] ?? 0
  const config = toc >> 3
  const frame = config < 12 ? [480, 960, 1920, 2880][config % 4]! : config < 16 ? [480, 960][config % 2]! : [120, 240, 480, 960][config % 4]!
  const code = toc & 3
  const frames = code === 0 ? 1 : code < 3 ? 2 : (packet[1] ?? 0) & 0x3f
  return frame * frames
}

export function oggOpus(packets: Uint8Array[], preSkip: number, samples: number): Uint8Array {
  const head = new Uint8Array(19)
  const headView = new DataView(head.buffer)
  head.set(new TextEncoder().encode('OpusHead'))
  head[8] = 1
  head[9] = 1
  headView.setUint16(10, preSkip, true)
  headView.setUint32(12, RATE, true)
  const vendor = new TextEncoder().encode('Balance')
  const tags = new Uint8Array(8 + 4 + vendor.length + 4)
  tags.set(new TextEncoder().encode('OpusTags'))
  new DataView(tags.buffer).setUint32(8, vendor.length, true)
  tags.set(vendor, 12)

  const pages = [page([head], 0, 0, 0x02), page([tags], 0, 1, 0)]
  const end = preSkip + samples
  let granule = 0
  let batch: Uint8Array[] = []
  let segments = 0
  const flush = (last: boolean) => {
    // The last page's granule trims the encoder's padding from the end.
    pages.push(page(batch, last ? Math.min(granule, end) : granule, pages.length, last ? 0x04 : 0))
    batch = []
    segments = 0
  }
  packets.forEach((packet, index) => {
    const needed = Math.floor(packet.length / 255) + 1
    if (batch.length > 0 && (segments + needed > 255 || batch.length >= 50)) flush(false)
    batch.push(packet)
    segments += needed
    granule += opusPacketSamples(packet)
    if (index === packets.length - 1) flush(true)
  })
  if (packets.length === 0) pages.push(page([], 0, pages.length, 0x04))
  const output = new Uint8Array(pages.reduce((sum, bytes) => sum + bytes.length, 0))
  let offset = 0
  for (const bytes of pages) {
    output.set(bytes, offset)
    offset += bytes.length
  }
  return output
}

function preSkipFrom(description: AllowSharedBufferSource | undefined): number {
  if (!description) return DEFAULT_PRE_SKIP
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description)
  if (bytes.length < 19 || new TextDecoder().decode(bytes.subarray(0, 8)) !== 'OpusHead') return DEFAULT_PRE_SKIP
  return bytes[10]! | (bytes[11]! << 8)
}

export function canEncodeOpus(): boolean {
  return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined'
}

// Mono samples at 48 kHz to an Ogg Opus file at the given bitrate.
export async function encodeOggOpus(samples: Float32Array, bitrate: number): Promise<Uint8Array> {
  if (!canEncodeOpus()) throw new Error('This device cannot encode Opus audio.')
  const packets: Uint8Array[] = []
  let preSkip = DEFAULT_PRE_SKIP
  let failure: unknown = null
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      if (metadata?.decoderConfig) preSkip = preSkipFrom(metadata.decoderConfig.description)
      const packet = new Uint8Array(chunk.byteLength)
      chunk.copyTo(packet)
      packets.push(packet)
    },
    error: (error) => { failure = error },
  })
  try {
    encoder.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate })
    const frame = 4800
    for (let start = 0; start < samples.length; start += frame) {
      const data = samples.slice(start, Math.min(samples.length, start + frame))
      const audio = new AudioData({
        format: 'f32-planar', sampleRate: RATE, numberOfChannels: 1,
        numberOfFrames: data.length, timestamp: Math.round((start / RATE) * 1_000_000), data,
      })
      encoder.encode(audio)
      audio.close()
    }
    await encoder.flush()
  } finally {
    if (encoder.state !== 'closed') encoder.close()
  }
  if (failure) throw failure
  return oggOpus(packets, preSkip, samples.length)
}
