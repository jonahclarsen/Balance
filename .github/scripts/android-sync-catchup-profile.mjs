#!/usr/bin/env node

import http from 'node:http'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const packageName = 'app.balance.local.debug'
const relayPort = 8791
const proxyPort = 8790
const relaySecret = randomBytes(24).toString('base64url')
const relayUrl = `http://127.0.0.1:${proxyPort}/${relaySecret}/`
const batchCount = 66
const fixturePlans = 30
const itemsPerPlan = 20
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

async function waitFor(check, description, timeoutMs = 30_000, intervalMs = 100) {
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

function findWorkManagerJobIds() {
  const lines = adb(['shell', 'dumpsys', 'jobscheduler']).split('\n')
  const ids = []
  let currentId = ''
  for (const line of lines) {
    const header = line.match(/^\s*JOB (?:[^ ]+:)?[^/]+\/(-?\d+):/)
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
      clearTimeout(pending.timeout)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error('DevTools socket closed'))
      }
      this.pending.clear()
    })
  }

  send(method, params = {}, timeoutMs = 120_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DevTools ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, timeoutMs = 120_000) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs)
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
    return exact?.[1] ?? ''
  }, `WebView DevTools socket for pid ${pid}`)

  adb(['forward', '--remove', 'tcp:9223'], { allowFailure: true })
  adb(['forward', 'tcp:9223', `localabstract:${socketName}`])
  const target = await waitFor(async () => {
    const response = await fetch('http://127.0.0.1:9223/json/list')
    if (!response.ok) return null
    const targets = await response.json()
    return targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl) ?? null
  }, 'the Balance WebView DevTools target')

  const socket = new WebSocket(target.webSocketDebuggerUrl.replace('localhost:9223', '127.0.0.1:9223'))
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const client = new CdpClient(socket)
  return client
}

async function waitForDatabaseReady(client) {
  let lastProgress = ''
  return waitFor(async () => {
    const state = await client.evaluate(`({
      tauriReady: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
      appMounted: Boolean(document.querySelector('.app-shell')),
      loading: Boolean(document.querySelector('.database-loading-backdrop')),
      failed: Boolean(document.querySelector('.database-load-failure-backdrop')),
      progress: document.querySelector('.database-loading-progress-copy')?.innerText ?? '',
    })`, 5_000)
    if (state.progress && state.progress !== lastProgress) {
      lastProgress = state.progress
      console.log(`[sync-catchup-profile] database startup: ${state.progress.replaceAll('\n', ' ')}`)
    }
    return !state.tauriReady || !state.appMounted || state.loading ? null : state
  }, 'the database loading screen to clear', 180_000, 250)
}

function syntheticState() {
  const plans = Array.from({ length: fixturePlans }, (_, planIndex) => ({
    id: `catchup-plan-${planIndex}`,
    date: `2026-${String(Math.floor(planIndex / 28) + 1).padStart(2, '0')}-${String((planIndex % 28) + 1).padStart(2, '0')}`,
    title: `Synthetic catch-up day ${planIndex}`,
    dailyReminder: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    items: Array.from({ length: itemsPerPlan }, (_, itemIndex) => ({
      id: `catchup-item-${planIndex}-${itemIndex}`,
      text: `Synthetic catch-up task ${planIndex}-${itemIndex}`,
      html: `Synthetic catch-up task ${planIndex}-${itemIndex}`,
      done: itemIndex % 3 === 0,
      startMinutes: null,
      endMinutes: null,
      children: [],
    })),
  }))
  return {
    schemaVersion: 1,
    deviceId: 'catchup-primary',
    localSequence: 0,
    historyRevision: 0,
    activePlanDate: '2026-01-01',
    templates: [],
    plans,
    goals: [],
    goalCompletions: [],
    listTemplates: [],
    lists: [],
    metrics: [],
    metricEntries: [],
    notes: [],
    operations: [],
  }
}

