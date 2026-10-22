#!/usr/bin/env node
// Same-emulator A/B of workspace loading and resume between two builds. Installs
// alternate so emulator and runner noise affects both builds alike. Every key,
// workspace, and edit belongs to a fresh synthetic installation.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import {
  packageName, adb, sleep, waitFor, appPid, launchApp, connectDevTools,
} from './android-sync-profile-helpers.mjs'
import { historyFixture } from './android-history-fixture.mjs'

assert(process.env.CI && adb(['shell', 'getprop', 'ro.kernel.qemu']).trim() === '1', 'CI emulator only')
const builds = { baseline: 'baseline-debug.apk', candidate: 'balance-debug.apk' }
const rounds = [['baseline', 'candidate'], ['candidate', 'baseline'], ['baseline', 'candidate']]
const rates = [1, 4, 6]
const resumeRates = [1, 6]
const report = { hypothesis: 'Incremental workspace reads must make resume cheaper without slowing complete loads.', runs: [] }
let client

const readyExpression = `Boolean(document.querySelector('.app-shell')) && !document.querySelector('.database-loading-backdrop')`

async function connect() {
  client?.close()
  client = await connectDevTools(await waitFor(appPid, 'Balance process'))
}

async function install(apk) {
  adb(['uninstall', packageName], { allowFailure: true })
  adb(['install', apk])
  // Skip only the debug APK's unrelated scratch benchmarks.
  adb(['shell', 'run-as', packageName, 'mkdir', '-p', 'Balance'])
  adb(['shell', 'run-as', packageName, 'touch', 'Balance/large-sync-profile-complete', 'Balance/android-startup-profile-complete'])
  launchApp()
  await connect()
  await waitFor(() => client.evaluate(`Boolean(document.querySelector('#recovery-key-confirmation')) || (${readyExpression})`), 'first launch', 120000)
  // Never return or log even the generated test key.
  await client.evaluate(`(async () => {
    const status = await window.__TAURI_INTERNALS__.invoke('get_recovery_key_status')
    if (status.confirmed) return
    const input = document.querySelector('#recovery-key-confirmation')
    input.value = status.recoveryKey
    input.dispatchEvent(new Event('input', {bubbles: true}))
    await new Promise(resolve => setTimeout(resolve, 20))
    input.closest('form').requestSubmit()
  })()`)
  await waitFor(() => client.evaluate(readyExpression), 'confirmed first launch', 120000)
  await client.evaluate(`window.__TAURI_INTERNALS__.invoke('initialize_app_state', ${JSON.stringify({ stateJson: JSON.stringify(historyFixture(365)) })})`, 180000)
  // Returning to the app refreshes the workspace only when sync is set up. The
  // relay is unreachable and the radios are off, so every pass stays offline.
  await client.evaluate(`(async () => {
    const pairingCode = await window.__TAURI_INTERNALS__.invoke('sync_new_pairing_code')
    await window.__TAURI_INTERNALS__.invoke('sync_enable_primary', { pairingCode })
    await window.__TAURI_INTERNALS__.invoke('set_sync_relay_url', { relayUrl: 'http://127.0.0.1:9' })
  })()`)
  // Start the measured runs from a process that saw sync configured at launch.
  await coldStart()
}

async function coldStart() {
  adb(['shell', 'am', 'force-stop', packageName])
  await sleep(1000)
  const started = performance.now()
  launchApp()
  await connect()
  await waitFor(() => client.evaluate(readyExpression), 'cold start', 180000, 25)
  return Math.round(performance.now() - started)
}

async function reload(rate) {
  await client.send('Emulation.setCPUThrottlingRate', { rate })
  await client.evaluate('window.__abReloaded = false')
  await client.send('Page.reload')
  const readyMs = await waitFor(() => client.evaluate('window.__abReloaded && window.__abReadyAt'), 'reloaded startup', 180000)
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  return Math.round(readyMs)
}

