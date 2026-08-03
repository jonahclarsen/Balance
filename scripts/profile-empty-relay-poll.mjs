import { writeFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import process from 'node:process'

import worker, { RelayRoom } from '../relay-worker/src/index.js'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const DEFAULT_SAMPLES = 20_000
// Match the deployed token lengths without using any live credential or data.
const SECRET = 'profile-secret-placeholder-00000'
const EPOCH = 'profile-epoch-placeholder-000000'
const HOST = 'balance-relay.example'

class ProfileStorage {
  values = new Map()
  gets = 0
  puts = 0
  deletes = 0

  async get(key) {
    this.gets += 1
    return this.values.get(key)
  }

  async put(keyOrEntries, value) {
    this.puts += 1
    const entries = typeof keyOrEntries === 'string'
      ? [[keyOrEntries, value]]
      : Object.entries(keyOrEntries)
    for (const [key, entry] of entries) this.values.set(key, entry)
  }

  async delete(keys) {
    this.deletes += 1
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key)
  }

  async deleteAll() {
    this.deletes += 1
    this.values.clear()
  }

  resetCounters() {
    this.gets = 0
    this.puts = 0
    this.deletes = 0
  }
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function http1RequestBytes(url) {
  const target = `${url.pathname}${url.search}`
  return Buffer.byteLength(`GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`)
}

function http1ResponseBytes(response, bodyBytes) {
  let headers = ''
  for (const [name, value] of response.headers) headers += `${name}: ${value}\r\n`
  if (!response.headers.has('content-length')) headers += `content-length: ${bodyBytes}\r\n`
  return Buffer.byteLength(`HTTP/1.1 ${response.status} ${response.statusText}\r\n${headers}\r\n`) + bodyBytes
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits))
}

const samples = positiveInteger(argument('--samples', DEFAULT_SAMPLES), '--samples')
const jsonPath = argument('--json', '')
const storage = new ProfileStorage()
const room = new RelayRoom({ storage })
const env = {
  RELAY_SECRET: SECRET,
  RELAY_ROOM: {
    idFromName: () => 'profile-room',
    get: () => room,
  },
}
const url = new URL(`https://${HOST}/${SECRET}/v3/manifest?epoch=${EPOCH}&after=0`)

// Warm up the route and initialize the empty generation before measuring the
// steady-state poll that foreground clients perform when nothing has changed.
for (let index = 0; index < 100; index += 1) {
  const response = await worker.fetch(new Request(url), env)
  if (!response.ok) throw new Error(`warmup failed with ${response.status}`)
  await response.arrayBuffer()
}
storage.resetCounters()

const cpuStart = process.cpuUsage()
const wallStart = process.hrtime.bigint()
let responseBodyBytes = 0
let requestBytes = 0
let responseBytes = 0

for (let index = 0; index < samples; index += 1) {
  const response = await worker.fetch(new Request(url), env)
  const body = await response.arrayBuffer()
  if (!response.ok) throw new Error(`profile poll failed with ${response.status}`)
  if (index === 0) {
    responseBodyBytes = body.byteLength
    requestBytes = http1RequestBytes(url)
    responseBytes = http1ResponseBytes(response, responseBodyBytes)
  } else if (body.byteLength !== responseBodyBytes) {
    throw new Error('empty manifest response size changed during the profile')
  }
}

const wallMs = Number(process.hrtime.bigint() - wallStart) / 1_000_000
const cpu = process.cpuUsage(cpuStart)
const cpuMs = (cpu.user + cpu.system) / 1_000
const bytesPerPoll = requestBytes + responseBytes
const result = {
  samples,
  wallMs: round(wallMs),
  cpuMs: round(cpuMs),
  cpuMicrosecondsPerPoll: round((cpuMs * 1_000) / samples, 3),
  pollsPerSecond: round(samples / (wallMs / 1_000)),
  durableObjectReadsPerPoll: round(storage.gets / samples, 3),
  durableObjectWritesPerPoll: round(storage.puts / samples, 3),
  responseBodyBytes,
  modeledHttp1RequestBytes: requestBytes,
  modeledHttp1ResponseBytes: responseBytes,
  modeledHttp1BytesPerPoll: bytesPerPoll,
  modeledBytesPerMinute: {
    activeTwoSecondPolling: round(bytesPerPoll * 30),
    quietEightSecondPolling: round(bytesPerPoll * 7.5),
    hiddenFiveMinutePolling: round(bytesPerPoll / 5),
  },
  notes: [
    'CPU is measured in Node.js on the CI runner and is a regression profile, not Cloudflare billable CPU.',
    'Network estimates model HTTP/1.1 application bytes and exclude TLS, TCP/IP, and HTTP/2 header compression.',
  ],
}

if (result.durableObjectWritesPerPoll !== 0) throw new Error('an empty poll unexpectedly writes relay storage')
if (responseBodyBytes > 512) throw new Error(`empty manifest grew beyond 512 bytes: ${responseBodyBytes}`)
if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`)

console.log(JSON.stringify(result, null, 2))
