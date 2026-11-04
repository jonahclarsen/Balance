#!/usr/bin/env node
// Records voice ideas on a disposable emulator install: stopping from the
// notification in the background, keeping Android out of call mode with the
// phone microphone, and recovering after the app is killed. The emulator's
// microphone only produces silence, and it has no echo canceller, so Chromium
// stays out of call mode with either microphone.

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const packageName = process.env.BALANCE_TEST_PACKAGE ?? 'app.balance.local'
const backgroundMs = 12_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function adb(args, { allowFailure = false } = {}) {
  const result = spawnSync('adb', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) throw new Error(`adb ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return (result.stdout ?? '').replaceAll('\r', '')
}

async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) { lastError = error }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ''}`)
}

async function connect() {
  const pid = await waitFor(() => adb(['shell', 'pidof', packageName], { allowFailure: true }).trim().split(/\s+/)[0], 'the app process', 60_000)
  const socketName = await waitFor(() => adb(['shell', 'cat', '/proc/net/unix']).match(new RegExp(`@(webview_devtools_remote_${pid})\\s*$`, 'm'))?.[1], 'the DevTools socket', 60_000)
  adb(['forward', '--remove', 'tcp:9222'], { allowFailure: true })
  adb(['forward', 'tcp:9222', `localabstract:${socketName}`])
  const target = await waitFor(async () => {
    const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
    return targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl)
  }, 'the WebView page')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  })
  return async (expression) => {
    const id = nextId++
    const response = await new Promise((resolve) => {
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    if (response.error || response.result.exceptionDetails) throw new Error(JSON.stringify(response.error ?? response.result.exceptionDetails))
    return response.result.result.value
  }
}

// The dump also lists the channel, which outlives the notification.
const notification = () => adb(['shell', 'dumpsys', 'notification', '--noredact']).includes('Notification(channel=voice-recording')
const isForeground = () => /isForeground=true/.test(adb(['shell', 'dumpsys', 'activity', 'services', 'BalanceVoiceRecordingService']))

// uiautomator needs a second of idle UI, which the notification's ticking timer
// never allows, so this sends the intent behind the Stop action instead of tapping.
function sendNotificationStop() {
  const dump = adb(['shell', 'dumpsys', 'notification', '--noredact'])
  if (!/"Stop"\s*->\s*PendingIntent/.test(dump)) throw new Error('The recording notification has no Stop action')
  adb(['shell', 'am', 'startservice', '-n', `${packageName}/app.balance.local.BalanceVoiceRecordingService`, '-a', 'app.balance.local.STOP_VOICE_RECORDING'])
}

function audioMode() {
  const dump = adb(['shell', 'dumpsys', 'audio'])
  return dump.match(/mode \(internal\) = (\w+)/)?.[1] ?? dump.match(/^\s*mMode\s*[:=]\s*(\w+)/m)?.[1] ?? 'unknown'
}

async function readClips(evaluate) {
  const state = await evaluate(`window.__TAURI_INTERNALS__.invoke('read_app_state')`)
  return (typeof state === 'string' ? JSON.parse(state) : state).voiceClips ?? []
}

async function run() {
  // Root may start the service the way the notification's PendingIntent does.
  adb(['root'])
  await sleep(2_000)
  adb(['wait-for-device'])
  adb(['install', '-r', 'balance-debug.apk'])
  adb(['shell', 'pm', 'clear', packageName])
  // Permissions that don't exist on an older Android fail harmlessly.
  for (const permission of ['RECORD_AUDIO', 'BLUETOOTH_CONNECT', 'POST_NOTIFICATIONS']) {
    adb(['shell', 'pm', 'grant', packageName, `android.permission.${permission}`], { allowFailure: true })
  }
  adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])
  const evaluate = await connect()
  const has = (selector) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  const click = async (selector) => {
    await waitFor(() => has(selector), selector, 60_000)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  const record = '[aria-label="Record an idea"]'
  const stopInApp = '[aria-label="Stop recording"]'

  await waitFor(async () => !(await has('.database-loading-backdrop')) && await has('.mobile-menu-button'), 'the app to load', 60_000)
  await click('.mobile-menu-button')
  await click('button[data-nav-view="ideas"]')

  // Discarding removes the notification.
  await click(record)
  await waitFor(() => has(stopInApp), 'recording to start', 30_000)
  await waitFor(notification, 'the recording notification')
  console.log(`Audio mode with the default microphone: ${audioMode()}`)
  await click('[aria-label="Discard recording"]')
  await waitFor(() => !notification(), 'the discarded recording to clear its notification')

  // The recording keeps running behind the notification.
  await click(record)
  await waitFor(() => has(stopInApp), 'recording to restart', 30_000)
  await waitFor(notification, 'the recording notification')
  if (!isForeground()) throw new Error('The recording service is not in the foreground')
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
  await waitFor(() => evaluate('document.hidden'), 'the app to leave the screen')
  await sleep(backgroundMs)
  const audio = adb(['shell', 'dumpsys', 'audio']).split('\n').filter((line) => line.includes(packageName) || /silenced/i.test(line))
  console.log(`Audio state while hidden:\n${audio.join('\n')}`)
  if (audio.some((line) => /silenced[:=\s]*true/i.test(line))) throw new Error('Android silenced the microphone in the background')
  if (!isForeground()) throw new Error('The recording service left the foreground')

  sendNotificationStop()
  // The app stays in the background: stopping must save without reopening it.
  const clips = await waitFor(async () => {
    const saved = await readClips(evaluate)
    return saved.length === 1 ? saved : null
  }, 'the clip to be saved in the background', 60_000)
  if (!(await evaluate('document.hidden'))) throw new Error('The app came to the screen while saving')
  if (clips[0].durationMs < backgroundMs) throw new Error(`The clip stopped early: ${clips[0].durationMs} ms`)
  await waitFor(() => !notification(), 'the saved recording to clear its notification')

  adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])
  await waitFor(() => has('.voice-clip-chip'), 'the saved clip on screen')
  console.log(`Saved a ${clips[0].durationMs} ms clip from the notification`)

  // The phone microphone leaves Android out of call mode.
  await click('[aria-label="Phone microphone"]')
  await click(record)
  await waitFor(() => has(stopInApp), 'phone recording to start', 30_000)
  await sleep(3_000)
  const devices = await evaluate(`navigator.mediaDevices.enumerateDevices().then((list) => list.filter((d) => d.kind === 'audioinput').map((d) => d.label))`)
  const mode = audioMode()
  console.log(`Inputs: ${JSON.stringify(devices)}; audio mode with the phone microphone: ${mode}`)
  if (/COMMUNICATION|IN_CALL/.test(mode)) throw new Error(`The phone microphone entered call mode: ${mode}`)

  // Killing the app mid-recording keeps the clip for the next launch.
  await sleep(3_000)
  adb(['shell', 'am', 'force-stop', packageName])
  await waitFor(() => !notification(), 'the killed recording to clear its notification')
  adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])
  const reopened = await connect()
  const recovered = await waitFor(async () => {
    const saved = await readClips(reopened)
    return saved.length === 2 ? saved : null
  }, 'the killed recording to be recovered', 60_000)
  const clip = recovered.find((candidate) => candidate.id !== clips[0].id)
  if (clip.durationMs < 3_000) throw new Error(`The recovered clip is too short: ${clip.durationMs} ms`)
  console.log(`Recovered a ${clip.durationMs} ms clip after the app was killed`)
  process.exit(0)
}

run().catch((error) => {
  console.error(error)
  writeFileSync('voice-recording-notifications.txt', adb(['shell', 'dumpsys', 'notification', '--noredact'], { allowFailure: true }))
  writeFileSync('logcat-voice-recording.txt', adb(['logcat', '-d'], { allowFailure: true }))
  process.exit(1)
})