async function typeIntoFirstTask(text) {
  await client.evaluate(`document.querySelector('.sidebar button[aria-keyshortcuts="Alt+T"]')?.click()`)
  await waitFor(() => client.evaluate(`(() => {
    const editor = [...document.querySelectorAll('[data-plan-text-input-id="lifecycle-item-0"]')].find(el => !el.closest('[hidden], [inert]'))
    if (!editor) return false
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
    return true
  })()`), 'visible synthetic task')
  const started = performance.now()
  await client.send('Input.insertText', { text })
  await client.evaluate('new Promise(resolve => requestAnimationFrame(resolve)).then(() => undefined)')
  return Math.round(performance.now() - started)
}

async function observeLongTasks() {
  await client.evaluate(`(() => {
    window.__abTasks = []
    new PerformanceObserver(list => window.__abTasks.push(...list.getEntries().map(entry => Math.round(entry.duration))))
      .observe({ type: 'longtask' })
  })()`)
}

// Main-thread busy time, including work split into slices too short to count
// as long tasks: the summed lateness of a 20 ms timer. Started after the
// return, because timers do not run in the background.
async function startBusyMeter() {
  await client.evaluate(`(() => {
    clearInterval(window.__abBusyTimer)
    window.__abBusyMs = 0
    let last = performance.now()
    window.__abBusyTimer = setInterval(() => {
      const now = performance.now()
      window.__abBusyMs += Math.max(0, now - last - 20)
      last = now
    }, 20)
  })()`)
}

async function mainThreadCost() {
  const tasks = await client.evaluate('window.__abTasks')
  return { longestTaskMs: Math.max(0, ...tasks), longTaskTotalMs: tasks.reduce((sum, task) => sum + task, 0),
    busyMs: Math.round(await client.evaluate('clearInterval(window.__abBusyTimer), window.__abBusyMs')) }
}

// Edit, leave, and return: the return refreshes a workspace with one changed day.
async function resumeAfterEdit(rate, index) {
  await typeIntoFirstTask(` edit${index}`)
  await sleep(2000) // Let the edit persist before leaving.
  await observeLongTasks()
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
  await sleep(1500)
  await client.send('Emulation.setCPUThrottlingRate', { rate })
  launchApp()
  await startBusyMeter()
  const inputMs = await typeIntoFirstTask(` resume${index}`)
  await sleep(8000)
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  return { inputMs, ...await mainThreadCost() }
}

// Another device's change lands while the app is away (as sync, a widget, or
// Siri would write it); the return must show it.
async function resumeAfterBackgroundChange(rate, index, sequence) {
  const text = `Synthetic background change ${index}`
  await client.evaluate(`document.querySelector('.sidebar button[aria-keyshortcuts="Alt+T"]')?.click()`)
  await client.evaluate(`window.__TAURI_INTERNALS__.invoke('persist_operation', ${JSON.stringify({ operationJson: JSON.stringify({
    id: `ab-background-${index}`, deviceId: 'ab-other-device', sequence, timestamp: new Date().toISOString(),
    type: 'patch_plan_item', payload: { planId: 'lifecycle-plan', itemId: 'lifecycle-item-1', patch: { text, html: text } },
  }) })})`)
  await observeLongTasks()
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
  await sleep(1500)
  await client.send('Emulation.setCPUThrottlingRate', { rate })
  const started = performance.now()
  launchApp()
  await startBusyMeter()
  try {
    await waitFor(() => client.evaluate(`[...document.querySelectorAll('[data-plan-text-input-id="lifecycle-item-1"]')]
      .some(el => el.textContent.includes(${JSON.stringify(text)}))`), 'the background change to appear', 60000, 25)
  } catch (error) {
    const shown = await client.evaluate(`[...document.querySelectorAll('[data-plan-text-input-id="lifecycle-item-1"]')].map(el => el.textContent)`)
    const stored = await client.evaluate(`window.__TAURI_INTERNALS__.invoke('read_app_state').then(raw => JSON.parse(raw).plans
      .find(plan => plan.id === 'lifecycle-plan').items.find(item => item.id === 'lifecycle-item-1').text)`)
    throw new Error(`${error.message}; shown ${JSON.stringify(shown)}, stored ${JSON.stringify(stored)}`)
  }
  const visibleMs = Math.round(performance.now() - started)
  await sleep(6000)
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  return { visibleMs, ...await mainThreadCost() }
}

