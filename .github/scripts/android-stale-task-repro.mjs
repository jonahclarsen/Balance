#!/usr/bin/env node
// Diagnostic only: real WebView input + native encrypted relay reconciliation.
// A successful run reports whether loss occurred; it does not assert that loss
// is desirable. The ordinary catch-up control must preserve the task.
import http from 'node:http'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import {
  packageName, sleep, adb, waitFor, appPid, launchApp, connectDevTools,
  waitForDatabaseReady, syntheticState,
} from './android-sync-profile-helpers.mjs'

if (!process.env.CI) throw new Error('This reproduction runs only against the CI emulator.')
// Reuse the existing catch-up profiler's permanent ports; these run sequentially.
const relayPort = 8791
const proxyPort = 8790
const relaySecret = randomBytes(24).toString('base64url')
const relayUrl = `http://127.0.0.1:${proxyPort}/${relaySecret}/`
const backlogCount = 66
const report = { backlogCount, scenarios: [] }
const relayLog = []
let client
let manifestLimit = Infinity
let offline = false
const proxy = http.createServer((request, response) => {
  if (offline) {
    response.writeHead(503)
    response.end('Synthetic offline interval')
    return
  }
  const upstream = http.request({
    hostname: '127.0.0.1', port: relayPort, path: request.url,
    method: request.method, headers: request.headers,
  }, (incoming) => {
    if (request.url?.includes('/v3/manifest') && incoming.statusCode === 200) {
      let body = ''
      incoming.on('data', (chunk) => { body += chunk })
      incoming.on('end', () => {
        const manifest = JSON.parse(body)
        manifest.latestSequence = Math.min(manifest.latestSequence, manifestLimit)
        manifest.batches = manifest.batches.filter((batch) => batch.sequence <= manifestLimit)
        // Preserve distinct incremental batches throughout this diagnostic.
        manifest.compactRecommended = false
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(manifest))
      })
    } else {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers)
      incoming.pipe(response)
    }
  })
  upstream.on('error', (error) => { response.writeHead(502); response.end(error.message) })
  request.pipe(upstream)
})
const relay = spawn(process.execPath, ['scripts/relay-server.mjs', String(relayPort)], {
  env: { ...process.env, BALANCE_RELAY_SECRET: relaySecret }, stdio: ['ignore', 'pipe', 'pipe'],
})
relay.stdout.on('data', (chunk) => relayLog.push(String(chunk)))
relay.stderr.on('data', (chunk) => relayLog.push(String(chunk)))

