#!/usr/bin/env node
// Reference relay server for Balance multi-device sync.
//
// A deliberately dumb store-and-forward service: it holds opaque, end-to-end
// encrypted changeset envelopes and never has the sync key, so it cannot read
// anything it stores. Matches the contract the app's SyncPanel speaks:
//
//   POST /push   body: JSON number[]      (one sealed envelope's bytes)
//   GET  /pull   ->   JSON number[][]     (all stored envelopes)
//
// Run:  node scripts/relay-server.mjs [port]      (default 8787)
//
// This is a single-room reference; a production deployment would shard by
// account and authenticate, but the E2EE guarantee is identical — the server
// only ever sees ciphertext.

import http from 'node:http'

const port = Number(process.argv[2] ?? 8787)

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

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204)

  if (req.method === 'POST' && req.url === '/push') {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 50 * 1024 * 1024) req.destroy() // basic guard
    })
    req.on('end', () => {
      try {
        const env = JSON.parse(raw)
        if (!Array.isArray(env)) throw new Error('expected number[]')
        envelopes.push(env)
        send(res, 200, { ok: true, stored: envelopes.length })
      } catch (err) {
        send(res, 400, { error: String(err) })
      }
    })
    return
  }

  if (req.method === 'GET' && req.url?.startsWith('/pull')) {
    return send(res, 200, envelopes)
  }

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, envelopes: envelopes.length })
  }

  send(res, 404, { error: 'not found' })
})

server.listen(port, () => {
  console.log(`Balance relay listening on http://127.0.0.1:${port}`)
})
