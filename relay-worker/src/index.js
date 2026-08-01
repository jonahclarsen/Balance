// Balance sync relay, as a Cloudflare Worker.
//
// Same contract as the local reference server in `scripts/relay-server.mjs`,
// so the app needs no changes — only a different base URL:
//
//   POST /<secret>/push   body: JSON number[]      (one sealed envelope's bytes)
//   GET  /<secret>/pull   ->   JSON number[][]     (all stored envelopes)
//
// The relay never holds the sync key, so everything below is opaque ciphertext.
// State lives in a single Durable Object because the Worker itself is
// stateless, and because a push from one device must be immediately visible to
// a pull from another (KV's eventual consistency would not be).

/** Reject oversized envelopes: a sealed op log is far smaller. */
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024
/** Cap retained envelopes so a push loop cannot run up unbounded storage. */
const MAX_STORED = 200
/** Durable Object storage caps values at 128 KiB, so split envelopes up. */
const CHUNK_BYTES = 96 * 1024

function json(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  })
}

/** Compares without an early exit, so timing does not reveal the secret. */
function secretMatches(candidate, secret) {
  if (candidate.length !== secret.length) return false
  let diff = 0
  for (let i = 0; i < candidate.length; i += 1) {
    diff |= candidate.charCodeAt(i) ^ secret.charCodeAt(i)
  }
  return diff === 0
}

function bytesToBase64(bytes) {
  let binary = ''
  // String.fromCharCode is variadic; feed it in slices to bound the arg count.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export class RelayRoom {
  constructor(state) {
    this.storage = state.storage
    // Pushes read-modify-write the sequence index; DO handlers can interleave
    // at await points, so run mutations one at a time.
    this.queue = Promise.resolve()
  }

  serialize(work) {
    const result = this.queue.then(work, work)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (request.method === 'POST' && pathname === '/push') return this.push(request)
    if (request.method === 'GET' && pathname === '/pull') return this.pull()
    if (request.method === 'GET' && pathname === '/health') return this.health()
    if (request.method === 'POST' && pathname === '/reset') return this.reset()
    return json(404, { error: 'not found' })
  }

  async push(request) {
    const raw = await request.text()
    if (raw.length > MAX_ENVELOPE_BYTES) {
      return json(413, { error: 'envelope too large' })
    }

    let bytes
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('expected number[]')
      bytes = Uint8Array.from(parsed)
    } catch (err) {
      return json(400, { error: String(err) })
    }

    return this.serialize(async () => {
      const sequences = (await this.storage.get('sequences')) ?? []
      const next = (await this.storage.get('nextSequence')) ?? 1

      const base64 = bytesToBase64(bytes)
      const writes = {}
      let chunks = 0
      for (let offset = 0; offset < base64.length; offset += CHUNK_BYTES) {
        writes[`e:${next}:${chunks}`] = base64.slice(offset, offset + CHUNK_BYTES)
        chunks += 1
      }
      writes[`e:${next}:chunks`] = chunks

      const retained = [...sequences, next]
      const evicted = retained.splice(0, Math.max(0, retained.length - MAX_STORED))

      await this.storage.put(writes)
      await this.storage.put({ sequences: retained, nextSequence: next + 1 })
      for (const sequence of evicted) await this.deleteEnvelope(sequence)

      return json(200, { ok: true, stored: retained.length })
    })
  }

  async deleteEnvelope(sequence) {
    const chunks = (await this.storage.get(`e:${sequence}:chunks`)) ?? 0
    const keys = [`e:${sequence}:chunks`]
    for (let i = 0; i < chunks; i += 1) keys.push(`e:${sequence}:${i}`)
    await this.storage.delete(keys)
  }

  async pull() {
    const sequences = (await this.storage.get('sequences')) ?? []
    const envelopes = []
    for (const sequence of sequences) {
      const chunks = (await this.storage.get(`e:${sequence}:chunks`)) ?? 0
      let base64 = ''
      for (let i = 0; i < chunks; i += 1) {
        base64 += (await this.storage.get(`e:${sequence}:${i}`)) ?? ''
      }
      if (base64) envelopes.push(Array.from(base64ToBytes(base64)))
    }
    return json(200, envelopes)
  }

  /// Empties the room. Devices re-push their full sealed op log on the next
  /// sync, so this loses nothing — and it is the way out if a malformed
  /// envelope ever lands here, since a device that cannot decrypt one aborts
  /// its whole sync pass.
  async reset() {
    return this.serialize(async () => {
      await this.storage.deleteAll()
      return json(200, { ok: true, cleared: true })
    })
  }

  async health() {
    const sequences = (await this.storage.get('sequences')) ?? []
    return json(200, { ok: true, envelopes: sequences.length })
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
    // A wrong prefix is indistinguishable from a route that does not exist.
    if (!secretMatches(segment, secret)) return json(404, { error: 'not found' })

    const path = separator === -1 ? '/' : url.pathname.slice(separator)
    const room = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName('default'))
    // Address the object on an internal hostname. Reusing the public origin
    // makes the edge read this as a same-zone subrequest and reject it (1042).
    return room.fetch(new Request(`https://relay.internal${path}`, request))
  },
}
