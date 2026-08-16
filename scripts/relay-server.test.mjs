import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import test from 'node:test'

const SECRET = 'balance_relay_test_secret_1234'
const CHUNK_BYTES = 96 * 1024

async function unusedPort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  assert(address && typeof address === 'object')
  const port = address.port
  probe.close()
  await once(probe, 'close')
  return port
}

async function startRelay(t) {
  const port = await unusedPort()
  const child = spawn(process.execPath, ['scripts/relay-server.mjs', String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, BALANCE_RELAY_SECRET: SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  const started = Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => {
      throw new Error(`relay exited before listening (${code})`)
    }),
  ])
  await started
  return `http://127.0.0.1:${port}/${SECRET}`
}

async function json(response) {
  const body = await response.json()
  assert(response.ok, `${response.status}: ${JSON.stringify(body)}`)
  return body
}

test('relay v3 incrementally promotes and rolls back bounded generations', async (t) => {
  const base = await startRelay(t)
  assert.equal((await fetch(`${base}x/health`)).status, 404)

  assert.equal((await fetch(`${base}/push`, { method: 'POST' })).status, 404)
  assert.equal((await fetch(`${base}/pull`)).status, 404)

  const initial = await json(await fetch(`${base}/v3/manifest?epoch=&after=0`))
  const batch = Buffer.alloc(CHUNK_BYTES * 2 + 7, 42)
  const headers = {
    'content-type': 'application/octet-stream',
    'x-balance-epoch': initial.epoch,
    'x-balance-device': 'device-token',
    'x-balance-batch': 'batch-token',
  }
  const accepted = await json(await fetch(`${base}/v3/batches`, { method: 'POST', headers, body: batch }))
  assert.equal(accepted.sequence, 1)
  assert.equal(accepted.duplicate, false)
  const duplicate = await json(await fetch(`${base}/v3/batches`, { method: 'POST', headers, body: batch }))
  assert.equal(duplicate.sequence, 1)
  assert.equal(duplicate.duplicate, true)

  const withBatch = await json(await fetch(`${base}/v3/manifest?epoch=${initial.epoch}&after=0`))
  assert.equal(withBatch.batches.length, 1)
  assert.equal(withBatch.batches[0].chunks, 3)
  assert.equal(withBatch.compactRecommended, true)
  const downloaded = []
  for (let index = 0; index < withBatch.batches[0].chunks; index += 1) {
    const response = await fetch(`${base}/v3/blobs/${withBatch.batches[0].id}/${index}`)
    assert.equal(response.status, 200)
    downloaded.push(Buffer.from(await response.arrayBuffer()))
  }
  assert.deepEqual(Buffer.concat(downloaded), batch)

  const checkpoint = Buffer.alloc(CHUNK_BYTES + 13, 99)
  const uploadId = 'checkpoint-upload'
  const newEpoch = 'next-epoch'
  const checkpointMeta = {
    uploadId,
    expectedEpoch: initial.epoch,
    expectedLatestSequence: 1,
    newEpoch,
    chunks: 2,
    byteLength: checkpoint.length,
  }
  await json(await fetch(`${base}/v3/checkpoints/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(checkpointMeta),
  }))
  for (let index = 0; index < checkpointMeta.chunks; index += 1) {
    await json(await fetch(`${base}/v3/checkpoints/${uploadId}/${index}`, {
      method: 'PUT',
      body: checkpoint.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
    }))
  }
  await json(await fetch(`${base}/v3/checkpoints/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(checkpointMeta),
  }))

  const promoted = await json(await fetch(`${base}/v3/manifest?epoch=${initial.epoch}&after=1`))
  assert.equal(promoted.epoch, newEpoch)
  assert.deepEqual(promoted.checkpoint, { id: `u-${uploadId}`, chunks: 2 })
  assert.deepEqual(promoted.batches, [])
  const rolledBack = await json(await fetch(`${base}/v3/rollback`, { method: 'POST' }))
  assert.equal(rolledBack.epoch, initial.epoch)
  const restored = await json(await fetch(`${base}/v3/manifest?epoch=${newEpoch}&after=0`))
  assert.equal(restored.batches.length, 1)
  assert.equal(restored.batches[0].sequence, 1)

  await json(await fetch(`${base}/reset`, { method: 'POST' }))
  const health = await json(await fetch(`${base}/health`))
  assert.equal(health.protocol, 3)
  assert.equal(health.batches, 0)
})
