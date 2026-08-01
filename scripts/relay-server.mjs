#!/usr/bin/env node
// Local reference implementation of the Balance v3 opaque relay contract.

import http from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

const port = Number(process.argv[2] ?? 8787)
const host = process.env.BALANCE_RELAY_HOST ?? '127.0.0.1'
const secret = process.env.BALANCE_RELAY_SECRET ?? ''
if (secret.length < 24 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
  console.error(
    'BALANCE_RELAY_SECRET must be set to 24+ URL-safe characters.\n' +
      `Suggested value:\n\n  export BALANCE_RELAY_SECRET=${randomBytes(16).toString('hex')}\n`,
  )
  process.exit(1)
}
const secretBytes = Buffer.from(secret)

const MAX_BATCH_BYTES = 512 * 1024
const STORAGE_CHUNK_BYTES = 96 * 1024
const MAX_CHECKPOINT_CHUNK_BYTES = STORAGE_CHUNK_BYTES
const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024
const COMPACT_AFTER_BYTES = 32 * 1024 * 1024
const COMPACT_AFTER_BATCHES = 128
const MAX_BATCHES = 256
const COMPACT_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const PREVIOUS_TTL_MS = 24 * 60 * 60 * 1000

const freshGeneration = () => ({
  epoch: randomUUID(), createdAt: Date.now(), latestSequence: 0,
  deltaBytes: 0, checkpoint: null, batches: [],
})
let current = freshGeneration()
let previous = null
let activated = false
let legacyExpiresAt = null
const blobs = new Map()
const dedup = new Map()
const uploads = new Map()
const legacyEnvelopes = []

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'content-type,x-balance-epoch,x-balance-device,x-balance-batch',
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...cors })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

function sendBinary(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/octet-stream', ...cors })
  res.end(body)
}

function authenticatedUrl(raw) {
  const url = new URL(raw ?? '/', `http://${host}:${port}`)
  const separator = url.pathname.indexOf('/', 1)
  const segment = separator === -1 ? url.pathname.slice(1) : url.pathname.slice(1, separator)
  const candidate = Buffer.from(segment)
  if (candidate.length !== secretBytes.length || !timingSafeEqual(candidate, secretBytes)) return null
  url.pathname = separator === -1 ? '/' : url.pathname.slice(separator)
  return url
}

function validToken(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value)
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('request too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req, max = 64 * 1024) {
  return JSON.parse((await readBody(req, max)).toString('utf8'))
}

function deleteGeneration(generation) {
  if (!generation) return
  if (generation.checkpoint) {
    if (generation.checkpoint.id.startsWith('u-')) uploads.delete(generation.checkpoint.id.slice(2))
    else for (let i = 0; i < generation.checkpoint.chunks; i += 1) blobs.delete(`${generation.checkpoint.id}:${i}`)
  }
  for (const batch of generation.batches ?? []) {
    for (let i = 0; i < batch.chunks; i += 1) blobs.delete(`${batch.id}:${i}`)
    dedup.delete(`${batch.device}:${batch.batchId}`)
  }
}

function cleanup() {
  if (previous && previous.expiresAt <= Date.now()) {
    deleteGeneration(previous)
    previous = null
  }
  for (const [id, upload] of uploads) {
    if (!upload.committed && upload.createdAt + PREVIOUS_TTL_MS <= Date.now()) uploads.delete(id)
  }
  if (legacyExpiresAt && legacyExpiresAt <= Date.now()) {
    legacyEnvelopes.length = 0
    legacyExpiresAt = null
  }
}

