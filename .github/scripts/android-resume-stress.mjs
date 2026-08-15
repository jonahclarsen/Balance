#!/usr/bin/env node

import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const packageName = 'app.balance.local.debug'
const relayPort = 8788
const proxyPort = 8787
const relaySecret = randomBytes(24).toString('base64url')
const relayUrl = `http://127.0.0.1:${proxyPort}/${relaySecret}/`
const delayedResponseMs = 3_000
const stallThresholdMs = 2_000
const commandTimeoutMs = 30_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function adb(args, options = {}) {
  const result = spawnSync('adb', args, {
    encoding: 'utf8',
    timeout: options.timeout ?? commandTimeoutMs,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`adb ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return (result.stdout ?? '').replaceAll('\r', '')
}

async function waitFor(check, description, timeoutMs = 15_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ''}`)
}

function appPid() {
  return adb(['shell', 'pidof', packageName], { allowFailure: true }).trim().split(/\s+/)[0] || ''
}

function launchApp() {
  adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])
}

function backgroundApp() {
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
}

function findWorkManagerJobIds() {
  const lines = adb(['shell', 'dumpsys', 'jobscheduler']).split('\n')
  const ids = []
  let currentId = ''
  for (const line of lines) {
    // WorkManager allocates the full signed 32-bit SystemJobScheduler range,
    // so Android can legitimately display a negative job id here.
    const header = line.match(/JOB #[^/]+\/(-?\d+):/)
    if (header) currentId = header[1]
    if (
      currentId
      && line.includes(`${packageName}/androidx.work.impl.background.systemjob.SystemJobService`)
      && !ids.includes(currentId)
    ) {
      ids.push(currentId)
    }
  }
  return ids
}

async function waitForWorkManagerJobs() {
  return waitFor(() => {
    const ids = findWorkManagerJobIds()
    return ids.length > 0 ? ids : null
  }, 'the Balance WorkManager job', 10_000, 250)
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('DevTools socket closed'))
      this.pending.clear()
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, awaitPromise = true) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    }
    return response.result?.value
  }

  close() {
    this.socket.close()
  }
}

async function connectDevTools(pid) {
  const socketName = await waitFor(() => {
    const sockets = adb(['shell', 'cat', '/proc/net/unix'])
    const exact = sockets.match(new RegExp(`@(webview_devtools_remote_${pid})\\s*$`, 'm'))
    const fallback = sockets.match(/@(webview_devtools_remote[^\s]*)\s*$/m)
    return exact?.[1] ?? fallback?.[1] ?? ''
  }, `WebView DevTools socket for pid ${pid}`)

  adb(['forward', '--remove', 'tcp:9222'], { allowFailure: true })
  adb(['forward', 'tcp:9222', `localabstract:${socketName}`])
  const target = await waitFor(async () => {
    const response = await fetch('http://127.0.0.1:9222/json/list')
    if (!response.ok) return null
    const targets = await response.json()
    return targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl) ?? null
  }, 'the Balance WebView DevTools target')

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const client = new CdpClient(socket)
  await client.send('Runtime.enable')
  return client
}

