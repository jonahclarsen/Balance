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
const offlineBackgroundSeconds = Number(process.env.BALANCE_OFFLINE_BACKGROUND_SECONDS ?? 0)
assert([0, 600].includes(offlineBackgroundSeconds))
assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 200)
assert(['activity', 'process', 'worker-start', 'offline-buckets', 'offline-history', 'offline-notifications'].includes(scenario))
const report = { scenario, cases: [], hypothesis: {
  activity: 'Destroying the last Android activity must exit without native finalizer races and reopen with saved edits intact.',
  process: 'Background process reclamation while offline prevents a fresh native/JS startup.',
  'offline-buckets': 'An acknowledged bucket Save must survive immediate WebView destruction and offline reopening.',
  'offline-notifications': 'Resuming while native reminders are being registered must not block the Android UI thread.',
  'offline-history': 'Offline startup and resume must remain responsive with a year of synthetic history, including slower WebView CPUs.',
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
  await sleep(300) // Let the WebView consume Back before opening another dialog.
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
  report.appBuild = await invoke('build_info')
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
  } else if (scenario === 'offline-buckets') {
    await radios(true)
    await waitFor(() => invoke('get_sync_network_offline'), 'OS offline')
    const expected = []
    for (let i = 0; i < repeats; i++) {
      const text = `Synthetic offline bucket idea ${i}`
      await client.evaluate(`document.querySelector('button[aria-label="Add idea"]').click()`)
      await waitFor(() => client.evaluate(`Boolean(document.querySelector('.quick-add-dialog [contenteditable="true"]'))`), 'Quick Add editor')
      await client.evaluate(`(() => {
        const editor = document.querySelector('.quick-add-dialog [contenteditable="true"]')
        editor.focus()
        document.execCommand('insertText', false, ${JSON.stringify(text)})
      })()`)
      // Pause JS at the exact Save acknowledgement. Killing the synthetic
      // process while paused models Android reclamation without letting adb
      // latency or reload's pagehide event rescue an unsubmitted debounce.
      await client.send('Debugger.enable')
      const paused = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Save was never acknowledged')), 20000)
        const listener = event => {
          const message = JSON.parse(String(event.data))
          if (message.method !== 'Debugger.paused') return
          clearTimeout(timer)
          client.socket.removeEventListener('message', listener)
          resolve()
        }
        client.socket.addEventListener('message', listener)
      })
      await Promise.all([paused, client.evaluate(`(() => {
        const observer = new MutationObserver(() => {
          if (!document.querySelector('.quick-add-dialog')) {
            observer.disconnect()
            debugger
          }
        })
        observer.observe(document.body, {childList: true, subtree: true})
        setTimeout(() => document.querySelector('.quick-add-dialog').requestSubmit(), 0)
        return true
      })()`)])
      const beforePid = appPid()
      adb(['shell', 'kill', '-9', beforePid])
      await waitFor(() => appPid() !== beforePid, 'synthetic process termination')
      expected.push(text)
      const start = performance.now()
      launchApp()
      await connect()
      const reopened = JSON.parse(await invoke('read_app_state'))
      for (const idea of expected) assert(reopened.ideaBuckets.some(bucket => bucket.items.some(item => item.text === idea)), `Acknowledged offline Save lost after process death: ${idea}`)
      const result = {i, offline: true, savedIdeas: expected.length, startupMs: Math.round(performance.now() - start), ...await responsive()}
      report.cases.push(result)
      console.log(JSON.stringify(result))
      assert(result.frameMs < 2000 && result.nativeAndDbMs < 5000, 'Offline reopening froze editing')
    }
    if (offlineBackgroundSeconds) {
      await home()
      await sleep(offlineBackgroundSeconds * 1000)
      const start = performance.now()
      launchApp()
      await connect()
      assert(await invoke('get_sync_network_offline'), 'Ten-minute fixture must remain offline')
      const saved = JSON.parse(await invoke('read_app_state'))
      for (const idea of expected) assert(saved.ideaBuckets.some(bucket => bucket.items.some(item => item.text === idea)), `Ten-minute offline resume lost ${idea}`)
      report.offlineBackground = {seconds: offlineBackgroundSeconds, savedIdeas: expected.length,
        resumeMs: Math.round(performance.now() - start), ...await responsive()}
      assert(report.offlineBackground.frameMs < 2000 && report.offlineBackground.nativeAndDbMs < 5000, 'Ten-minute offline resume froze editing')
    }
  } else if (scenario === 'offline-notifications') {
    await radios(true)
    await waitFor(() => invoke('get_sync_network_offline'), 'OS offline')
    const state = fixture()
    const future = {...state.plans[0], id: 'notification-future-plan',
      date: new Date(Date.parse(state.plans[0].date) + 86400000).toISOString().slice(0, 10),
      items: fixture(160).plans[0].items.map(item => ({...item, id: `future-${item.id}`}))}
    state.plans.push(future)
    state.taskNotifications = state.plans.flatMap(plan => plan.items.map((item, i) => ({
      id: `synthetic-reminder-${item.id}`, sourceKind: 'plan', sourceId: plan.id, itemId: item.id,
      at: Date.now() + (i + 60) * 60000, text: item.text,
    })))
    await invoke('initialize_app_state', {stateJson: JSON.stringify(state)}, 120000)
    lastDurableText = undefined
    adb(['shell', 'am', 'force-stop', packageName])
    launchApp()
    await connect()
    for (let i = 0; i < repeats; i++) {
      // read_app_state republishes native reminders. Start a burst, then resume
      // while a real native scheduling pass may hold its monitor.
      await client.evaluate(`void (window.__notificationReads = Promise.all(Array.from({length: 4}, () => window.__TAURI_INTERNALS__.invoke('read_app_state'))).then(() => true))`)
      await home()
      const start = performance.now()
      launchApp()
      const launchedMs = Math.round(performance.now() - start)
      const result = {i, launchedMs, ...await responsive()}
      report.cases.push(result)
      console.log(JSON.stringify(result))
      await client.evaluate('window.__notificationReads')
    }
    const alarms = adb(['shell', 'dumpsys', 'alarm'], {maxBuffer: 32*1024*1024})
    report.registeredSyntheticReminders = (alarms.match(/tag=\*walarm\*:app\.balance\.local\.SUNSET_TASK/g) ?? []).length
    assert(report.registeredSyntheticReminders >= 200, 'Exercise actual scheduled reminders')
    assert(report.cases.every(result => result.launchedMs < 5000 && result.nativeAndDbMs < 5000), 'Native resume blocked for at least five seconds with reminders')
  } else if (scenario === 'offline-history') {
    await radios(true)
    await waitFor(() => invoke('get_sync_network_offline'), 'OS offline')
    for (const days of [30, 365]) {
      const state = fixture()
      const today = state.plans[0]
      for (let day = 1; day <= days; day++) {
        state.plans.push({...today, id: `history-plan-${day}`,
          date: new Date(Date.parse(today.date) - day * 86400000).toISOString().slice(0, 10),
          items: Array.from({length: 20}, (_, i) => ({...today.items[0],
            id: `history-item-${day}-${i}`, text: `Synthetic historical task ${day} ${i}`,
            html: `Synthetic <strong>historical</strong> task ${day} ${i}`, done: i % 3 === 0,
          })),
        })
      }
      state.listTemplates = [{id: 'history-list-template', name: 'Synthetic routine',
        maxExpectedWords: 0, archivedItems: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        items: today.items.map(item => ({...item, probability: 100})),
      }]
      state.lists = state.plans.map((plan, day) => ({id: `history-list-${day}`, date: plan.date,
        listTemplateId: 'history-list-template', createdAt: new Date().toISOString(),
        items: today.items.map((item, i) => ({...item, id: `history-list-item-${day}-${i}`,
          text: `Synthetic daily routine ${i}`, html: `Synthetic <em>daily routine</em> ${i}`})),
      }))
      state.ideaBuckets = [{id: 'history-bucket', kind: 'proposition', items:
        Array.from({length: 100}, (_, i) => ({...today.items[0], id: `history-idea-${i}`,
          text: `Synthetic saved idea ${i}`, html: `Synthetic saved idea ${i}`}))}]
      state.notes = Array.from({length: 50}, (_, i) => ({id: `history-note-${i}`,
        title: `Synthetic note ${i}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        items: Array.from({length: 20}, (_, j) => ({id: `history-note-${i}-${j}`, kind: 'paragraph',
          text: 'Synthetic paragraph for startup testing.', html: 'Synthetic paragraph for <em>startup testing</em>.', children: []})),
      }))
      await invoke('initialize_app_state', {stateJson: JSON.stringify(state)}, 120000)
      lastDurableText = undefined
      adb(['shell', 'am', 'force-stop', packageName])
      const coldStart = performance.now()
      launchApp()
      client?.close()
      client = await connectDevTools(await waitFor(appPid, 'Balance process'))
      await client.send('Profiler.enable')
      await client.send('Profiler.start')
      await waitForDatabaseReady(client)
      const coldReadyMs = Math.round(performance.now() - coldStart)
      await sleep(3000) // Include post-hydration launch sync and maintenance.
      await writeFile(`android-lifecycle-history-${days}-cold.cpuprofile`, JSON.stringify((await client.send('Profiler.stop')).profile))
      report.cases.push({days, phase: 'cold', readyMs: coldReadyMs, ...await responsive()})
      // Reload only for controlled CPU comparisons; the cold launch above is
      // separately measured and the resume below keeps the actual activity.
      for (const rate of [1, 4]) {
        await client.send('Emulation.setCPUThrottlingRate', {rate})
        await client.send('Page.enable')
        const {identifier} = await client.send('Page.addScriptToEvaluateOnNewDocument', {source: `
          window.__startupProfile = '${days}-${rate}';
          window.__startupTasks = [];
          new PerformanceObserver(list => window.__startupTasks.push(...list.getEntries().map(e => ({start: e.startTime, duration: e.duration}))))
            .observe({type: 'longtask', buffered: true});
          window.__startupReadyAt = null;
          const timer = setInterval(() => {
            if (document.querySelector('.app-shell') && !document.querySelector('.database-loading-backdrop')) {
              window.__startupReadyAt = performance.now(); clearInterval(timer);
            }
          }, 25);
        `})
        await client.send('Profiler.start')
        await client.send('Page.reload')
        await waitFor(() => client.evaluate(`window.__startupProfile === '${days}-${rate}' && window.__startupReadyAt`), 'instrumented startup', 120000)
        await sleep(3000)
        const profile = (await client.send('Profiler.stop')).profile
        await writeFile(`android-lifecycle-history-${days}-cpu${rate}.cpuprofile`, JSON.stringify(profile))
        const scripts = [...new Map(profile.nodes.filter(node => node.callFrame.url.includes('/assets/'))
          .map(node => [node.callFrame.scriptId, node.callFrame.url])).entries()]
        const sources = []
        await client.send('Debugger.enable')
        for (const [scriptId, url] of scripts) {
          const {scriptSource} = await client.send('Debugger.getScriptSource', {scriptId})
          sources.push({url, source: scriptSource})
        }
        await client.send('Debugger.disable')
        await writeFile('android-lifecycle-script-sources.json', JSON.stringify(sources))
        const startup = await client.evaluate('({readyMs: window.__startupReadyAt, tasks: window.__startupTasks})')
        const result = {days, rate, phase: 'reload', ...startup, ...await responsive()}
        report.cases.push(result)
        console.log(JSON.stringify(result))
        await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier})
        // Offline focus/resume currently rereads and normalizes the workspace.
        await client.evaluate('window.__startupTasks = []')
        await home()
        const resumed = performance.now()
        launchApp()
        await sleep(3000)
        const resume = {days, rate, phase: 'resume', elapsedMs: Math.round(performance.now()-resumed),
          ...await responsive(), tasks: await client.evaluate('window.__startupTasks')}
        report.cases.push(resume)
        console.log(JSON.stringify(resume))
      }
      await client.send('Emulation.setCPUThrottlingRate', {rate: 1})
    }
    assert(report.cases.every(result => (result.tasks ?? []).every(task => task.duration < 5000)), 'WebView blocked for at least five seconds with synthetic history')
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
