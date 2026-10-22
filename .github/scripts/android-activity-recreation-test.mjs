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
assert(['activity', 'process', 'worker-start', 'offline-buckets', 'offline-history', 'offline-notifications', 'offline-latency'].includes(scenario))
const report = { scenario, cases: [], hypothesis: {
  activity: 'Destroying the last Android activity must exit without native finalizer races and reopen with saved edits intact.',
  process: 'Background process reclamation while offline prevents a fresh native/JS startup.',
  'offline-buckets': 'An acknowledged bucket Save must survive immediate WebView destruction and offline reopening.',
  'offline-notifications': 'Resuming while native reminders are being registered must not block the Android UI thread.',
  'offline-history': 'Offline startup and resume must remain responsive with a year of synthetic history, including slower WebView CPUs.',
  'offline-latency': 'Saving an idea or a note edit must be as quick offline, or with a hanging relay, as online, including across screen sleep.',
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
async function verifyDurableInput(marker) {
  const start = performance.now()
  await waitFor(async () => {
    const saved = JSON.parse(await invoke('read_app_state'))
    const text = saved.plans.find(plan => plan.id === 'lifecycle-plan')?.items.find(item => item.id === 'lifecycle-item-0')?.text
    if (!text?.includes(marker)) return false
    if (lastDurableText !== undefined) assert(text.startsWith(lastDurableText), 'Earlier acknowledged input must survive')
    lastDurableText = text
    return true
  }, 'real WebView input to persist after lifecycle transition', 10000)
  return Math.round(performance.now() - start)
}
async function responsive({deferDatabaseProbe = false} = {}) {
  const start = performance.now()
  await client.evaluate(`new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))`, 10000)
  const frameMs = Math.round(performance.now() - start)
  const before = performance.now()
  let readMs
  if (!deferDatabaseProbe) {
    const state = JSON.parse(await invoke('read_app_state'))
    readMs = Math.round(performance.now() - before)
    assert(state.plans.some(plan => plan.items.some(item => item.id === 'lifecycle-item-0')), 'Synthetic fixture survived')
    if (lastDurableText !== undefined) assert.equal(state.plans.find(plan => plan.id === 'lifecycle-plan').items[0].text, lastDurableText, 'Previously acknowledged text must survive')
  }
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
  const inputStart = performance.now()
  await client.send('Input.insertText', {text: marker})
  await client.evaluate(`new Promise(resolve => requestAnimationFrame(resolve)).then(() => undefined)`)
  const inputMs = Math.round(performance.now() - inputStart)
  const durableProbeMs = deferDatabaseProbe ? undefined : await verifyDurableInput(marker)
  // Exercise Android's native input dispatch too: JS evaluation alone can miss a blocked main thread.
  adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK'], { timeout: 12000 })
  await sleep(300) // Let the WebView consume Back before opening another dialog.
  const nativeAndDbMs = Math.round(performance.now() - before)
  return { frameMs, inputMs, readMs, durableProbeMs, nativeAndDbMs,
    ...(deferDatabaseProbe ? {marker} : {}) }
}
// Names what changed between native snapshots, never their synthetic content.
function snapshotChanges(before, after) {
  if (before === after) return []
  const a = JSON.parse(before), b = JSON.parse(after), changes = []
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue
    if (Array.isArray(a[key]) && Array.isArray(b[key])) {
      const byId = new Map(a[key].map(item => [item?.id, JSON.stringify(item)]))
      const ids = b[key].filter(item => byId.get(item?.id) !== JSON.stringify(item)).map(item => item?.id)
      changes.push(`${key}: ${a[key].length}->${b[key].length} [${ids.slice(0, 5).join(',')}]`)
    } else if (a[key] && b[key] && typeof a[key] === 'object') {
      changes.push(`${key}: {${Object.keys({...a[key], ...b[key]}).filter(k => JSON.stringify(a[key][k]) !== JSON.stringify(b[key][k])).slice(0, 8).join(',')}}`)
    } else changes.push(`${key}: ${typeof a[key]}->${typeof b[key]}${typeof b[key] === 'string' && b[key].length < 40 ? ` ${a[key]}->${b[key]}` : ''}`)
  }
  return changes
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
// Records every IPC round trip in the page, by command name only.
async function traceIpc() {
  await client.evaluate(`(() => {
    const internals = window.__TAURI_INTERNALS__
    if (window.__ipcTrace) return
    window.__ipcTrace = []
    // Tauri defines invoke as read-only, so shadow it on a derived object.
    window.__TAURI_INTERNALS__ = Object.create(internals, {invoke: {value: (command, ...rest) => {
      const entry = {command, start: Math.round(performance.now())}
      window.__ipcTrace.push(entry)
      if (window.__ipcTrace.length > 400) window.__ipcTrace.shift()
      const settle = ok => { entry.ms = Math.round(performance.now()) - entry.start; entry.ok = ok }
      return internals.invoke(command, ...rest).then(value => { settle(true); return value }, error => { settle(false); throw error })
    }}})
    new PerformanceObserver(list => (window.__longTasks ??= []).push(...list.getEntries().map(e => ({start: Math.round(e.startTime), ms: Math.round(e.duration)}))))
      .observe({type: 'longtask'})
  })()`)
  report.ipcTraced = await client.evaluate(`window.__TAURI_INTERNALS__.invoke('build_info').then(() => window.__ipcTrace.length > 0)`)
}
// Commands which took noticeable time since `since`, plus long JS tasks.
async function slowWork(since) {
  return client.evaluate(`({
    ipc: window.__ipcTrace.filter(e => e.start >= ${since} && (e.ms === undefined || e.ms >= 20)),
    reads: window.__ipcTrace.filter(e => e.start >= ${since} && e.command === 'read_app_state').length,
    longTasks: (window.__longTasks ?? []).filter(e => e.start >= ${since}),
  })`)
}
async function setCondition(condition) {
  relay.setMode({'relay-silent': 'silent', 'relay-reset': 'reset'}[condition] ?? 'online')
  await radios(condition === 'radios-off')
  await waitFor(async () => Boolean(await invoke('get_sync_network_offline')) === (condition === 'radios-off'), `${condition} connectivity`, 30000)
  // Let the connectivity change's own sync pass start, as on a real phone.
  await sleep(1500)
}
// Times Save from submit until the dialog closes, which acknowledges durability.
async function timedQuickAdd(text) {
  await client.evaluate(`document.querySelector('button[aria-label="Add idea"]').click()`)
  await waitFor(() => client.evaluate(`Boolean(document.querySelector('.quick-add-dialog [contenteditable="true"]'))`), 'Quick Add editor')
  return client.evaluate(`(async () => {
    const editor = document.querySelector('.quick-add-dialog [contenteditable="true"]')
    editor.focus()
    document.execCommand('insertText', false, ${JSON.stringify(text)})
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
    const start = performance.now()
    const closed = new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.quick-add-dialog')) { observer.disconnect(); resolve() }
      })
      observer.observe(document.body, {childList: true, subtree: true})
    })
    document.querySelector('.quick-add-dialog').requestSubmit()
    await closed
    return {start: Math.round(start), saveMs: Math.round(performance.now() - start)}
  })()`, 60000)
}
async function openSyntheticNote() {
  await client.evaluate(`document.querySelector('button[data-nav-view="notes"]').click()`)
  await waitFor(() => client.evaluate(`(() => {
    const visible = el => el && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0
    let editor = document.querySelector('section[aria-label="Main note"] [contenteditable="true"]')
    if (!visible(editor)) { document.querySelector('.note-card')?.click(); return false }
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
    return true
  })()`), 'visible synthetic note editor')
}
async function screenOff() {
  adb(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP'])
  await waitFor(() => /mWakefulness=Asleep|mWakefulness=Dozing/.test(adb(['shell', 'dumpsys', 'power'])), 'screen off', 10000)
}
async function screenOn() {
  adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
  adb(['shell', 'wm', 'dismiss-keyguard'], {allowFailure: true})
}
// A year of synthetic history approximates a long-used workspace.
function historyFixture(days) {
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
    await sleep(3000) // Measure resume, not post-hydration launch sync and maintenance.
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
      const state = historyFixture(days)
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
      for (const rate of [1, 4, 6]) {
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
        const hydratedSnapshot = await invoke('read_app_state', {}, 60000)
        await sleep(3000)
        const profile = (await client.send('Profiler.stop')).profile
        await writeFile(`android-lifecycle-history-${days}-cpu${rate}.cpuprofile`, JSON.stringify(profile))
        const scriptUrls = [...new Set(profile.nodes.map(node => node.callFrame.url).filter(url => url.includes('/assets/')))]
        // Profiler script IDs can outlive their Debugger IDs after reload.
        // Fetch the executed URLs; diagnostic collection must not abort a case.
        const sources = await client.evaluate(`Promise.all(${JSON.stringify(scriptUrls)}.map(async url => {
          try { return {url, source: await (await fetch(url)).text()} }
          catch { return {url, unavailable: true} }
        }))`)
        await writeFile('android-lifecycle-script-sources.json', JSON.stringify(sources))
        const startup = await client.evaluate('({readyMs: window.__startupReadyAt, tasks: window.__startupTasks})')
        const result = {days, rate, phase: 'reload', ...startup, ...await responsive()}
        report.cases.push(result)
        console.log(JSON.stringify(result))
        await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier})
        // Offline focus/resume currently rereads and normalizes the workspace.
        const beforeResumeSnapshot = await invoke('read_app_state', {}, 60000)
        await sleep(1000)
        await client.evaluate('window.__startupTasks = []')
        await home()
        await client.send('Profiler.start')
        const resumed = performance.now()
        launchApp()
        // Probe actual input immediately. Full synthetic database inspections
        // add large IPC responses of their own, so perform them after timing.
        const {marker, ...interaction} = await responsive({deferDatabaseProbe: true})
        const elapsedMs = Math.round(performance.now() - resumed)
        await sleep(10000)
        await writeFile(`android-lifecycle-history-${days}-cpu${rate}-resume.cpuprofile`,
          JSON.stringify((await client.send('Profiler.stop')).profile))
        const resume = {days, rate, phase: 'resume', elapsedMs,
          ...interaction, tasks: await client.evaluate('window.__startupTasks'),
          snapshotChangesBeforeResume: snapshotChanges(hydratedSnapshot, beforeResumeSnapshot),
          snapshotChangesAfterResume: snapshotChanges(beforeResumeSnapshot, await invoke('read_app_state', {}, 60000))}
        resume.durableProbeMs = await verifyDurableInput(marker)
        report.cases.push(resume)
        console.log(JSON.stringify(resume))
      }
      await client.send('Emulation.setCPUThrottlingRate', {rate: 1})
    }
    assert(report.cases.filter(result => result.phase === 'resume')
      .every(result => result.inputMs < 1000 && result.tasks.every(task => task.duration < 1000)),
    'Offline resume blocked the WebView for at least one second with unchanged synthetic history')
  } else if (scenario === 'offline-latency') {
    // A long-used workspace, so per-save costs which scale with history show.
    await invoke('initialize_app_state', {stateJson: JSON.stringify(historyFixture(365))}, 120000)
    lastDurableText = undefined
    adb(['shell', 'locksettings', 'set-disabled', 'true'], {allowFailure: true})
    adb(['shell', 'am', 'force-stop', packageName])
    launchApp()
    await connect()
    await sleep(5000) // Measure steady use, not launch sync and maintenance.
    await traceIpc()
    const saved = []
    for (const condition of ['online', 'radios-off', 'relay-silent', 'relay-reset', 'online']) {
      await setCondition(condition)
      for (let i = 0; i < 6; i++) {
        const text = `Synthetic latency idea ${condition} ${saved.length}`
        const result = await timedQuickAdd(text)
        saved.push(text)
        const entry = {phase: 'quick-add', condition, i, saveMs: result.saveMs, ...await slowWork(result.start)}
        report.cases.push(entry)
        console.log(JSON.stringify(entry))
        await sleep(i % 2 ? 300 : 2500) // Both rapid saves and saves between sync polls.
      }
      await openSyntheticNote()
      // Phone WebViews run JavaScript several times slower than CI hosts.
      await client.send('Emulation.setCPUThrottlingRate', {rate: 6})
      for (let i = 0; i < 3; i++) {
        await client.send('Input.insertText', {text: ` sleep${++editNumber}`})
        const before = await client.evaluate('Math.round(performance.now())')
        await screenOff()
        await sleep(4000)
        const woke = performance.now()
        await screenOn()
        // Frame and native-input latency after waking, then a real edit.
        await client.evaluate(`new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))`, 30000)
        const frameMs = Math.round(performance.now() - woke)
        const inputStart = performance.now()
        await client.send('Input.insertText', {text: ` woke${editNumber}`})
        await client.evaluate(`new Promise(resolve => requestAnimationFrame(resolve)).then(() => undefined)`, 30000)
        const inputMs = Math.round(performance.now() - inputStart)
        await sleep(3000)
        const entry = {phase: 'note-sleep', condition, i, frameMs, inputMs, ...await slowWork(before)}
        report.cases.push(entry)
        console.log(JSON.stringify(entry))
      }
      // Waking the phone to jot down an idea right after editing a note.
      for (let i = 0; i < 2; i++) {
        await openSyntheticNote()
        await client.send('Input.insertText', {text: ` idea${++editNumber}`})
        await screenOff()
        await sleep(4000)
        await screenOn()
        const text = `Synthetic wake idea ${condition} ${saved.length}`
        const woke = performance.now()
        const result = await timedQuickAdd(text)
        saved.push(text)
        const entry = {phase: 'wake-quick-add', condition, i, saveMs: result.saveMs,
          wakeToSavedMs: Math.round(performance.now() - woke), ...await slowWork(result.start - 10000)}
        report.cases.push(entry)
        console.log(JSON.stringify(entry))
      }
      await client.send('Emulation.setCPUThrottlingRate', {rate: 1})
      await client.evaluate(`document.querySelector('.sidebar button[aria-keyshortcuts="Alt+T"]')?.click()`)
    }
    await setCondition('online')
    const final = JSON.parse(await invoke('read_app_state', {}, 60000))
    for (const idea of saved) assert(final.ideaBuckets.some(bucket => bucket.items.some(item => item.text === idea)), `Lost ${idea}`)
    report.freezeDiagnostics = await invoke('export_freeze_diagnostics', {}, 60000).catch(error => String(error))
    const summary = {}
    for (const entry of report.cases) {
      const key = `${entry.phase}/${entry.condition}`
      const value = entry.wakeToSavedMs ?? entry.saveMs ?? Math.max(entry.frameMs, entry.inputMs, ...entry.longTasks.map(task => task.ms))
      ;(summary[key] ??= []).push(value)
    }
    report.summary = summary
    console.log(JSON.stringify(summary))
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