try {
  adb(['root'])
  adb(['wait-for-device'])
  for (const service of ['wifi', 'data']) adb(['shell', 'svc', service, 'disable'])
  for (const [round, order] of rounds.entries()) {
    for (const build of order) {
      await install(builds[build])
      const run = { round, build, appBuild: await client.evaluate(`window.__TAURI_INTERNALS__.invoke('build_info')`),
        coldStartMs: [], reloadMs: {}, resume: {} }
      await sleep(5000) // Include post-hydration launch maintenance.
      for (let i = 0; i < 3; i++) run.coldStartMs.push(await coldStart())
      await sleep(5000)
      await client.send('Page.enable')
      await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.__abReloaded = true;
        window.__abReadyAt = null;
        const timer = setInterval(() => {
          if (${readyExpression}) { window.__abReadyAt = performance.now(); clearInterval(timer) }
        }, 25);
      ` })
      for (const rate of rates) {
        run.reloadMs[rate] = []
        for (let i = 0; i < 2; i++) {
          run.reloadMs[rate].push(await reload(rate))
          await sleep(4000)
        }
      }
      run.background = {}
      let sequence = 0
      for (const rate of resumeRates) {
        run.resume[rate] = []
        run.background[rate] = []
        for (let i = 0; i < 2; i++) run.resume[rate].push(await resumeAfterEdit(rate, `${rate}-${i}`))
        for (let i = 0; i < 2; i++) run.background[rate].push(await resumeAfterBackgroundChange(rate, `${rate}-${i}`, ++sequence))
      }
      report.runs.push(run)
      console.log(JSON.stringify(run))
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  report.summary = Object.fromEntries(Object.keys(builds).map(build => {
    const runs = report.runs.filter(run => run.build === build)
    return [build, {
      coldStartMs: median(runs.flatMap(run => run.coldStartMs)),
      reloadMs: Object.fromEntries(rates.map(rate => [rate, median(runs.flatMap(run => run.reloadMs[rate]))])),
      resumeLongestTaskMs: Object.fromEntries(resumeRates.map(rate => [rate, median(runs.flatMap(run => run.resume[rate].map(r => r.longestTaskMs)))])),
      resumeLongTaskTotalMs: Object.fromEntries(resumeRates.map(rate => [rate, median(runs.flatMap(run => run.resume[rate].map(r => r.longTaskTotalMs)))])),
      resumeInputMs: Object.fromEntries(resumeRates.map(rate => [rate, median(runs.flatMap(run => run.resume[rate].map(r => r.inputMs)))])),
      resumeBusyMs: Object.fromEntries(resumeRates.map(rate => [rate, median(runs.flatMap(run => run.resume[rate].map(r => r.busyMs)))])),
      backgroundVisibleMs: Object.fromEntries(resumeRates.map(rate => [rate, median(runs.flatMap(run => run.background[rate].map(r => r.visibleMs)))])),
      backgroundLongestTaskMs: Object.fromEntries(resumeRates.map(rate => [rate, median(runs.flatMap(run => run.background[rate].map(r => r.longestTaskMs)))])),
      backgroundBusyMs: Object.fromEntries(resumeRates.map(rate => [rate, median(runs.flatMap(run => run.background[rate].map(r => r.busyMs)))])),
    }]
  }))
  console.log(JSON.stringify(report.summary, null, 2))
} catch (error) {
  report.error = String(error.stack ?? error)
  process.exitCode = 1
} finally {
  for (const service of ['wifi', 'data']) adb(['shell', 'svc', service, 'enable'], { allowFailure: true })
  client?.close()
  await writeFile('android-lifecycle-startup-ab.json', JSON.stringify(report, null, 2))
}
