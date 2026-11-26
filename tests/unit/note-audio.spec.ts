import { expect, test } from '@playwright/test'
import { oggOpus, opusPacketSamples } from '../../src/lib/oggOpus'
import { audioHTML, audioReferences, reconcileAudio } from '../../src/lib/audioMarkup'
import type { AppState, AudioAsset } from '../../src/lib/types'

test('Opus packet durations come from the TOC byte', () => {
  // CELT 20 ms, one frame; SILK 60 ms, two frames; code 3 with three frames of 20 ms.
  expect(opusPacketSamples(Uint8Array.of(0xf8))).toBe(960)
  expect(opusPacketSamples(Uint8Array.of((3 << 3) | 1))).toBe(5760)
  expect(opusPacketSamples(Uint8Array.of(0xfb, 3))).toBe(2880)
})

test('the Ogg stream has head, tags and a final page that trims the padding', () => {
  const packets = Array.from({ length: 120 }, () => new Uint8Array(160).fill(0xf8))
  const bytes = oggOpus(packets, 312, 48_000 * 2)
  const pages: { flags: number; granule: number; sequence: number }[] = []
  const view = new DataView(bytes.buffer)
  for (let offset = 0; offset < bytes.length;) {
    expect(String.fromCharCode(...bytes.subarray(offset, offset + 4))).toBe('OggS')
    const segments = bytes[offset + 26]!
    const body = bytes.subarray(offset + 27, offset + 27 + segments).reduce((sum, value) => sum + value, 0)
    pages.push({ flags: bytes[offset + 5]!, granule: Number(view.getBigUint64(offset + 6, true)), sequence: view.getUint32(offset + 18, true) })
    offset += 27 + segments + body
  }
  expect(new TextDecoder().decode(bytes.subarray(28, 36))).toBe('OpusHead')
  expect(pages[0]!.flags).toBe(2)
  expect(pages.map((page) => page.sequence)).toEqual(pages.map((_, index) => index))
  expect(pages.at(-1)).toMatchObject({ flags: 4, granule: 312 + 96_000 })
  expect(pages.slice(2, -1).every((page) => page.flags === 0)).toBe(true)
})

test('audio stays while text references it and comes back with its reference', () => {
  const asset: AudioAsset = { id: 'audio_synthetic', dataURL: 'data:audio/ogg;base64,', durationMs: 1000, peaks: [1], bytes: 0 }
  const note = (html: string) => ({ id: 'note_a', title: 'A', items: [{ id: 'item', text: '', html }] })
  const withNote = { audio: [asset], notes: [note(`Spoken ${audioHTML(asset.id)}`)] } as unknown as AppState
  expect([...audioReferences(withNote)]).toEqual([asset.id])
  expect(reconcileAudio(withNote)).toBe(withNote)
  const removed = reconcileAudio({ ...withNote, notes: [note('Spoken')] })
  expect(removed.audio).toEqual([])
  // Pasting the chip back restores the bytes it had this session.
  expect(reconcileAudio({ ...removed, notes: [note(audioHTML(asset.id))] }).audio).toEqual([asset])
  expect(audioHTML('bad id"><img>')).toBe('')
})
