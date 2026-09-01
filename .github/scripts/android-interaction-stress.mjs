#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'

const packageName = 'app.balance.local.debug'
const seed = Number.parseInt(process.env.BALANCE_INTERACTION_STRESS_SEED ?? '1701', 10)
const durationSeconds = Number.parseInt(process.env.BALANCE_INTERACTION_STRESS_SECONDS ?? '600', 10)
const startupRelaunches = Number.parseInt(process.env.BALANCE_INTERACTION_STRESS_RELAUNCHES ?? '0', 10)
const listHistoryTransitions = Number.parseInt(
  process.env.BALANCE_INTERACTION_STRESS_LIST_HISTORY_TRANSITIONS ?? '0',
  10,
)
const commandTimeoutMs = 30_000
const devToolsPort = 9224
const actionTimeoutMs = 10_000
const stallThresholdMs = 2_000
const freezeThresholdMs = 5_000
const startedAt = Date.now()
let deadline = Number.POSITIVE_INFINITY
const actions = []
const frontendErrors = []
let randomState = seed >>> 0
let client
let expectedPid = ''
let cycle = 0
let liveLogcat
let liveLogcatOutput

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function random() {
  randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0
  return randomState / 0x1_0000_0000
}

function shuffle(values) {
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

function adb(args, options = {}) {
  const encoding = Object.prototype.hasOwnProperty.call(options, 'encoding') ? options.encoding : 'utf8'
  const result = spawnSync('adb', args, {
    encoding,
    timeout: options.timeout ?? commandTimeoutMs,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
  })
  if (result.error && !options.allowFailure) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`adb ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  if (encoding === null) return result.stdout ?? Buffer.alloc(0)
  return String(result.stdout ?? '').replaceAll('\r', '')
}

function startLiveLogcat() {
  liveLogcatOutput = createWriteStream(`android-interaction-logcat-live-${seed}.txt`)
  liveLogcat = spawn('adb', ['logcat', '-v', 'threadtime'], { stdio: ['ignore', 'pipe', 'pipe'] })
  liveLogcat.stdout.pipe(liveLogcatOutput, { end: false })
  liveLogcat.stderr.pipe(liveLogcatOutput, { end: false })
}

async function stopLiveLogcat() {
  if (liveLogcat && liveLogcat.exitCode === null) {
    liveLogcat.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => liveLogcat.once('close', resolve)),
      sleep(2_000),
    ])
  }
  liveLogcatOutput?.end()
}

async function waitFor(check, description, timeoutMs = 25_000, intervalMs = 100) {
  const waitDeadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < waitDeadline) {
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

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (!message.id) {
        if (message.method === 'Runtime.exceptionThrown') {
          frontendErrors.push({
            atMs: Date.now() - startedAt,
            kind: 'exception',
            detail: message.params?.exceptionDetails?.exception?.description
              ?? message.params?.exceptionDetails?.text
              ?? 'unknown exception',
          })
        }
        if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
          frontendErrors.push({
            atMs: Date.now() - startedAt,
            kind: 'console',
            detail: message.params.entry.text,
          })
        }
        return
      }
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

  send(method, params = {}, timeoutMs = actionTimeoutMs) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} did not respond within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, timeoutMs = actionTimeoutMs) {
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
    const fallback = sockets.match(/@(webview_devtools_remote[^\s]*)\s*$/m)
    return exact?.[1] ?? fallback?.[1] ?? ''
  }, `WebView DevTools socket for pid ${pid}`)

  adb(['forward', '--remove', `tcp:${devToolsPort}`], { allowFailure: true })
  adb(['forward', `tcp:${devToolsPort}`, `localabstract:${socketName}`])
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${devToolsPort}/json/list`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return null
    const targets = await response.json()
    return targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl) ?? null
  }, 'the Balance WebView DevTools target')

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const nextClient = new CdpClient(socket)
  await nextClient.send('Runtime.enable')
  await nextClient.send('Log.enable')
  await nextClient.send('Performance.enable')
  return nextClient
}

