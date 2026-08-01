import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'

import { RelayRoom } from './index.js'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const CHUNK_BYTES = 96 * 1024

class MemoryStorage {
  values = new Map()

  async get(key) {
    return this.values.get(key)
  }

  async put(keyOrEntries, value) {
    const entries = typeof keyOrEntries === 'string'
      ? [[keyOrEntries, value]]
      : Object.entries(keyOrEntries)
    assert(entries.length <= 128, 'Durable Object put exceeded 128 keys')
    for (const [key, entry] of entries) {
      const bytes = entry instanceof ArrayBuffer
        ? entry.byteLength
        : Buffer.byteLength(JSON.stringify(entry))
      assert(bytes <= 128 * 1024, `${key} exceeded the Durable Object value limit`)
      this.values.set(key, entry)
    }
  }

  async delete(keys) {
    const list = Array.isArray(keys) ? keys : [keys]
    assert(list.length <= 128, 'Durable Object delete exceeded 128 keys')
    for (const key of list) this.values.delete(key)
  }

  async deleteAll() {
    this.values.clear()
  }
}

async function body(response) {
  const parsed = await response.json()
  assert(response.ok, `${response.status}: ${JSON.stringify(parsed)}`)
  return parsed
}

test('Durable Object contract chunks values and imports deployed v2 storage', async () => {
  const storage = new MemoryStorage()
  await storage.put({
    sequences: [1],
    nextSequence: 2,
    'e:1:chunks': 1,
    'e:1:0': '[1,2,3]',
  })
  const room = new RelayRoom({ storage })

  assert.deepEqual(await (await room.fetch(new Request('https://relay/pull'))).json(), [[1, 2, 3]])
  const initial = await body(await room.fetch(new Request('https://relay/v3/manifest?epoch=&after=0')))
  const batch = new Uint8Array(CHUNK_BYTES * 2 + 5).fill(7)
  const accepted = await body(await room.fetch(new Request('https://relay/v3/batches', {
    method: 'POST',
    headers: {
      'x-balance-epoch': initial.epoch,
      'x-balance-device': 'device-token',
      'x-balance-batch': 'batch-token',
    },
    body: batch,
  })))
  assert.equal(accepted.sequence, 1)
  const manifest = await body(await room.fetch(new Request(`https://relay/v3/manifest?epoch=${initial.epoch}&after=0`)))
  assert.equal(manifest.batches[0].chunks, 3)

  const checkpoint = new Uint8Array(CHUNK_BYTES + 9).fill(8)
  const metadata = {
    uploadId: 'checkpoint-upload',
    expectedEpoch: initial.epoch,
    expectedLatestSequence: 1,
    newEpoch: 'new-epoch',
    chunks: 2,
    byteLength: checkpoint.byteLength,
  }
  await body(await room.fetch(new Request('https://relay/v3/checkpoints/start', {
    method: 'POST', body: JSON.stringify(metadata), headers: { 'content-type': 'application/json' },
  })))
  for (let index = 0; index < metadata.chunks; index += 1) {
    await body(await room.fetch(new Request(`https://relay/v3/checkpoints/${metadata.uploadId}/${index}`, {
      method: 'PUT', body: checkpoint.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
    })))
  }
  await body(await room.fetch(new Request('https://relay/v3/checkpoints/commit', {
    method: 'POST', body: JSON.stringify(metadata), headers: { 'content-type': 'application/json' },
  })))

  assert.equal((await room.fetch(new Request('https://relay/push', { method: 'POST', body: '[4]' }))).status, 426)
  assert.deepEqual(await (await room.fetch(new Request('https://relay/pull'))).json(), [[1, 2, 3]])
  await storage.put('v3:legacyExpiresAt', Date.now() - 1)
  await body(await room.fetch(new Request('https://relay/health')))
  assert.equal(await storage.get('sequences'), undefined)

  const rollback = await body(await room.fetch(new Request('https://relay/v3/rollback', { method: 'POST' })))
  assert.equal(rollback.epoch, initial.epoch)
})
