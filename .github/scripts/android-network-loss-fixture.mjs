import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

// A fresh opaque relay and a transport fault proxy, never a personal endpoint.
export async function createNetworkLossFixture() {
  const relayPort = 8792
  const proxyPort = 8791
  const secret = randomBytes(24).toString('base64url')
  const relay = spawn(process.execPath, ['scripts/relay-server.mjs', String(relayPort)], {
    env: {...process.env, BALANCE_RELAY_SECRET: secret}, stdio: 'ignore',
  })
  let mode = 'online'
  let manifestRequests = 0
  const sockets = new Set()
  const responses = new Set()
  const server = http.createServer((request, response) => {
    if (request.url.includes('/v3/manifest')) manifestRequests++
    responses.add(response)
    response.on('close', () => responses.delete(response))
    if (mode === 'reset') return request.socket.destroy()
    if (mode === 'silent') return request.resume() // Accept TCP, never send a response.
    const upstream = http.request({hostname: '127.0.0.1', port: relayPort,
      path: request.url, method: request.method, headers: request.headers}, reply => {
      response.writeHead(reply.statusCode, reply.headers)
      reply.pipe(response)
    })
    response.on('close', () => upstream.destroy())
    upstream.on('error', () => { if (!response.destroyed) { response.writeHead(502); response.end() } })
    request.pipe(upstream)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(proxyPort, '0.0.0.0', resolve) })
    const deadline = Date.now() + 10_000
    while (true) {
      try { if ((await fetch(`http://127.0.0.1:${relayPort}/${secret}/v3/manifest`, {signal: AbortSignal.timeout(500)})).ok) break } catch {}
      if (Date.now() > deadline) throw new Error('Generated relay did not start')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } catch (error) { for (const socket of sockets) socket.destroy(); server.close(); relay.kill(); throw error }
  return {
    relayUrl: `http://10.0.2.2:${proxyPort}/${secret}/`,
    get manifestRequests() { return manifestRequests },
    setMode(value) {
      if (!['online', 'reset', 'silent'].includes(value)) throw new Error('Unknown transport mode')
      mode = value
      // Reset also cuts connections which were already accepted while silent.
      if (mode === 'reset') for (const socket of sockets) socket.destroy()
      if (mode === 'online') for (const response of responses) response.destroy()
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      relay.kill('SIGTERM')
      await Promise.race([new Promise(resolve => relay.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))])
    },
  }
}