async function route(req, res, url) {
  cleanup()
  const path = url.pathname
  if (req.method === 'GET' && path === '/v3/manifest') {
    const changedEpoch = (url.searchParams.get('epoch') ?? '') !== current.epoch
    const clientEpoch = url.searchParams.get('epoch') ?? ''
    const after = Number(url.searchParams.get('after') ?? 0)
    if ((clientEpoch && !validToken(clientEpoch)) || !Number.isSafeInteger(after) || after < 0) {
      return sendJson(res, 400, { error: 'invalid manifest cursor' })
    }
    return sendJson(res, 200, {
      epoch: current.epoch,
      latestSequence: current.latestSequence,
      checkpoint: changedEpoch && current.checkpoint
        ? { id: current.checkpoint.id, chunks: current.checkpoint.chunks }
        : null,
      batches: current.batches
        .filter((batch) => changedEpoch || batch.sequence > after)
        .map(({ id, sequence, chunks }) => ({ id, sequence, chunks })),
      deltaBytes: current.deltaBytes,
      compactRecommended:
        (!current.checkpoint && current.batches.length > 0) ||
        current.batches.length >= COMPACT_AFTER_BATCHES ||
        current.deltaBytes >= COMPACT_AFTER_BYTES || Date.now() - current.createdAt >= COMPACT_AFTER_MS,
    })
  }

  if (req.method === 'POST' && path === '/v3/batches') {
    const epoch = req.headers['x-balance-epoch'] ?? ''
    const device = req.headers['x-balance-device'] ?? ''
    const batchId = req.headers['x-balance-batch'] ?? ''
    if (![epoch, device, batchId].every((value) => validToken(value))) return sendJson(res, 400, { error: 'invalid batch metadata' })
    const bytes = await readBody(req, MAX_BATCH_BYTES)
    if (!bytes.length || epoch !== current.epoch) return sendJson(res, epoch === current.epoch ? 400 : 409, { error: 'invalid or stale batch', epoch: current.epoch })
    const dedupKey = `${device}:${batchId}`
    if (dedup.has(dedupKey)) return sendJson(res, 200, { ok: true, sequence: dedup.get(dedupKey), duplicate: true })
    if (current.batches.length >= MAX_BATCHES) return sendJson(res, 429, { error: 'generation needs checkpoint compaction' })
    const sequence = ++current.latestSequence
    const id = `b-${sequence}-${batchId}`
    const chunks = Math.ceil(bytes.length / STORAGE_CHUNK_BYTES)
    for (let index = 0; index < chunks; index += 1) {
      blobs.set(`${id}:${index}`, bytes.subarray(index * STORAGE_CHUNK_BYTES, (index + 1) * STORAGE_CHUNK_BYTES))
    }
    current.deltaBytes += bytes.length
    current.batches.push({ id, sequence, chunks, bytes: bytes.length, device, batchId })
    dedup.set(dedupKey, sequence)
    return sendJson(res, 200, { ok: true, sequence, duplicate: false })
  }

  if (req.method === 'GET' && path.startsWith('/v3/blobs/')) {
    const [, , , id, rawIndex] = path.split('/')
    const index = Number(rawIndex)
    if (!validToken(id) || !Number.isInteger(index)) return sendJson(res, 400, { error: 'invalid blob path' })
    const chunk = id.startsWith('u-') ? uploads.get(id.slice(2))?.chunksData.get(index) : blobs.get(`${id}:${index}`)
    return chunk ? sendBinary(res, 200, chunk) : sendJson(res, 404, { error: 'blob not found' })
  }

  if (req.method === 'POST' && path === '/v3/checkpoints/start') {
    const body = await readJson(req)
    const { uploadId, expectedEpoch, expectedLatestSequence, newEpoch, chunks, byteLength } = body
    if (!validToken(uploadId) || !validToken(expectedEpoch) || !validToken(newEpoch) ||
        expectedEpoch !== current.epoch || expectedLatestSequence !== current.latestSequence) {
      return sendJson(res, 409, { error: 'relay changed', epoch: current.epoch, latestSequence: current.latestSequence })
    }
    if (!Number.isInteger(chunks) || chunks < 1 || !Number.isInteger(byteLength) || byteLength < 1 ||
        byteLength > MAX_CHECKPOINT_BYTES || chunks !== Math.ceil(byteLength / MAX_CHECKPOINT_CHUNK_BYTES)) {
      return sendJson(res, 400, { error: 'invalid checkpoint metadata' })
    }
    if (uploads.has(uploadId)) return sendJson(res, 409, { error: 'checkpoint upload id already exists' })
    uploads.set(uploadId, { ...body, createdAt: Date.now(), chunksData: new Map() })
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'PUT' && path.startsWith('/v3/checkpoints/')) {
    const [, , , uploadId, rawIndex] = path.split('/')
    const index = Number(rawIndex)
    const upload = uploads.get(uploadId)
    if (!upload || !Number.isInteger(index) || index < 0 || index >= upload.chunks) return sendJson(res, 404, { error: 'upload not found' })
    const expected = index === upload.chunks - 1
      ? upload.byteLength - MAX_CHECKPOINT_CHUNK_BYTES * index
      : MAX_CHECKPOINT_CHUNK_BYTES
    const bytes = await readBody(req, MAX_CHECKPOINT_CHUNK_BYTES)
    if (bytes.length !== expected) return sendJson(res, 400, { error: 'wrong chunk length', expected })
    upload.chunksData.set(index, bytes)
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'POST' && path === '/v3/checkpoints/commit') {
    const body = await readJson(req)
    const upload = uploads.get(body.uploadId)
    if (!upload || upload.expectedEpoch !== body.expectedEpoch ||
        upload.expectedLatestSequence !== body.expectedLatestSequence || upload.newEpoch !== body.newEpoch) {
      return sendJson(res, 400, { error: 'checkpoint metadata mismatch' })
    }
    if (current.epoch !== body.expectedEpoch || current.latestSequence !== body.expectedLatestSequence) {
      return sendJson(res, 409, { error: 'relay changed', epoch: current.epoch, latestSequence: current.latestSequence })
    }
    if (upload.chunksData.size !== upload.chunks) return sendJson(res, 400, { error: 'missing checkpoint chunks' })
    deleteGeneration(previous)
    previous = { ...current, expiresAt: Date.now() + PREVIOUS_TTL_MS }
    current = {
      epoch: body.newEpoch, createdAt: Date.now(), latestSequence: 0, deltaBytes: 0,
      checkpoint: { id: `u-${body.uploadId}`, chunks: upload.chunks, bytes: upload.byteLength }, batches: [],
    }
    upload.committed = true
    activated = true
    legacyExpiresAt = Date.now() + PREVIOUS_TTL_MS
    return sendJson(res, 200, { ok: true, epoch: current.epoch })
  }

  if (req.method === 'POST' && path === '/v3/rollback') {
    if (!previous || previous.expiresAt <= Date.now()) return sendJson(res, 404, { error: 'no rollback generation' })
    const oldCurrent = current
    const restored = previous
    delete restored.expiresAt
    current = restored
    previous = { ...oldCurrent, expiresAt: Date.now() + PREVIOUS_TTL_MS }
    return sendJson(res, 200, { ok: true, epoch: current.epoch })
  }

  if (req.method === 'POST' && path === '/push') {
    if (activated) return sendJson(res, 426, { error: 'update Balance to use sync v3' })
    const raw = (await readBody(req, 24 * 1024 * 1024)).toString('utf8').trim()
    if (!raw.startsWith('[') || !raw.endsWith(']')) return sendJson(res, 400, { error: 'invalid legacy envelope' })
    legacyEnvelopes.push(raw)
    while (legacyEnvelopes.length > 6) legacyEnvelopes.shift()
    return sendJson(res, 200, { ok: true, stored: legacyEnvelopes.length })
  }
  if (req.method === 'GET' && path === '/pull') {
    res.writeHead(200, { 'content-type': 'application/json', ...cors })
    return res.end(`[${legacyEnvelopes.join(',')}]`)
  }
  if (req.method === 'GET' && path === '/health') return sendJson(res, 200, {
    ok: true, protocol: 3, epoch: current.epoch, batches: current.batches.length,
    deltaBytes: current.deltaBytes, checkpointBytes: current.checkpoint?.bytes ?? 0,
    previousExpiresAt: previous?.expiresAt ?? null,
  })
  if (req.method === 'POST' && path === '/reset') {
    current = freshGeneration(); previous = null; activated = false; legacyExpiresAt = null
    blobs.clear(); dedup.clear(); uploads.clear(); legacyEnvelopes.length = 0
    return sendJson(res, 200, { ok: true, cleared: true })
  }
  return sendJson(res, 404, { error: 'not found' })
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204)
  const url = authenticatedUrl(req.url)
  if (!url) return sendJson(res, 404, { error: 'not found' })
  route(req, res, url).catch((error) => {
    if (!res.headersSent) sendJson(res, error.message === 'request too large' ? 413 : 500, { error: String(error) })
  })
})

server.listen(port, host, () => {
  console.log(`Balance relay listening on http://${host}:${port}/${secret}`)
})
