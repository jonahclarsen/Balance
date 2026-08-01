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
//
// Envelopes are stored as the exact JSON text the app sent, never parsed. A
// push is the whole sealed op log, so it runs to megabytes, and JSON.parse plus
// a byte/base64 round trip on that would burn far more than the CPU budget a
// request gets. Slicing and concatenating strings costs almost nothing, and the
// relay has no reason to understand the payload anyway.

/// Cap on the JSON *text* of one envelope. Each byte serializes to up to four
/// characters ("255,"), so this is roughly a 6 MB sealed envelope.
const MAX_ENVELOPE_TEXT = 24 * 1024 * 1024
/// Each envelope is a full op log, not a delta, so retaining many of them costs
/// real storage and makes /pull assemble a huge response. A handful is enough
/// to cover every device's most recent push.
const MAX_STORED = 6
/// Durable Object storage caps values at 128 KiB, so split envelopes up.
const CHUNK_CHARS = 96 * 1024
/// Durable Object put() takes at most 128 entries at a time.
const MAX_KEYS_PER_PUT = 128

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function json(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  })
}

/// Sends an already-serialized JSON string, so a large pull is never re-encoded.
function rawJson(status, text) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
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
    const raw = (await request.text()).trim()
    if (raw.length > MAX_ENVELOPE_TEXT) {
      return json(413, { error: 'envelope too large', characters: raw.length })
    }
    // A shape check, not a parse: the relay stores ciphertext it cannot read,
    // and a malformed body simply fails to decrypt on the receiving device.
    if (!raw.startsWith('[') || !raw.endsWith(']')) {
      return json(400, { error: 'expected a JSON array' })
    }

    return this.serialize(async () => {
      const sequences = (await this.storage.get('sequences')) ?? []
      const next = (await this.storage.get('nextSequence')) ?? 1

      let entries = []
      let chunks = 0
      for (let offset = 0; offset < raw.length; offset += CHUNK_CHARS) {
        entries.push([`e:${next}:${chunks}`, raw.slice(offset, offset + CHUNK_CHARS)])
        chunks += 1
        if (entries.length === MAX_KEYS_PER_PUT) {
          await this.storage.put(Object.fromEntries(entries))
          entries = []
        }
      }
      entries.push([`e:${next}:chunks`, chunks])
      await this.storage.put(Object.fromEntries(entries))

      const retained = [...sequences, next]
      const evicted = retained.splice(0, Math.max(0, retained.length - MAX_STORED))

      // Only now is the envelope readable, so a crash mid-write cannot publish
      // a half-stored envelope.
      await this.storage.put({ sequences: retained, nextSequence: next + 1 })
      for (const sequence of evicted) await this.deleteEnvelope(sequence)

      return json(200, { ok: true, stored: retained.length })
    })
  }

  async deleteEnvelope(sequence) {
    const chunks = (await this.storage.get(`e:${sequence}:chunks`)) ?? 0
    let keys = [`e:${sequence}:chunks`]
    for (let i = 0; i < chunks; i += 1) {
      keys.push(`e:${sequence}:${i}`)
      if (keys.length === MAX_KEYS_PER_PUT) {
        await this.storage.delete(keys)
        keys = []
      }
    }
    if (keys.length) await this.storage.delete(keys)
  }

  async pull() {
    const sequences = (await this.storage.get('sequences')) ?? []
    const envelopes = []
    for (const sequence of sequences) {
      const chunks = (await this.storage.get(`e:${sequence}:chunks`)) ?? 0
      let text = ''
      for (let i = 0; i < chunks; i += 1) {
        text += (await this.storage.get(`e:${sequence}:${i}`)) ?? ''
      }
      if (text) envelopes.push(text)
    }
    // Each element is already JSON, so wrapping them is pure concatenation.
    return rawJson(200, `[${envelopes.join(',')}]`)
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
