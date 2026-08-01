// Balance v3 E2EE sync relay. The Durable Object sees only opaque device/batch
// tokens and ciphertext; all operation and checkpoint contents remain sealed.

const MAX_BATCH_BYTES = 512 * 1024
const STORAGE_CHUNK_BYTES = 96 * 1024
const MAX_CHECKPOINT_CHUNK_BYTES = STORAGE_CHUNK_BYTES
const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024
const COMPACT_AFTER_BYTES = 32 * 1024 * 1024
const COMPACT_AFTER_BATCHES = 128
const MAX_BATCHES = 256
const COMPACT_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const PREVIOUS_TTL_MS = 24 * 60 * 60 * 1000
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000
const MAX_KEYS_PER_DELETE = 128
const LEGACY_CHUNK_CHARS = 96 * 1024
const MAX_LEGACY_ENVELOPE_TEXT = 24 * 1024 * 1024
const MAX_LEGACY_STORED = 6

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers':
    'content-type,x-balance-epoch,x-balance-device,x-balance-batch',
}

function json(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  })
}

function binary(status, body) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/octet-stream', ...CORS },
  })
}

function rawJson(status, body) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  })
}

function token(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value)
}

function secretMatches(candidate, secret) {
  if (candidate.length !== secret.length) return false
  let diff = 0
  for (let i = 0; i < candidate.length; i += 1) diff |= candidate.charCodeAt(i) ^ secret.charCodeAt(i)
  return diff === 0
}

function freshEpoch() {
  return crypto.randomUUID()
}

export class RelayRoom {
  constructor(state) {
    this.storage = state.storage
    this.queue = Promise.resolve()
  }