async function waitForDatabaseReady(client) {
  return client.evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 20000
    const check = () => {
      const loading = Boolean(document.querySelector('.database-loading-backdrop'))
      const failed = Boolean(document.querySelector('.database-load-failure-backdrop'))
      if (!loading) return resolve({ failed, at: performance.now() })
      if (performance.now() >= deadline) return reject(new Error('database loading screen remained visible'))
      setTimeout(check, 25)
    }
    check()
  })`)
}

function createDelayedProxy() {
  let armed = null
  const server = http.createServer(async (request, response) => {
    const delay = armed
    if (delay) {
      armed = null
      delay.started()
      await sleep(delayedResponseMs)
    }

    const upstream = http.request({
      hostname: '127.0.0.1',
      port: relayPort,
      path: request.url,
      method: request.method,
      headers: request.headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', (error) => {
      response.writeHead(502, { 'content-type': 'text/plain' })
      response.end(error.message)
    })
    request.pipe(upstream)
  })

  return {
    server,
    arm() {
      let started
      const promise = new Promise((resolve) => { started = resolve })
      armed = { started }
      return promise
    },
  }
}

async function forceDelayedBackgroundSync(proxy) {
  backgroundApp()
  const jobIds = await waitForWorkManagerJobs()
  console.log(`[resume-stress] JobScheduler candidates: ${jobIds.join(', ')}`)
  const requestStarted = proxy.arm()
  let jobId = ''
  for (const candidate of jobIds) {
    const result = spawnSync('adb', ['shell', 'cmd', 'jobscheduler', 'run', '-f', packageName, candidate], {
      encoding: 'utf8',
      timeout: commandTimeoutMs,
    })
    if (!result.error && result.status === 0) {
      jobId = candidate
      break
    }
  }
  if (!jobId) throw new Error(`Android rejected every Balance JobScheduler candidate: ${jobIds.join(', ')}`)
  await Promise.race([
    requestStarted,
    sleep(5_000).then(() => { throw new Error('the forced background sync never reached the relay') }),
  ])
  return jobId
}

async function measureWarmResume(client, proxy, iteration) {
  const jobId = await forceDelayedBackgroundSync(proxy)
  const startedAt = performance.now()
  launchApp()
  const settings = await client.evaluate(
    `window.__TAURI_INTERNALS__.invoke('get_sync_settings')`,
  )
  const elapsedMs = Math.round(performance.now() - startedAt)
  if (!settings?.enabled) throw new Error('synthetic relay sync was not enabled')
  console.log(`[resume-stress] warm ${iteration}: ${elapsedMs} ms (job ${jobId})`)
  return { kind: 'warm', iteration, elapsedMs, jobId }
}

async function measureReclaimedResume(client, proxy, iteration) {
  backgroundApp()
  client.close()
  adb(['shell', 'am', 'kill', packageName])
  await waitFor(() => !appPid(), 'the cached Balance process to be reclaimed', 10_000, 200)

  const jobIds = await waitForWorkManagerJobs()
  console.log(`[resume-stress] reclaimed JobScheduler candidates: ${jobIds.join(', ')}`)
  const requestStarted = proxy.arm()
  let jobId = ''
  for (const candidate of jobIds) {
    const result = spawnSync('adb', ['shell', 'cmd', 'jobscheduler', 'run', '-f', packageName, candidate], {
      encoding: 'utf8',
      timeout: commandTimeoutMs,
    })
    if (!result.error && result.status === 0) {
      jobId = candidate
      break
    }
  }
  if (!jobId) throw new Error(`Android rejected every reclaimed JobScheduler candidate: ${jobIds.join(', ')}`)
  await Promise.race([
    requestStarted,
    sleep(5_000).then(() => { throw new Error('the reclaimed-process background sync never reached the relay') }),
  ])

  const startedAt = performance.now()
  launchApp()
  const pid = await waitFor(() => appPid(), 'Balance to restart')
  const nextClient = await connectDevTools(pid)
  const ready = await waitForDatabaseReady(nextClient)
  const elapsedMs = Math.round(performance.now() - startedAt)
  if (ready.failed) throw new Error('database recovery UI appeared during reclaimed-process resume')
  console.log(`[resume-stress] reclaimed ${iteration}: ${elapsedMs} ms (job ${jobId}, pid ${pid})`)
  return { client: nextClient, measurement: { kind: 'reclaimed', iteration, elapsedMs, jobId } }
}

const relayLog = []
const relay = spawn(process.execPath, ['scripts/relay-server.mjs', String(relayPort)], {
  env: { ...process.env, BALANCE_RELAY_SECRET: relaySecret },
  stdio: ['ignore', 'pipe', 'pipe'],
})
relay.stdout.on('data', (chunk) => relayLog.push(String(chunk)))
relay.stderr.on('data', (chunk) => relayLog.push(String(chunk)))

const proxy = createDelayedProxy()
let client
const measurements = []

try {
  await new Promise((resolve, reject) => {
    proxy.server.once('error', reject)
    proxy.server.listen(proxyPort, '127.0.0.1', resolve)
  })
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${relayPort}/${relaySecret}/v3/manifest`)
      return response.ok
    } catch {
      return false
    }
  }, 'the synthetic relay server')
  adb(['reverse', `tcp:${proxyPort}`, `tcp:${proxyPort}`])

  const pid = await waitFor(() => appPid(), 'the running Balance process')
  client = await connectDevTools(pid)
  await waitForDatabaseReady(client)
  await client.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const pairingCode = await invoke('sync_new_pairing_code')
    await invoke('sync_enable_primary', { pairingCode })
    await invoke('set_sync_relay_url', { relayUrl: ${JSON.stringify(relayUrl)} })
    await invoke('sync_relay_once', { reason: 'android-resume-ci-prime' })
    return true
  })()`)

  for (let iteration = 1; iteration <= 3; iteration += 1) {
    measurements.push(await measureWarmResume(client, proxy, iteration))
  }
  for (let iteration = 1; iteration <= 3; iteration += 1) {
    const result = await measureReclaimedResume(client, proxy, iteration)
    client = result.client
    measurements.push(result.measurement)
  }

  const stalls = measurements.filter((measurement) => measurement.elapsedMs >= stallThresholdMs)
  const report = {
    delayedResponseMs,
    stallThresholdMs,
    measurements,
    stalls: stalls.length,
    reproduced: stalls.length >= 2,
  }
  await writeFile('android-resume-stress.json', `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[resume-stress] ${stalls.length}/${measurements.length} resumes stalled for at least ${stallThresholdMs} ms`)
  if (report.reproduced) {
    throw new Error('reproduced repeated multi-second Android resume stalls while background sync held database access')
  }
} finally {
  client?.close()
  adb(['reverse', '--remove', `tcp:${proxyPort}`], { allowFailure: true })
  await new Promise((resolve) => proxy.server.close(resolve))
  relay.kill('SIGTERM')
  await Promise.race([new Promise((resolve) => relay.once('exit', resolve)), sleep(2_000)])
  await writeFile('android-resume-relay.log', relayLog.join(''))
}