async function forceBackgroundJob(proxy) {
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
  await sleep(1_000)
  const ids = await waitFor(() => {
    const candidates = findWorkManagerJobIds()
    return candidates.length > 0 ? candidates : null
  }, 'the Balance WorkManager job')
  const failures = []
  for (const id of ids) {
    const variants = [
      ['-n', 'androidx.work.systemjobscheduler'],
      [],
    ]
    for (const namespaceArgs of variants) {
      const requestsBefore = proxy.manifestRequests
      const result = spawnSync(
        'adb',
        ['shell', 'cmd', 'jobscheduler', 'run', '-f', ...namespaceArgs, packageName, id],
        { encoding: 'utf8', timeout: commandTimeoutMs },
      )
      if (result.error || result.status !== 0) {
        failures.push(
          `${id}${namespaceArgs.length > 0 ? ' namespaced' : ''}: `
            + `${result.error?.message ?? result.stderr ?? result.stdout}`.trim(),
        )
        continue
      }
      try {
        await waitFor(
          () => proxy.manifestRequests > requestsBefore,
          `background relay request from WorkManager job ${id}`,
          5_000,
        )
        return id
      } catch {
        // WorkManager also owns widget jobs. Try the next namespace or job id.
      }
    }
  }
  throw new Error(
    `No Balance JobScheduler candidate ran background relay sync: ${ids.join(', ')}`
      + (failures.length > 0 ? ` (${failures.join('; ')})` : ''),
  )
}