  serialize(work) {
    const result = this.queue.then(work, work)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  async current() {
    let current = await this.storage.get('v3:current')
    if (!current) {
      current = {
        epoch: freshEpoch(),
        createdAt: Date.now(),
        latestSequence: 0,
        deltaBytes: 0,
        checkpoint: null,
        batches: [],
      }
      await this.storage.put('v3:current', current)
    }
    return current
  }

  async cleanup() {
    const now = Date.now()
    const previous = await this.storage.get('v3:previous')
    if (previous && previous.expiresAt <= now) {
      await this.deleteGeneration(previous)
      await this.storage.delete('v3:previous')
    }
    const uploads = (await this.storage.get('v3:uploads')) ?? []
    const retained = []
    for (const id of uploads) {
      const meta = await this.storage.get(`v3:upload:${id}:meta`)
      if (!meta || meta.createdAt + UPLOAD_TTL_MS <= now) await this.deleteUpload(id, meta)
      else retained.push(id)
    }
    if (retained.length !== uploads.length) await this.storage.put('v3:uploads', retained)
    const legacyExpiresAt = await this.storage.get('v3:legacyExpiresAt')
    if (legacyExpiresAt && legacyExpiresAt <= now) await this.deleteLegacy()
  }

  async fetch(request) {
    await this.cleanup()
    const url = new URL(request.url)
    const path = url.pathname
    if (request.method === 'GET' && path === '/v3/manifest') return this.manifest(url)
    if (request.method === 'POST' && path === '/v3/batches') return this.pushBatch(request)
    if (request.method === 'GET' && path.startsWith('/v3/blobs/')) return this.getBlob(path)
    if (request.method === 'POST' && path === '/v3/checkpoints/start') return this.startCheckpoint(request)
    if (request.method === 'PUT' && path.startsWith('/v3/checkpoints/')) return this.putCheckpointChunk(path, request)
    if (request.method === 'POST' && path === '/v3/checkpoints/commit') return this.commitCheckpoint(request)
    if (request.method === 'POST' && path === '/v3/rollback') return this.rollback()
    if (request.method === 'GET' && path === '/health') return this.health()
    if (request.method === 'POST' && path === '/reset') return this.reset()

    // Temporary v2 compatibility. These routes retain raw JSON envelopes until
    // the first v3 checkpoint commit, then reject writes to prevent split-brain.
    if (request.method === 'POST' && path === '/push') return this.legacyPush(request)
    if (request.method === 'GET' && path === '/pull') return this.legacyPull()
    return json(404, { error: 'not found' })
  }

  async manifest(url) {
    const current = await this.current()
    const clientEpoch = url.searchParams.get('epoch') ?? ''
    const after = Number(url.searchParams.get('after') ?? 0)
    if ((clientEpoch && !token(clientEpoch)) || !Number.isSafeInteger(after) || after < 0) {
      return json(400, { error: 'invalid manifest cursor' })
    }
    const changedEpoch = clientEpoch !== current.epoch
    const batches = current.batches
      .filter((batch) => changedEpoch || batch.sequence > after)
      .map(({ id, sequence, chunks }) => ({ id, sequence, chunks }))
    return json(200, {
      epoch: current.epoch,
      latestSequence: current.latestSequence,
      checkpoint: changedEpoch && current.checkpoint
        ? { id: current.checkpoint.id, chunks: current.checkpoint.chunks }
        : null,
      batches,
      deltaBytes: current.deltaBytes,
      compactRecommended:
        (!current.checkpoint && current.batches.length > 0) ||
        current.batches.length >= COMPACT_AFTER_BATCHES ||
        current.deltaBytes >= COMPACT_AFTER_BYTES || Date.now() - current.createdAt >= COMPACT_AFTER_MS,
    })
  }

  async pushBatch(request) {
    const epoch = request.headers.get('x-balance-epoch') ?? ''
    const device = request.headers.get('x-balance-device') ?? ''
    const batchId = request.headers.get('x-balance-batch') ?? ''
    if (!token(epoch) || !token(device) || !token(batchId)) return json(400, { error: 'invalid batch metadata' })
    const bytes = await request.arrayBuffer()
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BATCH_BYTES) return json(413, { error: 'batch too large' })

    return this.serialize(async () => {
      const current = await this.current()
      if (epoch !== current.epoch) return json(409, { error: 'epoch changed', epoch: current.epoch })
      const dedupKey = `v3:dedup:${device}:${batchId}`
      const prior = await this.storage.get(dedupKey)
      if (prior) return json(200, { ok: true, sequence: prior.sequence, duplicate: true })
      if (current.batches.length >= MAX_BATCHES) {
        return json(429, { error: 'generation needs checkpoint compaction' })
      }

      const sequence = current.latestSequence + 1
      const id = `b-${sequence}-${batchId}`
      const chunks = Math.ceil(bytes.byteLength / STORAGE_CHUNK_BYTES)
      const entries = {}
      for (let index = 0; index < chunks; index += 1) {
        entries[`v3:blob:${id}:${index}`] = bytes.slice(
          index * STORAGE_CHUNK_BYTES,
          Math.min(bytes.byteLength, (index + 1) * STORAGE_CHUNK_BYTES),
        )
      }
      await this.storage.put(entries)
      const descriptor = { id, sequence, chunks, bytes: bytes.byteLength, device, batchId }
      current.latestSequence = sequence
      current.deltaBytes += bytes.byteLength
      current.batches.push(descriptor)
      await this.storage.put({ 'v3:current': current, [dedupKey]: { sequence, id } })
      return json(200, { ok: true, sequence, duplicate: false })
    })
  }

  async getBlob(path) {
    const parts = path.split('/')
    const id = parts[3]
    const index = Number(parts[4])
    if (!token(id) || !Number.isInteger(index) || index < 0) return json(400, { error: 'invalid blob path' })
    let chunk = await this.storage.get(`v3:blob:${id}:${index}`)
    if (chunk === undefined && id.startsWith('u-')) {
      chunk = await this.storage.get(`v3:upload:${id.slice(2)}:${index}`)
    }
    return chunk === undefined ? json(404, { error: 'blob not found' }) : binary(200, chunk)
  }

  async startCheckpoint(request) {
    let body
    try { body = await request.json() } catch { return json(400, { error: 'invalid JSON' }) }
    const { uploadId, expectedEpoch, expectedLatestSequence, newEpoch, chunks, byteLength } = body
    if (!token(uploadId) || !token(expectedEpoch) || !token(newEpoch) ||
        !Number.isInteger(expectedLatestSequence) || !Number.isInteger(chunks) || chunks < 1 ||
        !Number.isInteger(byteLength) || byteLength < 1 || byteLength > MAX_CHECKPOINT_BYTES ||
        chunks !== Math.ceil(byteLength / MAX_CHECKPOINT_CHUNK_BYTES)) {
      return json(400, { error: 'invalid checkpoint metadata' })
    }
    return this.serialize(async () => {
      const current = await this.current()
      if (current.epoch !== expectedEpoch || current.latestSequence !== expectedLatestSequence) {
        return json(409, { error: 'relay changed', epoch: current.epoch, latestSequence: current.latestSequence })
      }
      if (await this.storage.get(`v3:upload:${uploadId}:meta`)) {
        return json(409, { error: 'checkpoint upload id already exists' })
      }
      const meta = { ...body, createdAt: Date.now() }
      const uploads = (await this.storage.get('v3:uploads')) ?? []
      if (!uploads.includes(uploadId)) uploads.push(uploadId)
      await this.storage.put({ [`v3:upload:${uploadId}:meta`]: meta, 'v3:uploads': uploads })
      return json(200, { ok: true })
    })
  }