async function invoke(command, args = {}) {
  return client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`)
}
async function readState() { return JSON.parse(await invoke('read_app_state')) }
async function manifest() {
  const response = await fetch(`http://127.0.0.1:${relayPort}/${relaySecret}/v3/manifest`)
  assert(response.ok)
  return response.json()
}
async function reload() {
  await client.evaluate(`(() => {
    localStorage.setItem('balance:activePlanDate', '2026-01-01')
    setTimeout(() => location.reload(), 0)
    return true
  })()`)
  await sleep(500)
  client.close()
  client = await connectDevTools(await waitFor(appPid, 'the synthetic app'))
  const ready = await waitForDatabaseReady(client)
  assert(!ready.failed, 'Synthetic database failed to open')
}
async function resetJoiner(pairingCode) {
  client?.close()
  client = undefined
  adb(['shell', 'pm', 'clear', packageName])
  await waitFor(() => !appPid(), 'the previous synthetic process to stop')
  adb(['shell', 'run-as', packageName, 'mkdir', '-p', 'Balance'])
  adb(['shell', 'run-as', packageName, 'touch',
    'Balance/large-sync-profile-complete', 'Balance/android-startup-profile-complete'])
  launchApp()
  client = await connectDevTools(await waitFor(appPid, 'the isolated joining process'))
  assert(!(await waitForDatabaseReady(client)).failed)
  await invoke('sync_enable_joiner', { pairingCode })
  await invoke('set_sync_relay_url', { relayUrl })
  await invoke('sync_relay_once', { reason: 'stale-task-baseline' })
  const baseline = await readState()
  assert.equal(baseline.plans.find((plan) => plan.id === 'catchup-plan-0')?.items.length, 20)
  offline = true
  await reload()
  await waitFor(() => client.evaluate(`Boolean(document.querySelector('.day-pane .add-row'))`), 'the existing synthetic day')
}
async function typeTask(text) {
  const count = await client.evaluate(`document.querySelectorAll('[data-plan-text-input]').length`)
  await client.evaluate(`document.querySelector('.day-pane .add-row').click()`)
  await waitFor(() => client.evaluate(`document.querySelectorAll('[data-plan-text-input]').length === ${count + 1}`), 'the new bottom task')
  await client.evaluate(`(() => {
    const editors = document.querySelectorAll('[data-plan-text-input]')
    const editor = editors[editors.length - 1]
    editor.scrollIntoView({ block: 'center' })
    editor.focus()
  })()`)
  await client.send('Input.insertText', { text })
  const state = await waitFor(async () => {
    const state = await readState()
    const task = state.plans.find((plan) => plan.id === 'catchup-plan-0')?.items.at(-1)
    return task?.text === text ? state : null
  }, 'the typed task to be durable before reconnecting', 60_000)
  const task = state.plans.find((plan) => plan.id === 'catchup-plan-0').items.at(-1)
  assert(await visible(text), 'Task must be visible before catch-up')
  return task
}
async function visible(text) {
  return client.evaluate(`[...document.querySelectorAll('[data-plan-text-input]')].some((editor) => editor.textContent === ${JSON.stringify(text)})`)
}
async function runScenario(name, limit, pairingCode) {
  console.log(`[stale-task-repro] ${name}: bootstrap a stale device, then type at the bottom of the day`)
  offline = false
  manifestLimit = 1
  await resetJoiner(pairingCode)
  const text = `Synthetic unsynced bottom task ${name}`
  const task = await typeTask(text)
  // Observe the production scheduler without replacing its implementation.
  await client.evaluate(`(() => {
    const original = window.__TAURI_INTERNALS__.invoke
    window.reproSyncPasses = []
    window.reproRefreshes = 0
    window.__TAURI_INTERNALS__.invoke = async function(command, ...args) {
      const result = await original.call(this, command, ...args)
      if (command === 'sync_relay_once') window.reproSyncPasses.push(result)
      if (command === 'read_app_state' && window.reproSyncPasses.length) window.reproRefreshes++
      return result
    }
  })()`)
  manifestLimit = limit
  offline = false
  await client.evaluate(`window.dispatchEvent(new Event('focus'))`)
  const pass = await waitFor(() => client.evaluate(`window.reproSyncPasses.find((pass) => pass.latestSequence >= ${limit})`), 'the foreground catch-up pass', 120_000)
  await waitFor(() => client.evaluate('window.reproRefreshes > 0'), 'the production scheduler to refresh the UI', 60_000)
  await client.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const state = await readState()
  const day = state.plans.find((plan) => plan.date === '2026-01-01')
  assert(day, 'The synthetic day itself must still exist')
  const inDatabase = state.plans.some((plan) => plan.items.some((item) => item.id === task.id && item.text === text))
  const inUi = await visible(text)
  const result = {
    name, before: { planId: 'catchup-plan-0', taskId: task.id, visible: true, durable: true, bottomOfDay: true },
    after: { planId: day.id, taskInDatabase: inDatabase, taskVisible: inUi },
    sync: pass, reproduced: !inDatabase && !inUi,
  }
  report.scenarios.push(result)
  console.log(`[stale-task-repro] ${JSON.stringify(result)}`)
  if (name === 'ordinary-backlog') {
    assert.equal(day.id, 'catchup-plan-0')
    assert(inDatabase && inUi, 'Ordinary catch-up erased the new task')
    for (let offset = 0; offset < backlogCount; offset++) {
      const item = state.plans.find((plan) => plan.id === `catchup-plan-${Math.floor(offset / 20)}`).items[offset % 20]
      assert.equal(item.done, (offset % 20) % 3 !== 0, 'Remote backlog did not fully arrive')
    }
  } else {
    assert.equal(day.id, 'stale-task-regenerated-plan', 'The remote day replacement was not delivered')
  }
  // Cold reopening distinguishes a transient display refresh from persisted loss.
  adb(['shell', 'am', 'force-stop', packageName])
  client.close()
  launchApp()
  client = await connectDevTools(await waitFor(appPid, 'the reopened synthetic process'))
  assert(!(await waitForDatabaseReady(client)).failed)
  result.afterRestart = {
    taskInDatabase: (await readState()).plans.some((plan) => plan.items.some((item) => item.id === task.id)),
    taskVisible: await visible(text),
  }
  assert.equal(result.afterRestart.taskInDatabase, inDatabase)
}