function createCountingProxy() {
  let manifestRequests = 0
  const server = http.createServer((request, response) => {
    if (request.url?.includes('/v3/manifest')) manifestRequests += 1
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
    get manifestRequests() {
      return manifestRequests
    },
  }
}

const relayLog = []
const relay = spawn(process.execPath, ['scripts/relay-server.mjs', String(relayPort)], {
  env: { ...process.env, BALANCE_RELAY_SECRET: relaySecret },
  stdio: ['ignore', 'pipe', 'pipe'],
})
relay.stdout.on('data', (chunk) => relayLog.push(String(chunk)))
relay.stderr.on('data', (chunk) => relayLog.push(String(chunk)))
const proxy = createCountingProxy()

let client
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

  client = await connectDevTools(await waitFor(() => appPid(), 'the running Balance process'))
  await waitForDatabaseReady(client)
  console.log('[sync-catchup-profile] creating the synthetic primary database')
  const pairingCode = await client.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    await invoke('initialize_app_state', { stateJson: ${JSON.stringify(JSON.stringify(syntheticState()))} })
    const pairingCode = await invoke('sync_new_pairing_code')
    await invoke('sync_enable_primary', { pairingCode })
    await invoke('set_sync_relay_url', { relayUrl: ${JSON.stringify(relayUrl)} })
    await invoke('sync_relay_once', { reason: 'android-catchup-seed-baseline' })
    return pairingCode
  })()`)
  console.log(`[sync-catchup-profile] staging ${batchCount} synthetic remote operations`)
  await client.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const operations = Array.from({ length: ${batchCount} }, (_, offset) => {
      const index = offset + 1
      return {
        id: 'catchup-op-' + index,
        deviceId: 'catchup-primary',
        sequence: index,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        type: 'patch_plan_item',
        payload: {
          planId: 'catchup-plan-' + Math.floor(offset / ${itemsPerPlan}),
          itemId: 'catchup-item-' + Math.floor(offset / ${itemsPerPlan}) + '-' + (offset % ${itemsPerPlan}),
          patch: { done: (offset % ${itemsPerPlan}) % 3 !== 0 },
        },
      }
    })
    await invoke('persist_operations_for_android_ci', {
      operationsJson: JSON.stringify(operations),
    })
    await invoke('sync_relay_once', { reason: 'android-catchup-seed-batches' })
    return true
  })()`)
  console.log('[sync-catchup-profile] resetting the app as an isolated joining device')
  const primaryPid = appPid()
  client.close()
  client = undefined

  adb(['shell', 'pm', 'clear', packageName])
  await waitFor(() => !appPid(), 'the primary Balance process to stop')
  // `pm clear` also removes the Android debug APK's one-time CI benchmark
  // markers. Restore only those markers so this isolated joiner does not rerun
  // the large native self-tests while the frontend opens its fresh database.
  adb(['shell', 'run-as', packageName, 'mkdir', '-p', 'Balance'])
  adb([
    'shell',
    'run-as',
    packageName,
    'touch',
    'Balance/large-sync-profile-complete',
    'Balance/android-startup-profile-complete',
  ])
  launchApp()
  const joinerPid = await waitFor(() => {
    const pid = appPid()
    return pid && pid !== primaryPid ? pid : ''
  }, 'the reset Balance process')
  client = await connectDevTools(joinerPid)
  const ready = await waitForDatabaseReady(client)
  if (ready.failed) throw new Error('the reset synthetic database did not initialize')
  await client.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    await invoke('sync_enable_joiner', { pairingCode: ${JSON.stringify(pairingCode)} })
    await invoke('set_sync_relay_url', { relayUrl: ${JSON.stringify(relayUrl)} })
    await invoke('persist_operation', { operationJson: JSON.stringify({
      id: 'catchup-joiner-local-op',
      deviceId: 'catchup-joiner',
      sequence: 1,
      timestamp: '2026-12-31T23:59:00.000Z',
      type: 'set_active_plan_date',
      payload: { date: '2026-12-31' },
    }) })
    return true
  })()`)

  console.log('[sync-catchup-profile] forcing the real WorkManager relay pass')
  const jobId = await forceBackgroundJob(proxy)
  await sleep(3_000)
  launchApp()
  console.log('[sync-catchup-profile] measuring the remaining foreground catch-up')
  const foregroundStarted = performance.now()
  const result = await client.evaluate(`window.__TAURI_INTERNALS__.invoke(
    'sync_relay_once',
    { reason: 'android-catchup-profile-foreground' },
  )`)
  const foregroundCatchupMs = Math.round(performance.now() - foregroundStarted)
  // Successful HTTP is insufficient: compare the complete synthetic plan
  // state after a real WorkManager pass and foreground catch-up. Each of the
  // 66 distinct batches flips a task, including both check and uncheck edits.
  const finalState = JSON.parse(await client.evaluate(
    `window.__TAURI_INTERNALS__.invoke('read_app_state')`,
  ))
  const expectedPlans = syntheticState().plans
  for (let offset = 0; offset < batchCount; offset += 1) {
    const item = expectedPlans[Math.floor(offset / itemsPerPlan)].items[offset % itemsPerPlan]
    item.done = !item.done
  }
  // Readback normalizes optional fields; compare every seeded field while
  // allowing the native reader to supply additional schema defaults.
  for (const expectedPlan of expectedPlans) {
    const actualPlan = finalState.plans.find((plan) => plan.id === expectedPlan.id)
    assert(actualPlan, `Missing synthetic plan ${expectedPlan.id}`)
    assert.equal(actualPlan.items.length, expectedPlan.items.length)
    for (const expectedItem of expectedPlan.items) {
      const actualItem = actualPlan.items.find((item) => item.id === expectedItem.id)
      assert(actualItem, `Missing synthetic task ${expectedItem.id}`)
      for (const [field, value] of Object.entries(expectedItem)) {
        assert.deepEqual(actualItem[field], value, `${expectedItem.id}.${field}`)
      }
    }
  }
  assert.equal(finalState.activePlanDate, '2026-12-31', 'Catch-up erased the joiner local edit')
  const report = {
    batchCount,
    fixturePlans,
    fixturePlanItems: fixturePlans * itemsPerPlan,
    forcedJobId: jobId,
    foregroundCatchupMs,
    foregroundPulledOperations: result.pulledOperations,
    backgroundMadeProgress: result.pulledOperations < batchCount + 1,
    verifiedTaskCompletions: batchCount,
    verifiedPlanItems: fixturePlans * itemsPerPlan,
    joinerLocalEditPreserved: true,
  }
  await writeFile('android-sync-catchup-profile.json', `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[sync-catchup-profile] ${JSON.stringify(report)}`)
  assert(report.backgroundMadeProgress, 'WorkManager made no progress before foreground catch-up')
} finally {
  try {
    await writeFile('android-sync-catchup-logcat.txt', adb(['logcat', '-d'], { allowFailure: true }))
    await writeFile(
      'android-sync-catchup-jobscheduler.txt',
      adb(['shell', 'dumpsys', 'jobscheduler'], { allowFailure: true }),
    )
  } catch (error) {
    relayLog.push(`Could not capture Android profile logcat: ${error}\n`)
  }
  client?.close()
  adb(['forward', '--remove', 'tcp:9223'], { allowFailure: true })
  adb(['reverse', '--remove', `tcp:${proxyPort}`], { allowFailure: true })
  await new Promise((resolve) => proxy.server.close(resolve))
  relay.kill('SIGTERM')
  await Promise.race([new Promise((resolve) => relay.once('exit', resolve)), sleep(2_000)])
  await writeFile('android-sync-catchup-relay.log', relayLog.join(''))
}