  async putCheckpointChunk(path, request) {
    const parts = path.split('/')
    const uploadId = parts[3]
    const index = Number(parts[4])
    if (!token(uploadId) || !Number.isInteger(index) || index < 0) return json(400, { error: 'invalid upload path' })
    const meta = await this.storage.get(`v3:upload:${uploadId}:meta`)
    if (!meta || index >= meta.chunks) return json(404, { error: 'upload not found' })
    const bytes = await request.arrayBuffer()
    const expected = index === meta.chunks - 1
      ? meta.byteLength - MAX_CHECKPOINT_CHUNK_BYTES * index
      : MAX_CHECKPOINT_CHUNK_BYTES
    if (bytes.byteLength !== expected) return json(400, { error: 'wrong chunk length', expected })
    await this.storage.put(`v3:upload:${uploadId}:${index}`, bytes)
    return json(200, { ok: true })
  }

  async commitCheckpoint(request) {
    let body
    try { body = await request.json() } catch { return json(400, { error: 'invalid JSON' }) }
    return this.serialize(async () => {
      const { uploadId, expectedEpoch, expectedLatestSequence, newEpoch } = body
      const meta = token(uploadId) ? await this.storage.get(`v3:upload:${uploadId}:meta`) : null
      if (!meta || meta.expectedEpoch !== expectedEpoch || meta.expectedLatestSequence !== expectedLatestSequence ||
          meta.newEpoch !== newEpoch) return json(400, { error: 'checkpoint metadata mismatch' })
      const current = await this.current()
      if (current.epoch !== expectedEpoch || current.latestSequence !== expectedLatestSequence) {
        return json(409, { error: 'relay changed', epoch: current.epoch, latestSequence: current.latestSequence })
      }
      for (let index = 0; index < meta.chunks; index += 1) {
        if ((await this.storage.get(`v3:upload:${uploadId}:${index}`)) === undefined) {
          return json(400, { error: `missing checkpoint chunk ${index}` })
        }
      }

      const older = await this.storage.get('v3:previous')
      if (older) await this.deleteGeneration(older)
      const previous = { ...current, expiresAt: Date.now() + PREVIOUS_TTL_MS }
      const next = {
        epoch: newEpoch,
        createdAt: Date.now(),
        latestSequence: 0,
        deltaBytes: 0,
        checkpoint: { id: `u-${uploadId}`, chunks: meta.chunks, bytes: meta.byteLength },
        batches: [],
      }
      const uploads = ((await this.storage.get('v3:uploads')) ?? []).filter((id) => id !== uploadId)
      await this.storage.put({
        'v3:previous': previous,
        'v3:current': next,
        'v3:uploads': uploads,
        'v3:activated': true,
        'v3:legacyExpiresAt': Date.now() + PREVIOUS_TTL_MS,
      })
      return json(200, { ok: true, epoch: newEpoch })
    })
  }

  async deleteGeneration(generation) {
    if (generation.checkpoint) await this.deleteBlob(generation.checkpoint)
    for (const batch of generation.batches ?? []) {
      await this.deleteBlob(batch)
      if (batch.device && batch.batchId) await this.storage.delete(`v3:dedup:${batch.device}:${batch.batchId}`)
    }
  }

  async deleteBlob(blob) {
    if (blob.id.startsWith('u-')) return this.deleteUpload(blob.id.slice(2), { chunks: blob.chunks })
    const keys = []
    for (let index = 0; index < blob.chunks; index += 1) keys.push(`v3:blob:${blob.id}:${index}`)
    await this.deleteKeys(keys)
  }

  async deleteUpload(id, meta) {
    if (!meta) meta = await this.storage.get(`v3:upload:${id}:meta`)
    const keys = [`v3:upload:${id}:meta`]
    for (let index = 0; index < (meta?.chunks ?? 0); index += 1) keys.push(`v3:upload:${id}:${index}`)
    await this.deleteKeys(keys)
  }

