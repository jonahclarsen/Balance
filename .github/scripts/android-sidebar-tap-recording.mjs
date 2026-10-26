#!/usr/bin/env node

// Records real touchscreen taps on the mobile navigation drawer and checks that
// each tapped destination is selected once, without flipping back and forth
// before its page opens. Uploads the screen recording for visual review.

import { spawn, spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const packageName = 'app.balance.local.debug'
const devToolsPort = 9225
const recordingPath = '/sdcard/sidebar-tap.mp4'
const destinations = ['notes', 'goals', 'settings', 'today']

function log(message) {
  console.log(`[sidebar-tap] ${message}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function adb(args, options = {}) {
  const result = spawnSync('adb', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`adb ${args.join(' ')} failed (${result.status}): ${result.error ?? result.stderr ?? result.stdout}`)
  }
  return String(result.stdout ?? '').replaceAll('\r', '')
}

async function waitFor(check, description, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ''}`)
}

function appPid() {
  return adb(['shell', 'pidof', packageName], { allowFailure: true }).trim().split(/\s+/)[0] || ''
}

async function connect() {
  const pid = await waitFor(() => appPid(), 'the running Balance process')
  const socketName = await waitFor(() => {
    const sockets = adb(['shell', 'cat', '/proc/net/unix'])
    return sockets.match(new RegExp(`@(webview_devtools_remote_${pid})\\s*$`, 'm'))?.[1] ?? ''
  }, 'the WebView DevTools socket')
  adb(['forward', '--remove', `tcp:${devToolsPort}`], { allowFailure: true })
  adb(['forward', `tcp:${devToolsPort}`, `localabstract:${socketName}`])
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${devToolsPort}/json/list`, { signal: AbortSignal.timeout(2_000) })
    const targets = response.ok ? await response.json() : []
    return targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl)
  }, 'the Balance WebView DevTools target')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else if (message.result?.exceptionDetails) request.reject(new Error(JSON.stringify(message.result.exceptionDetails)))
    else request.resolve(message.result?.result?.value)
  })
  return {
    evaluate(expression, timeoutMs = 10_000) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`DevTools evaluation timed out: ${expression.slice(0, 80)}`))
        }, timeoutMs)
      })
    },
    close: () => socket.close(),
  }
}

async function waitForApp(client) {
  await waitFor(() => client.evaluate(`Boolean(document.querySelector('.app-shell')) && !document.querySelector('.database-loading-backdrop')`), 'the planner', 120_000)
}

// Taps through Android input, so the WebView gets genuine touch events,
// tap highlighting and gesture-generated clicks.
async function tap(client, selector) {
  const point = await client.evaluate(`(async () => {
    const element = document.querySelector(${JSON.stringify(selector)})
    element.scrollIntoView({ block: 'nearest' })
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 300)))
    const rect = element.getBoundingClientRect()
    return { x: (rect.left + rect.width / 2) * devicePixelRatio, y: (rect.top + rect.height / 2) * devicePixelRatio }
  })()`)
  adb(['shell', 'input', 'tap', String(Math.round(point.x)), String(Math.round(point.y))])
}

adb(['install', '-r', 'balance-debug.apk'])
adb(['logcat', '-c'])
adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])
let client = await connect()
log('connected; waiting for debug startup profiles')
// The debug APK runs native CI profiles at startup; begin after they release the database.
await waitFor(() => {
  const logcat = adb(['logcat', '-d'], { allowFailure: true })
  return logcat.includes('BALANCE_SYNC_E2E: OK') && logcat.includes('BALANCE_ANDROID_STARTUP_PROFILE:')
}, 'debug startup profiles', 120_000)
// Generated CI database and test key only; never return or log the key.
await client.evaluate(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke
  const status = await invoke('get_recovery_key_status')
  if (!status.confirmed) await invoke('confirm_recovery_key', { recoveryKey: status.recoveryKey })
  setTimeout(() => location.reload(), 0)
  return true
})()`, 60_000)
log('recovery key confirmed; reloading')
await sleep(500)
client.close()
client = await connect()
await waitForApp(client)
log('planner ready')

const screen = adb(['shell', 'wm', 'size']).match(/(\d+)x(\d+)\s*$/m)
const viewport = await client.evaluate(`({ width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio, theme: document.documentElement.dataset.theme ?? '' })`)
if (Math.abs(Number(screen[1]) - viewport.width) > 2) {
  throw new Error(`The WebView is not full width (${viewport.width}px of ${screen[1]}px); taps would miss`)
}

// Record selection changes on navigation buttons, not just the final state.
await client.evaluate(`(() => {
  window.__sidebarTapTrace = []
  const record = (event) => window.__sidebarTapTrace.push({ at: performance.now(), ...event })
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) {
    document.addEventListener(type, (event) => {
      const view = event.target instanceof Element ? event.target.closest('[data-nav-view]')?.dataset.navView : undefined
      if (view) record({ type, view })
    }, true)
  }
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const button = mutation.target
      if (!(button instanceof HTMLElement) || !button.dataset.navView) continue
      const active = button.classList.contains('active')
      if (active !== mutation.oldValue?.split(/\\s+/).includes('active')) record({ type: active ? 'selected' : 'deselected', view: button.dataset.navView })
    }
  }).observe(document.querySelector('.primary-nav'), { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true })
  return true
})()`)

log(`recording ${viewport.theme} theme`)
const recorder = spawn('adb', ['shell', 'screenrecord', '--bit-rate', '20000000', '--time-limit', '60', recordingPath], { stdio: 'ignore' })
await sleep(1_500)
const taps = []
for (const destination of destinations) {
  await tap(client, '.mobile-menu-button')
  await waitFor(() => client.evaluate(`document.querySelector('.sidebar')?.classList.contains('mobile-drawer-open')`), 'the open drawer')
  await sleep(900)
  const startedAt = await client.evaluate('performance.now()')
  await tap(client, `.primary-nav [data-nav-view="${destination}"]`)
  await waitFor(() => client.evaluate(`!document.querySelector('.sidebar')?.classList.contains('mobile-drawer-open')`), `${destination} to open`)
  await sleep(1_200)
  const events = await client.evaluate(`window.__sidebarTapTrace.filter((event) => event.at >= ${startedAt})`)
  const selectionChanges = events.filter((event) => event.view === destination && ['selected', 'deselected'].includes(event.type))
  log(`opened ${destination}; its selection went ${selectionChanges.map((event) => event.type).join(' -> ') || 'unchanged'}`)
  taps.push({
    destination,
    selectionChanges: selectionChanges.map((event) => event.type),
    events: events.map((event) => ({ ...event, at: Math.round(event.at - startedAt) })),
  })
}
await sleep(500)
adb(['shell', 'pkill', '-INT', 'screenrecord'], { allowFailure: true })
await new Promise((resolve) => recorder.once('close', resolve))
await sleep(1_000)
adb(['pull', recordingPath, 'android-sidebar-tap.mp4'])
client.close()
adb(['forward', '--remove', `tcp:${devToolsPort}`], { allowFailure: true })

const flickers = taps.filter((entry) => entry.selectionChanges.length > 1)
const report = { theme: viewport.theme, screen: `${screen[1]}x${screen[2]}`, taps, flickers: flickers.map((entry) => entry.destination) }
await writeFile('android-sidebar-tap.json', `${JSON.stringify(report, null, 2)}\n`)
if (flickers.length > 0) throw new Error(`Selection flickered while opening ${report.flickers.join(', ')}`)
