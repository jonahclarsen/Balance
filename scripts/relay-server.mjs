#!/usr/bin/env node
// Reference relay server for Balance multi-device sync.
//
// A deliberately dumb store-and-forward service: it holds opaque, end-to-end
// encrypted changeset envelopes and never has the sync key, so it cannot read
// anything it stores. Matches the contract the app's SyncPanel speaks, with
// every route living under a secret path prefix:
//
//   POST /<secret>/push   body: JSON number[]      (one sealed envelope's bytes)
//   GET  /<secret>/pull   ->   JSON number[][]     (all stored envelopes)
//
// The prefix is the access control. Over HTTPS the path is encrypted in
// transit, so it is about as strong as a bearer token, and it needs no app-side
// changes — the relay URL saved in the app is just the base plus the secret.
//
// Run:  BALANCE_RELAY_SECRET=<hex> node scripts/relay-server.mjs [port]
//
// Binds loopback only. Expose it deliberately (e.g. a Cloudflare Tunnel), or
// set BALANCE_RELAY_HOST=0.0.0.0 to serve the local network.
//
// This is a single-room reference; a production deployment would shard by
// account and authenticate, but the E2EE guarantee is identical — the server
// only ever sees ciphertext.

import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

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

/** Reject oversized envelopes: a sealed delta of the whole op log is far smaller. */
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024
/** Cap retained envelopes so an unbounded push loop cannot exhaust memory. */
const MAX_STORED = 200

/** @type {number[][]} sealed envelopes, in arrival order. */
const envelopes = []

function send(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  })
  res.end(payload)
}

/** The path under the secret prefix, or null if the prefix does not match. */
function authenticatedPath(url) {
  const separator = url.indexOf('/', 1)
  const segment = separator === -1 ? url.slice(1) : url.slice(1, separator)
  const candidate = Buffer.from(segment)
  // timingSafeEqual demands equal lengths; only the secret's length leaks.
  if (candidate.length !== secretBytes.length) return null
  if (!timingSafeEqual(candidate, secretBytes)) return null
  return separator === -1 ? '/' : url.slice(separator)
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204)

  const path = authenticatedPath(req.url ?? '/')
  // Wrong or missing prefix looks exactly like a nonexistent route.
  if (path === null) return send(res, 404, { error: 'not found' })

  if (req.method === 'POST' && path === '/push') {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_ENVELOPE_BYTES) req.destroy()
    })
    req.on('end', () => {
      try {
        const env = JSON.parse(raw)
        if (!Array.isArray(env)) throw new Error('expected number[]')
        envelopes.push(env)
        if (envelopes.length > MAX_STORED) {
          envelopes.splice(0, envelopes.length - MAX_STORED)
        }
        send(res, 200, { ok: true, stored: envelopes.length })
      } catch (err) {
        send(res, 400, { error: String(err) })
      }
    })
    return
  }

  if (req.method === 'GET' && path.startsWith('/pull')) {
    return send(res, 200, envelopes)
  }

  if (req.method === 'GET' && path === '/health') {
    return send(res, 200, { ok: true, envelopes: envelopes.length })
  }

  send(res, 404, { error: 'not found' })
})

server.listen(port, host, () => {
  console.log(`Balance relay listening on http://${host}:${port}/${secret}`)
})