  async deleteKeys(keys) {
    for (let offset = 0; offset < keys.length; offset += MAX_KEYS_PER_DELETE) {
      await this.storage.delete(keys.slice(offset, offset + MAX_KEYS_PER_DELETE))
    }
  }

  async rollback() {
    return this.serialize(async () => {
      const previous = await this.storage.get('v3:previous')
      if (!previous || previous.expiresAt <= Date.now()) return json(404, { error: 'no rollback generation' })
      const current = await this.current()
      delete previous.expiresAt
      await this.storage.put({ 'v3:current': previous, 'v3:previous': { ...current, expiresAt: Date.now() + PREVIOUS_TTL_MS } })
      return json(200, { ok: true, epoch: previous.epoch })
    })
  }

  async legacyPush(request) {
    if (await this.storage.get('v3:activated')) return json(426, { error: 'update Balance to use sync v3' })
    const raw = (await request.text()).trim()
    if (raw.length > MAX_LEGACY_ENVELOPE_TEXT || !raw.startsWith('[') || !raw.endsWith(']')) {
      return json(400, { error: 'invalid legacy envelope' })
    }
    return this.serialize(async () => {
      const sequences = (await this.storage.get('sequences')) ?? []
      const next = (await this.storage.get('nextSequence')) ?? 1
      let entries = {}
      let chunks = 0
      for (let offset = 0; offset < raw.length; offset += LEGACY_CHUNK_CHARS) {
        entries[`e:${next}:${chunks}`] = raw.slice(offset, offset + LEGACY_CHUNK_CHARS)
        chunks += 1
        if (Object.keys(entries).length === MAX_KEYS_PER_DELETE) {
          await this.storage.put(entries)
          entries = {}
        }
      }
      entries[`e:${next}:chunks`] = chunks
      await this.storage.put(entries)

      const retained = [...sequences, next]
      const evicted = retained.splice(0, Math.max(0, retained.length - MAX_LEGACY_STORED))
      await this.storage.put({ sequences: retained, nextSequence: next + 1 })
      for (const sequence of evicted) await this.deleteLegacyEnvelope(sequence)
      return json(200, { ok: true, stored: retained.length })
    })
  }

  async legacyPull() {
    const sequences = (await this.storage.get('sequences')) ?? []
    const envelopes = []
    for (const sequence of sequences) {
      const chunks = (await this.storage.get(`e:${sequence}:chunks`)) ?? 0
      let envelope = ''
      for (let index = 0; index < chunks; index += 1) {
        envelope += (await this.storage.get(`e:${sequence}:${index}`)) ?? ''
      }
      if (envelope) envelopes.push(envelope)
    }
    return rawJson(200, `[${envelopes.join(',')}]`)
  }

  async deleteLegacyEnvelope(sequence) {
    const chunks = (await this.storage.get(`e:${sequence}:chunks`)) ?? 0
    const keys = [`e:${sequence}:chunks`]
    for (let index = 0; index < chunks; index += 1) keys.push(`e:${sequence}:${index}`)
    await this.deleteKeys(keys)
  }

  async deleteLegacy() {
    const sequences = (await this.storage.get('sequences')) ?? []
    for (const sequence of sequences) await this.deleteLegacyEnvelope(sequence)
    await this.storage.delete(['sequences', 'nextSequence', 'v3:legacyExpiresAt'])
  }

  async health() {
    const current = await this.current()
    const previous = await this.storage.get('v3:previous')
    return json(200, {
      ok: true,
      protocol: 3,
      epoch: current.epoch,
      batches: current.batches.length,
      deltaBytes: current.deltaBytes,
      checkpointBytes: current.checkpoint?.bytes ?? 0,
      previousExpiresAt: previous?.expiresAt ?? null,
    })
  }

  async reset() {
    return this.serialize(async () => {
      await this.storage.deleteAll()
      return json(200, { ok: true, cleared: true })
    })
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json(204)
    const secret = env.RELAY_SECRET
    if (!secret) return json(500, { error: 'relay not configured' })
    const url = new URL(request.url)
    const separator = url.pathname.indexOf('/', 1)
    const segment = separator === -1 ? url.pathname.slice(1) : url.pathname.slice(1, separator)
    if (!secretMatches(segment, secret)) return json(404, { error: 'not found' })
    const path = separator === -1 ? '/' : url.pathname.slice(separator)
    const room = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName('default'))
    const internal = new URL(`https://relay.internal${path}`)
    internal.search = url.search
    return room.fetch(new Request(internal, request))
  },
}
