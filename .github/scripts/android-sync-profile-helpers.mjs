import { spawnSync } from 'node:child_process'

export const packageName = 'app.balance.local.debug'
const commandTimeoutMs = 30_000
const fixturePlans = 30
const itemsPerPlan = 20

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function adb(args, options = {}) {
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

export async function waitFor(check, description, timeoutMs = 30_000, intervalMs = 100) {
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

export function appPid() {
  return adb(['shell', 'pidof', packageName], { allowFailure: true }).trim().split(/\s+/)[0] || ''
}

export function launchApp() {
  adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])
}

export function findWorkManagerJobIds() {
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

export async function connectDevTools(pid) {
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

export async function waitForDatabaseReady(client) {
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

export function syntheticState() {
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

