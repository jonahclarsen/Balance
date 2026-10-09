import { expect, test } from '@playwright/test'
import { parseBrowserState, serializeBrowserState } from '../../src/lib/browserState'
import { createInitialState } from '../../src/lib/planner'

test('browser snapshots store image bytes once and restore exact operation payloads', () => {
  const state = createInitialState()
  const asset = { id: 'a'.repeat(64), dataURL: `data:image/png;base64,${'A'.repeat(1_500_000)}`, bytes: 1_125_000, width: 3200, height: 2000 }
  state.images = [asset]
  state.operations = [{
    id: 'op_synthetic_1', deviceId: state.deviceId, sequence: 1,
    type: 'apply_entity_changes', timestamp: '2026-10-01T12:00:00Z',
    payload: { entityChanges: { version: 2, upserts: [{
      collection: 'images', key: asset.id, value: asset,
      patches: [{ path: ['dataURL'], value: asset.dataURL }],
    }], deletes: [] }, unknown: { text: 'balance:browser-image:0', nested: 'balance:browser-image::literal' } },
  }]
  const before = JSON.stringify(state)
  const serialized = serializeBrowserState(state)
  expect(serialized.length * 2).toBeLessThan(5 * 1024 * 1024)
  expect(JSON.parse(serialized).images[0]).toEqual(asset)
  expect(parseBrowserState(serialized)).toEqual(state)
  expect(JSON.stringify(state)).toBe(before)

  // Historical operations may retain an image absent from the current assets.
  state.images = []
  expect(parseBrowserState(serializeBrowserState(state))).toEqual(state)
})

test('plain legacy browser snapshots keep literal reference-like text intact', () => {
  const state = createInitialState()
  state.templates[0].name = 'balance:browser-image:0'
  expect(parseBrowserState(JSON.stringify(state))).toEqual(state)
  expect(parseBrowserState(serializeBrowserState(state))).toEqual(state)
})

test('a missing browser image reference fails instead of restoring corrupt data', () => {
  expect(() => parseBrowserState(JSON.stringify({ browserImageEncoding: 1, dataURL: 'balance:browser-image:9' }))).toThrow('Invalid browser image reference')
})
