#!/usr/bin/env node
// Regression gate for native shutdown races during Android activity reclamation.
// All keys, planner contents, and relay traffic belong to this fresh CI fixture.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { createNetworkLossFixture } from './android-network-loss-fixture.mjs'
import {
  packageName, adb, sleep, waitFor, appPid, launchApp, connectDevTools,
  waitForDatabaseReady, syntheticState, forceBackgroundJob,
} from './android-sync-profile-helpers.mjs'

assert(process.env.CI && adb(['shell', 'getprop', 'ro.kernel.qemu']).trim() === '1', 'CI emulator only')
const scenario = process.env.BALANCE_LIFECYCLE_SCENARIO ?? 'activity'
const repeats = Number(process.env.BALANCE_LIFECYCLE_REPEATS ?? 20)
assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 200)
assert(['activity', 'process', 'worker-start'].includes(scenario))
const report = { scenario, cases: [], hypothesis: {
  activity: 'Destroying the last Android activity must exit without native finalizer races and reopen with saved edits intact.',
  process: 'Background process reclamation while offline prevents a fresh native/JS startup.',
  'worker-start': 'WorkManager initializes native state before the first activity, leaving startup blocked when a relay request hangs.',
}[scenario] }
let client, logcat, relay, editNumber = 0, lastDurableText
const stream = createWriteStream('android-lifecycle-logcat.txt')
async function invoke(command, args = {}, timeout = 20000) {
  return client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`, timeout)
}
async function connect() {
  client?.close()
  client = await connectDevTools(await waitFor(appPid, 'Balance process'))
  const state = await waitForDatabaseReady(client)
  assert(!state.failed, 'Database startup failed')
}
async function confirmSyntheticKey() {
  // Never return or log even the generated test key.
  await client.evaluate(`(async () => {
    const status = await window.__TAURI_INTERNALS__.invoke('get_recovery_key_status')
    if (!status.confirmed) {
      const input = document.querySelector('#recovery-key-confirmation')
      if (!input) throw new Error('Synthetic first-run gate missing')
      input.value = status.recoveryKey
      input.dispatchEvent(new Event('input', {bubbles:true}))
      await new Promise(resolve => setTimeout(resolve, 20))
      input.closest('form').requestSubmit()
    }
  })()`)
  await waitFor(() => client.evaluate(`!document.querySelector('#recovery-key-confirmation')`), 'synthetic first-run confirmation')
}
async function responsive() {
  const start = performance.now()
  await client.evaluate(`new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))`, 10000)
  const frameMs = Math.round(performance.now() - start)
  const before = performance.now()
  const state = JSON.parse(await invoke('read_app_state'))
  assert(state.plans.some(plan => plan.items.some(item => item.id === 'lifecycle-item-0')), 'Synthetic fixture survived')
  if (lastDurableText !== undefined) assert.equal(state.plans.find(plan => plan.id === 'lifecycle-plan').items[0].text, lastDurableText, 'Previously acknowledged text must survive')
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
  })()`), 'visible editable synthetic task')
  const marker = ` probe${++editNumber}`
  await client.send('Input.insertText', {text: marker})
  await waitFor(async () => {
    const saved = JSON.parse(await invoke('read_app_state'))
    const text = saved.plans.find(plan => plan.id === 'lifecycle-plan')?.items.find(item => item.id === 'lifecycle-item-0')?.text
    if (!text?.includes(marker)) return false
    lastDurableText = text
    return true
  }, 'real WebView input to persist after lifecycle transition', 10000)
  // Exercise Android's native input dispatch too: JS evaluation alone can miss a blocked main thread.
  adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK'], { timeout: 12000 })
  const nativeAndDbMs = Math.round(performance.now() - before)
  return { frameMs, nativeAndDbMs }
}
function fixture(count = 40) {
  const state = syntheticState()
  const day = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10)
  state.activePlanDate = day
  state.plans = [{ ...state.plans[0], id: 'lifecycle-plan', date: day,
    items: Array.from({ length: count }, (_, i) => ({ ...state.plans[0].items[0],
      id: `lifecycle-item-${i}`, text: `Synthetic lifecycle task ${i}`, html: `Synthetic lifecycle task ${i}`, done: false,
    })) }]
  return state
}
async function seed(count = 40) {
  await invoke('initialize_app_state', { stateJson: JSON.stringify(fixture(count)) }, 120000)
  lastDurableText = undefined
}
async function home() {
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
  await sleep(700)
}
async function radios(offline) {
  for (const service of ['wifi', 'data']) adb(['shell', 'svc', service, offline ? 'disable' : 'enable'])
}
async function evidence(label) {
  for (const what of ['activity', 'window', 'meminfo', 'alarm']) {
    await writeFile(`android-lifecycle-${label}-${what}.txt`, adb(['shell', 'dumpsys', what], {allowFailure:true, maxBuffer: 32*1024*1024}))
  }
}
try {
  adb(['root'])
  adb(['wait-for-device'])
  adb(['install', '-r', 'balance-debug.apk'])
  adb(['shell', 'pm', 'clear', packageName])
  // Skip only the debug APK's two unrelated scratch benchmarks; do not warm up/reload startup.
  adb(['shell', 'run-as', packageName, 'mkdir', '-p', 'Balance'])
  adb(['shell', 'run-as', packageName, 'touch', 'Balance/large-sync-profile-complete', 'Balance/android-startup-profile-complete'])
  adb(['shell', 'pm', 'grant', packageName, 'android.permission.POST_NOTIFICATIONS'], {allowFailure:true})
  adb(['shell', 'appops', 'set', packageName, 'SCHEDULE_EXACT_ALARM', 'allow'], {allowFailure:true})
  adb(['logcat', '-c'])
  logcat = spawn('adb', ['logcat', '-b', 'all', '-v', 'threadtime'], {stdio:['ignore','pipe','pipe']})
  logcat.stdout.pipe(stream)
  launchApp()
  await connect()
  await confirmSyntheticKey()
  await seed()
  const pairingCode = (await readFile('sync-e2e-pairing-code.txt', 'utf8')).trim()
  assert(pairingCode.startsWith('BALSYNC1:'))
  relay = await createNetworkLossFixture()
  await invoke('sync_enable_primary', { pairingCode, relayUrl: relay.relayUrl })
  await invoke('sync_relay_once', {reason: 'lifecycle-baseline'})
  // Seed is visible after a real process launch, with no artificial WebView reload.
  adb(['shell', 'am', 'force-stop', packageName])
  launchApp()
  await connect()
  report.baseline = await responsive()
  await evidence('baseline')
  if (scenario === 'activity' || scenario === 'process') {
    if (scenario === 'activity') adb(['shell', 'settings', 'put', 'global', 'always_finish_activities', '1'])
    for (let i = 0; i < repeats; i++) {
      const beforePid = appPid()
      const offline = i % 2 === 0
      await client.evaluate(`window.__lifecycleSentinel = ${i + 1}`)
      await home()
      if (scenario === 'activity') {
        await waitFor(() => appPid() !== beforePid || adb(['logcat', '-d', '-b', 'events', '-v', 'threadtime'], {maxBuffer:32*1024*1024}).split('\n')
          .some(line => line.includes('wm_on_destroy_called') && line.includes('app.balance.local.MainActivity') && new RegExp(`\\s${beforePid}\\s`).test(line)),
        'Android to actually destroy the background activity', 12000)
      }
      await radios(offline)
      let termination
      if (scenario === 'process') {
        adb(['shell', 'am', 'kill', packageName])
        await sleep(500)
        termination = 'am kill'
        if (appPid() === beforePid) {
          // A bound WorkManager service can make am kill ineligible. Scope fault injection to this test PID.
          adb(['shell', 'kill', '-9', beforePid])
          termination = 'scoped SIGKILL (am kill retained background service)'
        }
        await waitFor(() => appPid() !== beforePid, 'old process termination')
      }
      if (scenario === 'activity' && (i === 0 || i % 10 === 9)) await evidence(`destroyed-${i}`)
      let backgroundJobAfterDestruction
      if (scenario === 'activity' && i % 10 === 9) {
        await waitFor(() => /Active default network: \d+/.test(adb(['shell', 'dumpsys', 'connectivity'])), 'network restoration before background sync', 15000)
        // A restored default network can still reject the first request.
        // Require an actual relay request from the rescheduled job, without
        // reopening the UI or creating replacement work from the foreground.
        const deadline = Date.now() + 45000
        let attempts = 0
        while (!backgroundJobAfterDestruction) {
          attempts++
          try { backgroundJobAfterDestruction = { id: await forceBackgroundJob(relay), attempts } }
          catch (error) {
            if (Date.now() >= deadline) throw error
            await sleep(1000)
          }
        }
      }
      const start = performance.now()
      launchApp()
      await connect()
      const result = { i, offline, termination, backgroundJobAfterDestruction, beforePid, afterPid: appPid(), startupMs: Math.round(performance.now()-start), ...await responsive() }
      result.newJsContext = await client.evaluate(`typeof window.__lifecycleSentinel === 'undefined'`)
      report.cases.push(result)
      console.log(JSON.stringify(result))
      if (scenario === 'activity' && result.afterPid !== beforePid) {
        // Tauri deliberately exits when its last window is destroyed. That is
        // distinguishable from a crash and still requires a healthy relaunch.
        const logs = adb(['logcat', '-d', '-b', 'all', '-v', 'threadtime'], {maxBuffer:32*1024*1024})
        assert(logs.includes(`Process ${beforePid} exited cleanly (0)`), 'Activity destruction must not crash the native process')
        result.nativeTeardownErrors = logs.split('\n').filter(line => line.trim().split(/\s+/)[2] === beforePid && /FORTIFY:|Fatal signal/.test(line))
        assert.equal(result.nativeTeardownErrors.length, 0, 'Native threads accessed destroyed resources during activity teardown')
        result.cleanFrameworkExit = true
      }
      assert(result.newJsContext, 'Fault injection must actually recreate the WebView, not just resume it')
      assert(result.frameMs < 5000 && result.nativeAndDbMs < 5000, 'Resume blocked for at least five seconds')
    }
  } else if (scenario === 'worker-start') {
    for (let i = 0; i < 12; i++) {
      relay.setMode('online')
      await radios(false)
      await home()
      const beforePid = appPid()
      adb(['shell', 'kill', '-9', beforePid])
      await waitFor(() => appPid() !== beforePid, 'old process termination')
      relay.setMode(i % 2 === 0 ? 'silent' : 'reset')
      const job = await forceBackgroundJob(relay)
      const workerPid = appPid()
      assert(workerPid && workerPid !== beforePid, 'Background job must start a fresh process')
      const start = performance.now()
      launchApp()
      await connect()
      const result = {i, job, workerPid, foregroundPid: appPid(), startupMs: Math.round(performance.now()-start), ...await responsive()}
      assert.equal(result.foregroundPid, workerPid)
      report.cases.push(result)
      console.log(JSON.stringify(result))
      relay.setMode('online')
      // The previously stalled request may reject once after the proxy releases
      // it. Require eventual success through the now-healthy relay.
      await waitFor(async () => {
        try { await invoke('sync_relay_once', {reason: 'lifecycle-recovered'}, 30000); return true }
        catch { return false }
      }, 'healthy sync after the injected network failure', 90000, 1000)
    }
  }
  report.completed = true
} catch (error) {
  report.error = String(error.stack ?? error)
  process.exitCode = 1
} finally {
  await evidence('final').catch(() => {})
  const logs = adb(['logcat', '-d'], {allowFailure:true, maxBuffer:32*1024*1024})
  report.failureSignals = logs.split('\n').filter(line => /FATAL EXCEPTION|FORTIFY:|Fatal signal|ANR in |am_anr|chromium.*(crash|killed)|Maximum limit of concurrent alarms|BalanceNotifications.*Could not/.test(line)).slice(-100)
  adb(['shell', 'settings', 'put', 'global', 'always_finish_activities', '0'], {allowFailure:true})
  await radios(false).catch(() => {})
  client?.close()
  await relay?.close()
  logcat?.kill()
  await writeFile('android-lifecycle-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  stream.end()
}