try {
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxyPort, '127.0.0.1', resolve) })
  await waitFor(manifest, 'the isolated reference relay')
  adb(['reverse', `tcp:${proxyPort}`, `tcp:${proxyPort}`])
  client = await connectDevTools(await waitFor(appPid, 'the CI app'))
  assert(!(await waitForDatabaseReady(client)).failed)
  await invoke('initialize_app_state', { stateJson: JSON.stringify(syntheticState()) })
  const pairingCode = await invoke('sync_new_pairing_code')
  await invoke('sync_enable_primary', { pairingCode })
  await invoke('set_sync_relay_url', { relayUrl })
  await invoke('sync_relay_once', { reason: 'stale-task-seed-baseline' })
  assert.equal((await manifest()).latestSequence, 1, 'Expected one baseline batch')
  const operations = Array.from({ length: backlogCount }, (_, offset) => ({
    id: `stale-task-backlog-${offset}`, deviceId: 'catchup-primary', sequence: offset + 1,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, offset + 1)).toISOString(), type: 'patch_plan_item',
    payload: { planId: `catchup-plan-${Math.floor(offset / 20)}`, itemId: `catchup-item-${Math.floor(offset / 20)}-${offset % 20}`, patch: { done: (offset % 20) % 3 !== 0 } },
  }))
  await invoke('persist_operations_for_android_ci', { operationsJson: JSON.stringify(operations) })
  await invoke('sync_relay_once', { reason: 'stale-task-seed-backlog' })
  const backlogSequence = (await manifest()).latestSequence
  assert.equal(backlogSequence, backlogCount + 1)
  // Model regeneration after the phone's last sync. Preserve every task the
  // primary knows about, just as current frontend regeneration does. The only
  // missing task is the one Android will subsequently create while stale.
  const priorDay = (await readState()).plans.find((plan) => plan.id === 'catchup-plan-0')
  await invoke('persist_operations_for_android_ci', { operationsJson: JSON.stringify([{
    id: 'stale-task-regenerate', deviceId: 'catchup-primary', sequence: backlogCount + 1,
    timestamp: '2026-01-02T00:00:00.000Z', type: 'generate_plan',
    payload: { templateId: 'synthetic-template', date: priorDay.date, replaceExisting: true, activePlanDate: '',
      generatedPlan: { ...priorDay, id: 'stale-task-regenerated-plan', createdAt: '2026-01-02T00:00:00.000Z' } },
  }]) })
  await invoke('sync_relay_once', { reason: 'stale-task-seed-regeneration' })
  const regenerationSequence = (await manifest()).latestSequence
  assert.equal(regenerationSequence, backlogSequence + 1)
  await runScenario('ordinary-backlog', backlogSequence, pairingCode)
  await runScenario('regenerated-day', regenerationSequence, pairingCode)
  report.completed = true
} catch (error) {
  report.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  await writeFile('android-stale-task-repro.json', `${JSON.stringify(report, null, 2)}\n`)
  await writeFile('android-stale-task-repro-logcat.txt', adb(['logcat', '-d'], { allowFailure: true }))
  client?.close()
  adb(['forward', '--remove', 'tcp:9223'], { allowFailure: true })
  adb(['reverse', '--remove', `tcp:${proxyPort}`], { allowFailure: true })
  proxy.closeAllConnections()
  await new Promise((resolve) => proxy.close(resolve))
  relay.kill('SIGTERM')
  await Promise.race([new Promise((resolve) => relay.once('exit', resolve)), sleep(2_000)])
  await writeFile('android-stale-task-repro-relay.log', relayLog.join(''))
  console.log(`[stale-task-repro] ${JSON.stringify(report)}`)
}