async function reconnect() {
  client?.close()
  expectedPid = await waitFor(() => appPid(), 'the running Balance process')
  client = await connectDevTools(expectedPid)
  await client.evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 120000
    const check = () => {
      const loading = Boolean(document.querySelector('.database-loading-backdrop'))
      const failed = Boolean(document.querySelector('.database-load-failure-backdrop'))
      if (failed) return reject(new Error('database load failure screen appeared'))
      if (!loading && document.querySelector('.app-shell')) return resolve(true)
      if (performance.now() >= deadline) return reject(new Error('database loading screen remained visible'))
      setTimeout(check, 50)
    }
    check()
  })`, 125_000)
}

async function waitForDebugStartupProfiles() {
  await waitFor(() => {
    const logcat = adb(['logcat', '-d'], { allowFailure: true, maxBuffer: 16 * 1024 * 1024 })
    return logcat.includes('BALANCE_SYNC_E2E: OK')
      && logcat.includes('BALANCE_ANDROID_STARTUP_PROFILE:')
  }, 'the debug-only native startup profiles', 120_000, 1_000)
}

async function recordAction(kind, detail, operation) {
  const actionStarted = performance.now()
  try {
    const value = await operation()
    const elapsedMs = Math.round(performance.now() - actionStarted)
    actions.push({ atMs: Date.now() - startedAt, kind, detail, elapsedMs, ok: true })
    if (elapsedMs >= stallThresholdMs) {
      console.log(`[interaction-stress] slow ${kind} (${detail}): ${elapsedMs} ms`)
    }
    return value
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - actionStarted)
    actions.push({ atMs: Date.now() - startedAt, kind, detail, elapsedMs, ok: false, error: String(error) })
    throw error
  }
}

async function heartbeat(detail) {
  return recordAction('heartbeat', detail, async () => {
    const state = await client.evaluate(`new Promise((resolve) => {
      const started = performance.now()
      setTimeout(() => requestAnimationFrame(() => resolve({
        elapsedMs: performance.now() - started,
        heading: document.querySelector('.workspace > .page-header h2, .day-pane h2')?.textContent?.trim() ?? '',
        notes: document.querySelectorAll('.note-card').length,
        drawerOpen: document.querySelector('.sidebar')?.classList.contains('mobile-drawer-open') ?? false,
      })), 0)
    })`)
    const pid = appPid()
    if (!pid) throw new Error('Balance process disappeared')
    if (pid !== expectedPid) throw new Error(`Balance process restarted unexpectedly (${expectedPid} -> ${pid})`)
    if (state.elapsedMs >= freezeThresholdMs) {
      throw new Error(`WebView event-loop heartbeat took ${Math.round(state.elapsedMs)} ms`)
    }
    return state
  })
}

async function waitForSelector(selector, description, timeoutMs = 8_000) {
  const selectorJson = JSON.stringify(selector)
  return waitFor(
    () => client.evaluate(`(() => {
      const element = document.querySelector(${selectorJson})
      if (!(element instanceof HTMLElement)) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'
    })()`),
    description,
    timeoutMs,
  )
}

async function tap(selector, detail, index = 0) {
  const selectorJson = JSON.stringify(selector)
  await recordAction('click', detail, () => client.evaluate(`(() => {
    const elements = [...document.querySelectorAll(${selectorJson})]
      .filter((element) => element instanceof HTMLElement && !element.hasAttribute('disabled'))
    const element = elements[${index}]
    if (!(element instanceof HTMLElement)) throw new Error('No enabled element matched ${selector.replaceAll("'", "\\'")} at index ${index}')
    element.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) throw new Error('Matched element has no visible bounds')
    element.click()
    return true
  })()`))
  await sleep(60)
  await heartbeat(`after ${detail}`)
}

async function setInput(selector, value, detail) {
  const selectorJson = JSON.stringify(selector)
  const valueJson = JSON.stringify(value)
  await recordAction('input', detail, () => client.evaluate(`(() => {
    const element = document.querySelector(${selectorJson})
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
      throw new Error('Input not found: ${selector.replaceAll("'", "\\'")}')
    }
    element.focus()
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
    setter.call(element, ${valueJson})
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${valueJson} }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return element.value
  })()`))
  await heartbeat(`after ${detail}`)
}

async function setRichText(selector, value, detail) {
  const selectorJson = JSON.stringify(selector)
  const valueJson = JSON.stringify(value)
  await recordAction('rich-text', detail, () => client.evaluate(`(() => {
    const element = document.querySelector(${selectorJson})
    if (!(element instanceof HTMLElement)) throw new Error('Rich text input not found')
    element.focus()
    element.textContent = ${valueJson}
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${valueJson} }))
    return element.textContent
  })()`))
  await heartbeat(`after ${detail}`)
}

async function pressKey(key, code = key) {
  await recordAction('key', key, async () => {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code })
  })
  await heartbeat(`after key ${key}`)
}

const pageSelectors = {
  Today: '.primary-nav button[title^="Today ("]',
  'Day Templates': '.primary-nav button[title^="Day Templates ("]',
  Lists: '.primary-nav button[title^="Lists ("]',
  Notes: '.primary-nav button[title^="Notes ("]',
  Metrics: '.primary-nav button[title^="Metrics ("]',
  Goals: '.primary-nav button[title^="Goals ("]',
  Settings: '.primary-nav button[title^="Settings ("]',
}

async function openPage(page) {
  const drawerOpen = await client.evaluate(`document.querySelector('.sidebar')?.classList.contains('mobile-drawer-open') ?? false`)
  if (!drawerOpen) {
    await tap('.mobile-menu-button', `open drawer for ${page}`)
    await waitForSelector('.sidebar.mobile-drawer-open', 'the mobile drawer')
  }
  await tap(pageSelectors[page], `navigate to ${page}`)
  const expectedHeading = page === 'Today' ? '.day-pane h2' : '.workspace > .page-header h2'
  await waitForSelector(expectedHeading, `${page} heading`)
}

async function exerciseNotes() {
  await openPage('Notes')
  const hasNote = await client.evaluate(`Boolean(document.querySelector('.note-card'))`)
  if (!hasNote) await tap('.note-empty button.primary', 'create first note')
  else await tap('.note-new', 'create note')
  await waitForSelector('.note-title', 'note title')
  await setInput('.note-title', `Stress note ${seed}-${cycle}`, 'rename note')

  const isEmpty = await client.evaluate(`Boolean(document.querySelector('.note-empty-editor'))`)
  if (isEmpty) await tap('.note-empty-editor', 'start empty note')
  await waitForSelector('[data-note-text-input]', 'note editor')
  await setRichText('[data-note-text-input]', `Seed ${seed} cycle ${cycle} notes page interaction`, 'write note paragraph')
  await pressKey('Enter')
  await setRichText('[data-note-text-input]:focus', `Second block ${cycle}`, 'write second note block')

  const formats = shuffle(['Heading', 'Bulleted list', 'Numbered list', 'Checklist']).slice(0, 2)
  for (const format of formats) {
    await tap(`.note-format-toolbar button[aria-label="${format}"]`, `apply ${format}`)
  }
  const checkbox = await client.evaluate(`Boolean(document.querySelector('.note-check'))`)
  if (checkbox) await tap('.note-check', 'toggle note checklist')

  const noteCount = await client.evaluate(`document.querySelectorAll('.note-card').length`)
  if (noteCount > 1) {
    await tap('.note-card', 'switch to oldest visible note', Math.floor(random() * noteCount))
  }
  await setInput('.notes-filter', 'Stress note', 'filter notes')
  await setInput('.notes-filter', '', 'clear note filter')

  if (cycle % 3 === 0) {
    await tap('.note-actions .danger', 'bin selected note')
    await tap('.notes-trash-header-button', 'open Notes Bin')
    const canRestore = await client.evaluate(`Boolean(document.querySelector('.note-actions .primary'))`)
    if (canRestore) await tap('.note-actions .primary', 'restore binned note')
  }
}

async function exercisePageFeature(page) {
  await openPage(page)
  if (page === 'Today') {
    await tap('.mobile-header-previous-day-button', 'Today previous day')
    await tap('.mobile-header-next-day-button', 'Today next day')
    return
  }
  if (page === 'Day Templates') {
    if (cycle % 4 === 1) await tap('.template-panel-actions .add-row', 'add day-template item')
    return
  }
  if (page === 'Lists') {
    const hasList = await client.evaluate(`Boolean(document.querySelector('#list-template-name'))`)
    if (!hasList) await tap('.empty-state button.primary', 'create first list')
    if (cycle % 4 === 1) await tap('.template-panel-actions .add-row', 'add list item')
    if (cycle % 5 === 0) {
      await tap('.page-header button.primary', 'open list history')
      await tap('.list-history-back', 'return from list history')
    }
    return
  }
  if (page === 'Metrics') {
    const hasMetric = await client.evaluate(`Boolean(document.querySelector('input[aria-label="Metric name"]'))`)
    if (!hasMetric) await tap('.empty-state button.primary', 'create first metric')
    if (cycle % 4 === 2) await tap('.metric-card .add-row', 'add metric question')
    return
  }
  if (page === 'Goals') {
    if (cycle % 3 === 1) {
      await setInput('input[aria-label="New goal name"]', `Goal ${seed}-${cycle}`, 'enter goal name')
      await setRichText('[aria-label="New goal matching terms"]', `term-${cycle}`, 'enter goal match term')
      await tap('.goal-add-button', 'add goal')
    } else {
      await setInput('.goal-search-input', cycle % 2 ? 'Goal' : '', 'change goal search')
    }
    return
  }
  if (page === 'Settings') {
    const themeCount = await client.evaluate(`document.querySelectorAll('.theme-option-select').length`)
    if (themeCount > 0) await tap('.theme-option-select', 'switch color theme', cycle % themeCount)
  }
}

async function backgroundResume() {
  await recordAction('lifecycle', 'background and resume', async () => {
    adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
    await sleep(500 + Math.floor(random() * 1_000))
    adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])
    await sleep(500)
  })
  await heartbeat('after background resume')
}

async function forceStopRelaunch() {
  await recordAction('lifecycle', 'force-stop and relaunch from Notes', async () => {
    client.close()
    client = undefined
    adb(['shell', 'am', 'force-stop', packageName])
    await sleep(300)
    adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])
    await reconnect()
  })
  await heartbeat('after force-stop relaunch')
}

async function rotateAndTrimMemory() {
  const rotation = cycle % 2 === 0 ? '1' : '0'
  await recordAction('system', `rotate ${rotation}`, async () => {
    adb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'])
    adb(['shell', 'settings', 'put', 'system', 'user_rotation', rotation])
    await sleep(300)
    adb(['shell', 'am', 'send-trim-memory', packageName, 'RUNNING_LOW'], { allowFailure: true })
  })
  await heartbeat('after rotation and memory trim')
}

async function collectDiagnostics(failed) {
  const suffix = String(seed)
  const logcat = adb(['logcat', '-d', '-v', 'threadtime'], { allowFailure: true, maxBuffer: 64 * 1024 * 1024 })
  const meminfo = adb(['shell', 'dumpsys', 'meminfo', packageName], { allowFailure: true })
  const gfxinfo = adb(['shell', 'dumpsys', 'gfxinfo', packageName], { allowFailure: true })
  const activity = adb(['shell', 'dumpsys', 'activity', 'processes'], { allowFailure: true, maxBuffer: 16 * 1024 * 1024 })
  const windowState = adb(['shell', 'dumpsys', 'window'], { allowFailure: true, maxBuffer: 16 * 1024 * 1024 })
  await Promise.all([
    writeFile(`android-interaction-logcat-${suffix}.txt`, logcat),
    writeFile(`android-interaction-meminfo-${suffix}.txt`, meminfo),
    writeFile(`android-interaction-gfxinfo-${suffix}.txt`, gfxinfo),
    writeFile(`android-interaction-activity-${suffix}.txt`, activity),
    writeFile(`android-interaction-window-${suffix}.txt`, windowState),
  ])
  if (failed) {
    const screenshot = adb(['exec-out', 'screencap', '-p'], { allowFailure: true, encoding: null })
    if (screenshot.length > 0) await writeFile(`android-interaction-failure-${suffix}.png`, screenshot)
    adb(['bugreport', `android-interaction-bugreport-${suffix}.zip`], {
      allowFailure: true,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    })
  }
  return { logcat, meminfo, gfxinfo }
}

let failure = null
let diagnostics = null
try {
  if (
    !Number.isFinite(seed)
    || !Number.isFinite(durationSeconds)
    || durationSeconds < 30
    || !Number.isFinite(startupRelaunches)
    || startupRelaunches < 0
    || !Number.isFinite(listHistoryTransitions)
    || listHistoryTransitions < 0
    || (startupRelaunches > 0 && listHistoryTransitions > 0)
  ) {
    throw new Error(
      'Stress seed and counts must be finite and non-negative; duration must be at least 30 seconds; select at most one focused mode',
    )
  }
  console.log(`[interaction-stress] seed ${seed}; target duration ${durationSeconds}s`)
  adb(['install', '-r', 'balance-debug.apk'])
  adb(['logcat', '-c'])
  startLiveLogcat()
  adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])
  expectedPid = await waitFor(() => appPid(), 'the running Balance process')
  client = await connectDevTools(expectedPid)
  // The debug APK deliberately runs expensive native CI profiles during app
  // setup. A frontend read issued while those profiles own the startup DB can
  // remain pending even after their scratch work ends. Wait for their success
  // markers, then reload only the synthetic WebView so the actual interaction
  // journey starts through the normal, uncontended hydration path.
  await waitForDebugStartupProfiles()
  await client.evaluate(`(() => { setTimeout(() => window.location.reload(), 0); return true })()`)
  await sleep(500)
  await reconnect()
  await heartbeat('initial launch')
  // Debug APK startup intentionally runs large synthetic native sync and
  // database profiles before the frontend can read state. Start the requested
  // interaction duration only after those one-time diagnostics release the DB.
  if (startupRelaunches > 0) {
    await openPage('Notes')
    for (cycle = 1; cycle <= startupRelaunches; cycle += 1) {
      console.log(`[interaction-stress] startup relaunch ${cycle}/${startupRelaunches}`)
      await forceStopRelaunch()
    }
    cycle = startupRelaunches
  } else if (listHistoryTransitions > 0) {
    await openPage('Lists')
    const hasList = await client.evaluate(`Boolean(document.querySelector('#list-template-name'))`)
    if (!hasList) await tap('.empty-state button.primary', 'create first list')
    for (cycle = 1; cycle <= listHistoryTransitions; cycle += 1) {
      console.log(`[interaction-stress] list history transition ${cycle}/${listHistoryTransitions}`)
      await tap('.page-header button.primary', 'open list history')
      await tap('.list-history-back', 'return from list history')
    }
    cycle = listHistoryTransitions
  } else {
    deadline = Date.now() + durationSeconds * 1_000

    while (Date.now() < deadline || cycle < 3) {
      cycle += 1
      console.log(`[interaction-stress] cycle ${cycle}; ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s remaining`)
      await exerciseNotes()
      for (const page of shuffle(['Today', 'Day Templates', 'Lists', 'Metrics', 'Goals', 'Settings'])) {
        await exercisePageFeature(page)
        if (Date.now() >= deadline && cycle >= 3) break
      }
      await openPage('Notes')
      await backgroundResume()
      if (cycle % 2 === 0) await rotateAndTrimMemory()
      if (cycle % 3 === 0) await forceStopRelaunch()
    }
  }
} catch (error) {
  failure = error
  console.error(`[interaction-stress] FAILED: ${error?.stack ?? error}`)
} finally {
  diagnostics = await collectDiagnostics(Boolean(failure))
  client?.close()
  adb(['forward', '--remove', `tcp:${devToolsPort}`], { allowFailure: true })
  adb(['shell', 'settings', 'put', 'system', 'user_rotation', '0'], { allowFailure: true })
  adb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1'], { allowFailure: true })
  await stopLiveLogcat()
}

const slowActions = actions.filter((action) => (
  !['lifecycle', 'system'].includes(action.kind) && action.elapsedMs >= stallThresholdMs
))
const freezeActions = actions.filter((action) => (
  !['lifecycle', 'system'].includes(action.kind) && action.elapsedMs >= freezeThresholdMs
))
const failedActions = actions.filter((action) => !action.ok)
const fatalLogLines = diagnostics.logcat.split('\n').filter((line) => (
  /FATAL EXCEPTION|ANR in app\.balance\.local\.debug|am_anr.*app\.balance\.local\.debug|Fatal signal.*(?:balance|libbalance)/i.test(line)
))
const report = {
  seed,
  requestedDurationSeconds: durationSeconds,
  requestedStartupRelaunches: startupRelaunches,
  requestedListHistoryTransitions: listHistoryTransitions,
  elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
  cycles: cycle,
  actionCount: actions.length,
  failedActionCount: failedActions.length,
  slowActionCount: slowActions.length,
  freezeActionCount: freezeActions.length,
  stallThresholdMs,
  freezeThresholdMs,
  frontendErrorCount: frontendErrors.length,
  fatalLogLineCount: fatalLogLines.length,
  finalPid: appPid(),
  reproducedFreeze: Boolean(failure) || freezeActions.length > 0 || fatalLogLines.length > 0,
  failure: failure ? String(failure?.stack ?? failure) : null,
  slowActions,
  freezeActions,
  failedActions,
  frontendErrors,
  fatalLogLines,
  actions,
}
await writeFile(`android-interaction-stress-${seed}.json`, `${JSON.stringify(report, null, 2)}\n`)

console.log(`[interaction-stress] ${report.cycles} cycles, ${report.actionCount} timed actions, ${report.slowActionCount} slow, ${report.frontendErrorCount} frontend errors, ${report.fatalLogLineCount} fatal/ANR log lines`)
if (failure) throw failure
if (freezeActions.length > 0) throw new Error(`Detected ${freezeActions.length} interaction freezes at or above ${freezeThresholdMs} ms`)
if (fatalLogLines.length > 0) throw new Error(`Detected ${fatalLogLines.length} fatal/ANR log lines`)
