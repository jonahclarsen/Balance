import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'

import { RelayRoom } from './index.js'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const CHUNK_BYTES = 96 * 1024

class MemoryStorage {
  values = new Map()

  async get(key) {
    return structuredClone(this.values.get(key))
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
      this.values.set(key, structuredClone(entry))
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

test('Durable Object contract chunks values and rolls back generations', async () => {
  const storage = new MemoryStorage()
  const room = new RelayRoom({ storage })

  assert.equal((await room.fetch(new Request('https://relay/pull'))).status, 404)
  assert.equal((await room.fetch(new Request('https://relay/push', { method: 'POST' }))).status, 404)
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

  const rollback = await body(await room.fetch(new Request('https://relay/v3/rollback', { method: 'POST' })))
  assert.equal(rollback.epoch, initial.epoch)
})

// Seeded yields exercise actual asynchronous storage boundaries. Storage returns
// copies, like Durable Object storage: shared object references can conceal lost
// updates in an in-memory test double.
class ScheduledStorage extends MemoryStorage {
  constructor(seed) {
    super()
    this.seed = seed
  }

  async yieldAtBoundary() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    for (let count = this.seed % 3; count > 0; count -= 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  async get(key) { await this.yieldAtBoundary(); return super.get(key) }
  async put(key, value) { await this.yieldAtBoundary(); return super.put(key, value) }
  async delete(keys) { await this.yieldAtBoundary(); return super.delete(keys) }
}

function request(room, path, method = 'GET', value, headers = {}) {
  return room.fetch(new Request(`https://relay${path}`, {
    method, headers,
    ...(value === undefined ? {} : { body: value }),
  }))
}

async function readGeneration(room) {
  const manifest = await body(await request(room, '/v3/manifest'))
  const records = []
  for (const blob of [manifest.checkpoint, ...manifest.batches].filter(Boolean)) {
    const chunks = []
    for (let index = 0; index < blob.chunks; index += 1) {
      const response = await request(room, `/v3/blobs/${blob.id}/${index}`)
      assert.equal(response.status, 200, `missing committed blob ${blob.id}/${index}`)
      chunks.push(Buffer.from(await response.arrayBuffer()))
    }
    records.push(...JSON.parse(Buffer.concat(chunks).toString()))
  }
  return { manifest, records }
}

for (let seed = 1; seed <= 16; seed += 1) {
  test(`seed ${seed}: concurrent uploads, lost acknowledgements and checkpoint CAS preserve every accepted record`, async () => {
    const room = new RelayRoom({ storage: new ScheduledStorage(seed) })
    const accepted = new Set()
    await body(await request(room, '/v3/manifest'))
    for (let round = 0; round < 4; round += 1) {
      const before = await readGeneration(room)
      const checkpoint = Buffer.from(JSON.stringify(before.records))
      const metadata = {
        uploadId: `upload-${seed}-${round}`,
        expectedEpoch: before.manifest.epoch,
        expectedLatestSequence: before.manifest.latestSequence,
        newEpoch: `epoch-${seed}-${round}`,
        chunks: 1,
        byteLength: checkpoint.byteLength,
      }
      await body(await request(room, '/v3/checkpoints/start', 'POST', JSON.stringify(metadata)))
      await body(await request(room, `/v3/checkpoints/${metadata.uploadId}/0`, 'PUT', checkpoint))
      const push = async (record, retry = false) => {
        const headers = {
          'x-balance-epoch': before.manifest.epoch,
          'x-balance-device': `device-${record % 3}`,
          'x-balance-batch': `batch-${seed}-${record}`,
        }
        const response = await request(room, '/v3/batches', 'POST', JSON.stringify([record]), headers)
        assert([200, 409].includes(response.status), `unexpected upload status ${response.status}`)
        if (response.ok) {
          accepted.add(record)
          const acknowledgement = await response.json()
          if (retry) {
            // The client lost the successful response and repeats its durable
            // batch. A generation switch can reject the retry; otherwise it
            // must return the same sequence without duplicating the blob.
            const duplicate = await request(room, '/v3/batches', 'POST', JSON.stringify([record]), headers)
            assert([200, 409].includes(duplicate.status))
            if (duplicate.ok) {
              const result = await duplicate.json()
              assert.equal(result.sequence, acknowledgement.sequence)
              assert.equal(result.duplicate, true)
            }
          }
        }
      }
      const work = Array.from({ length: 8 }, (_, index) => () => push(round * 8 + index, true))
      // Alternate which side enters first; seeded storage yields determine the
      // remaining interleaving. CAS must never erase an acknowledged upload.
      work.splice((seed + round) % 9, 0, async () => {
        const result = await request(room, '/v3/checkpoints/commit', 'POST', JSON.stringify(metadata))
        assert([200, 409].includes(result.status), `unexpected checkpoint status ${result.status}`)
      })
      await Promise.all(work.map((run) => run()))
      const active = await body(await request(room, '/v3/manifest'))
      for (let index = 0; index < 8; index += 1) {
        const record = round * 8 + index
        if (accepted.has(record)) continue
        // A conflicted client refreshes its epoch and restages the unsent
        // operation. This models recovery after the competing checkpoint wins.
        await body(await request(room, '/v3/batches', 'POST', JSON.stringify([record]), {
          'x-balance-epoch': active.epoch,
          'x-balance-device': `device-${record % 3}`,
          'x-balance-batch': `retry-${seed}-${record}`,
        }))
        accepted.add(record)
      }
      const after = await readGeneration(room)
      assert.deepEqual([...after.records].sort((a, b) => a - b), [...accepted].sort((a, b) => a - b))
      assert.equal(new Set(after.records).size, after.records.length, 'acknowledgement retries duplicated records')
      assert.deepEqual(after.manifest.batches.map((batch) => batch.sequence),
        Array.from({ length: after.manifest.latestSequence }, (_, index) => index + 1))
    }
  })
}
