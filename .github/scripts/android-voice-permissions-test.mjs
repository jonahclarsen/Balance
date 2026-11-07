#!/usr/bin/env node
// Starts voice recording the way a person does on a fresh install: a real tap
// on Record, then Android's permission prompts answered on screen, rather than
// permissions granted ahead of time. Each case checks the app is still alive.

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const packageName = process.env.BALANCE_TEST_PACKAGE ?? 'app.balance.local'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function adb(args, { allowFailure = false, timeout = 30_000 } = {}) {
  const result = spawnSync('adb', args, { encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 })
  if (result.error && !allowFailure) throw result.error
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

const pid = () => adb(['shell', 'pidof', packageName], { allowFailure: true }).trim().split(/\s+/)[0] || null

async function connect() {
  const appPid = await waitFor(pid, 'the app process', 60_000)
  const socketName = await waitFor(() => adb(['shell', 'cat', '/proc/net/unix']).match(new RegExp(`@(webview_devtools_remote_${appPid})\\s*$`, 'm'))?.[1], 'the DevTools socket', 60_000)
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
  socket.addEventListener('close', () => { for (const resolve of pending.values()) resolve({ error: 'closed' }) })
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

// A real touch, so the tap counts as a user gesture.
async function tap(evaluate, selector) {
  const point = await waitFor(() => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: Math.round((rect.left + rect.width / 2) * devicePixelRatio), y: Math.round((rect.top + rect.height / 2) * devicePixelRatio) }
  })()`), selector, 60_000)
  adb(['shell', 'input', 'tap', String(point.x), String(point.y)])
}

const PROMPT_BUTTONS = {
  allow: ['permission_allow_foreground_only_button', 'permission_allow_button'],
  once: ['permission_allow_one_time_button', 'permission_allow_foreground_only_button', 'permission_allow_button'],
  deny: ['permission_deny_and_dont_ask_again_button', 'permission_deny_button'],
}

// Answers every permission prompt that appears within the window.
async function answerPrompts(answer, windowMs = 15_000) {
  const answered = []
  const deadline = Date.now() + windowMs
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    adb(['shell', 'uiautomator', 'dump', '--compressed', '/sdcard/voice-window.xml'], { allowFailure: true, timeout: 10_000 })
    const xml = adb(['shell', 'cat', '/sdcard/voice-window.xml'], { allowFailure: true })
    const message = xml.match(/resource-id="com\.android\.permissioncontroller:id\/permission_message"[^>]*/)?.[0]?.match(/text="([^"]*)"/)?.[1]
    let tapped = false
    for (const id of PROMPT_BUTTONS[answer]) {
      const node = xml.match(new RegExp(`<node[^>]*resource-id="com\\.android\\.permissioncontroller:id/${id}"[^>]*>`))?.[0]
      const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
      if (!bounds || /visibility="gone"|enabled="false"/.test(node)) continue
      const [x1, y1, x2, y2] = bounds.slice(1).map(Number)
      adb(['shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1)])
      answered.push(`${answer}: ${message ?? id}`)
      tapped = true
      quietSince = Date.now()
      break
    }
    if (!tapped && answered.length > 0 && Date.now() - quietSince > 4_000) break
    await sleep(500)
  }
  return answered
}

function crashLog() {
  const crash = adb(['logcat', '-b', 'crash', '-d'], { allowFailure: true }).trim()
  const fatal = adb(['logcat', '-d'], { allowFailure: true }).split('\n')
    .filter((line) => /FATAL|AndroidRuntime|Render process|renderer.*(crash|gone|killed)|SIGSEGV|SIGABRT|Abort message|lowmemorykiller|ANR in/i.test(line))
  return [crash, ...fatal].filter(Boolean).join('\n')
}

const results = []

async function runCase(name, { answer, grant = [], record = 4_000, after }) {
  console.log(`\n== ${name}`)
  adb(['shell', 'am', 'force-stop', packageName])
  adb(['shell', 'pm', 'clear', packageName])
  for (const permission of ['RECORD_AUDIO', 'BLUETOOTH_CONNECT', 'POST_NOTIFICATIONS']) {
    adb(['shell', 'pm', 'revoke', packageName, `android.permission.${permission}`], { allowFailure: true })
    adb(['shell', 'pm', 'clear-permission-flags', packageName, `android.permission.${permission}`, 'user-set', 'user-fixed'], { allowFailure: true })
  }
  for (const permission of grant) adb(['shell', 'pm', 'grant', packageName, `android.permission.${permission}`], { allowFailure: true })
  adb(['logcat', '-c'])
  adb(['logcat', '-b', 'crash', '-c'], { allowFailure: true })
  adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])
  const evaluate = await connect()
  const startPid = pid()
  const has = (selector) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  await waitFor(async () => !(await has('.database-loading-backdrop')) && await has('.mobile-menu-button'), 'the app to load', 60_000)
  await tap(evaluate, '.mobile-menu-button')
  await sleep(800)
  await tap(evaluate, 'button[data-nav-view="ideas"]')
  await sleep(800)
  await tap(evaluate, '[aria-label="Record an idea"]')
  const answered = await answerPrompts(answer)
  console.log(`Prompts: ${JSON.stringify(answered)}`)
  let outcome = 'alive'
  let detail = ''
  try {
    await sleep(record)
    const current = pid()
    if (current !== startPid) throw new Error(`process changed from ${startPid} to ${current}`)
    const reopened = await connect()
    detail = await reopened(`JSON.stringify({ recording: Boolean(document.querySelector('[aria-label="Stop recording"]')), error: document.querySelector('.voice-idea-error')?.textContent ?? null })`)
    if (after) await after(reopened)
    await sleep(2_000)
    if (pid() !== startPid) throw new Error('process died after the case')
  } catch (error) {
    outcome = 'CRASHED'
    detail = String(error)
  }
  const log = crashLog()
  if (log) outcome = outcome === 'alive' ? 'alive (with crash log)' : outcome
  results.push({ name, outcome, detail, answered })
  console.log(`Outcome: ${outcome} ${detail}`)
  if (log) {
    console.log(log)
    writeFileSync(`voice-crash-${name.replace(/\W+/g, '-')}.txt`, `${log}\n\n${adb(['logcat', '-d'], { allowFailure: true })}`)
  }
}

const stopInApp = async (evaluate) => {
  const hasStop = await evaluate(`Boolean(document.querySelector('[aria-label="Stop recording"]'))`)
  if (hasStop) await tap(evaluate, '[aria-label="Stop recording"]')
  await sleep(3_000)
}

async function run() {
  adb(['wait-for-device'])
  adb(['install', '-r', 'balance-debug.apk'])
  console.log(`Android ${adb(['shell', 'getprop', 'ro.build.version.release']).trim()}, WebView ${adb(['shell', 'dumpsys', 'package', 'com.google.android.webview']).match(/versionName=(\S+)/)?.[1] ?? 'unknown'}`)

  await runCase('fresh install, allow every prompt, stop in app', { answer: 'allow', after: stopInApp })
  await runCase('fresh install, allow only this time', { answer: 'once', after: stopInApp })
  await runCase('fresh install, deny every prompt', { answer: 'deny' })
  await runCase('microphone granted earlier, allow the rest', { answer: 'allow', grant: ['RECORD_AUDIO'], after: stopInApp })
  await runCase('everything granted earlier', { answer: 'allow', grant: ['RECORD_AUDIO', 'BLUETOOTH_CONNECT', 'POST_NOTIFICATIONS'], after: stopInApp })
  await runCase('fresh install, allow, then leave the app', {
    answer: 'allow',
    after: async (evaluate) => {
      adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
      await sleep(8_000)
      adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])
      await sleep(3_000)
      await stopInApp(await connect())
    },
  })
  await runCase('fresh install, allow, rotate while recording', {
    answer: 'allow',
    after: async () => {
      adb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'])
      adb(['shell', 'settings', 'put', 'system', 'user_rotation', '1'])
      await sleep(4_000)
      adb(['shell', 'settings', 'put', 'system', 'user_rotation', '0'])
      await sleep(4_000)
      await stopInApp(await connect())
    },
  })

  console.log('\n== Summary')
  for (const result of results) console.log(`${result.outcome.padEnd(24)} ${result.name}  ${result.detail}`)
  process.exit(results.some((result) => result.outcome !== 'alive') ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  writeFileSync('voice-crash-harness.txt', adb(['logcat', '-d'], { allowFailure: true }))
  process.exit(1)
})
