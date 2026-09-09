#!/usr/bin/env node
// Diagnostic only: real WebView input + native encrypted relay reconciliation.
// A successful run reports whether loss occurred; it does not assert that loss
// is desirable. All scenarios use ordinary edits and preserve the day ID.
import http from 'node:http'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import {
  packageName, forceBackgroundJob, sleep, adb, waitFor, appPid, launchApp, connectDevTools,
  waitForDatabaseReady, syntheticState,
} from './android-sync-profile-helpers.mjs'

if (!process.env.CI) throw new Error('This reproduction runs only against the CI emulator.')
// Reuse the existing catch-up profiler's permanent ports; these run sequentially.
const relayPort = 8791
const proxyPort = 8790
const relaySecret = randomBytes(24).toString('base64url')
const relayUrl = `http://127.0.0.1:${proxyPort}/${relaySecret}/`
const backlogCount = 66
const report = { backlogCount, regenerations: 0, scenarios: [] }
const relayLog = []
let client
let manifestLimit = Infinity
let offline = false
let holdBlobs = false
let releaseDownloads = []
let heldDownloads = 0
let manifestRequests = 0
const releaseBlobs = () => {
  holdBlobs = false
  for (const release of releaseDownloads.splice(0)) release()
}
const proxy = http.createServer(async (request, response) => {
  if (request.url?.includes('/v3/manifest')) manifestRequests++
  if (holdBlobs && request.url?.includes('/v3/blobs/')) {
    heldDownloads++
    await new Promise((resolve) => releaseDownloads.push(resolve))
  }
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
async function readOperations() {
  // This process only ever connects to the CI installation seeded below.
  const inspected = JSON.parse(await invoke('inspect_database'))
  return inspected.operations.map((op) => ({ ...op, payload: JSON.parse(op.payloadJson) }))
}
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
  await waitFor(() => client.evaluate(`Boolean(document.querySelector('.sync-status-indicator.error'))`), 'the scheduler to observe the offline relay', 60_000)
}
async function typeTask(text, { method = 'add', durable = true, composing = false } = {}) {
  const count = await client.evaluate(`document.querySelectorAll('[data-plan-text-input]').length`)
  if (method === 'add') {
    await client.evaluate(`document.querySelector('.day-pane .add-row').click()`)
  } else {
    await client.evaluate(`(() => {
      const editor = document.querySelector('[data-plan-text-input-id="catchup-item-0-19"]')
      editor.focus()
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
    })()`)
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  await waitFor(() => client.evaluate(`document.querySelectorAll('[data-plan-text-input]').length === ${count + 1}`), 'the new bottom task')
  const id = await client.evaluate(`(() => {
    const editors = document.querySelectorAll('[data-plan-text-input]')
    const editor = editors[editors.length - 1]
    editor.scrollIntoView({ block: 'center' })
    editor.focus()
    return editor.dataset.planTextInputId
  })()`)
  if (composing) {
    await client.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
  } else {
    await client.send('Input.insertText', { text })
  }
  assert(await visible(text), 'Task must be visible before catch-up')
  if (durable) {
    await waitFor(async () => findTask(await readState(), id)?.item.text === text,
      'the typed task to be durable before catch-up', 60_000)
  }
  return { id, text }
}
function findTask(state, id) {
  const walk = (items) => {
    for (const item of items) {
      if (item.id === id) return item
      const nested = walk(item.children ?? [])
      if (nested) return nested
    }
  }
  for (const plan of state.plans) {
    const item = walk(plan.items)
    if (item) return { planId: plan.id, item }
  }
  return null
}
function creationOperation(state, id) {
  const op = state.operations.find((op) => op.payload?.newItem?.id === id || op.payload?.item?.id === id)
  return op ? { type: op.type, id: op.id, sequence: op.sequence, planId: op.payload.planId, sourceId: op.payload.itemId } : null
}
async function visible(text) {
  return client.evaluate(`[...document.querySelectorAll('[data-plan-text-input]')].some((editor) => editor.textContent === ${JSON.stringify(text)})`)
}
async function runScenario(scenario, pairingCode) {
  const { name, limit, method, timing = 'before', changedSource = false, checkpoint = false } = scenario
  console.log(`[stale-task-repro] starting ${name}`)
  offline = false
  manifestLimit = 1
  await resetJoiner(pairingCode)
  const text = `Synthetic unsynced bottom task ${name}`
  const started = performance.now()
  let forcedJobId
  if (timing === 'during-download' || timing === 'pending-composition') {
    holdBlobs = true
    heldDownloads = 0
    manifestLimit = limit
    offline = false
    await client.evaluate(`window.dispatchEvent(new Event('focus'))`)
    await waitFor(() => heldDownloads > 0, 'the real catch-up download to be in flight')
  }
  const task = await typeTask(text, { method,
    durable: timing !== 'pending-composition', composing: timing === 'pending-composition' })
  const beforeState = await readState()
  beforeState.operations = await readOperations()
  const beforeTask = findTask(beforeState, task.id)
  const result = {
    name, method, timing, checkpoint, changedSource,
    before: { planId: 'catchup-plan-0', taskId: task.id, visible: true,
      durable: beforeTask?.item.text === text, bottomOfDay: true,
      creationOperation: creationOperation(beforeState, task.id) },
  }
  report.scenarios.push(result)
  if (timing !== 'pending-composition') assert(result.before.durable)
  if (result.before.creationOperation) assert.equal(result.before.creationOperation.type, method === 'enter' ? 'split_plan_item' : 'add_plan_item')
  manifestLimit = limit
  offline = false
  if (timing === 'background') {
    holdBlobs = true
    heldDownloads = 0
    forcedJobId = await forceBackgroundJob({ get manifestRequests() { return manifestRequests } })
    await waitFor(() => heldDownloads > 0, 'WorkManager to begin downloading the backlog')
    releaseBlobs()
    await waitFor(async () => findTask(await readState(), 'catchup-item-0-0')?.item.done === false,
      'WorkManager to materialize remote edits', 60_000)
    launchApp()
  }
  releaseBlobs()
  await client.evaluate(`window.dispatchEvent(new Event('focus'))`)
  await waitFor(async () => {
    const state = await readState()
    const lastBacklogItem = findTask(state, 'catchup-item-3-5')
    const movedSource = findTask(state, 'catchup-item-0-19')
    return lastBacklogItem?.item.done === true
      && (!changedSource || (changedSource === 'moved' ? movedSource?.planId === 'catchup-plan-4' : !movedSource))
  }, 'the foreground scheduler to materialize the remote backlog', 120_000, 250)
  await waitFor(() => client.evaluate(`!document.querySelector('.sync-status-indicator')`), 'the production scheduler to finish refreshing the UI', 60_000)
  await client.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  if (timing === 'pending-composition') {
    await client.send('Input.insertText', { text })
    await sleep(750)
  }
  const state = await readState()
  state.operations = await readOperations()
  const day = state.plans.find((plan) => plan.date === '2026-01-01')
  assert.equal(day?.id, 'catchup-plan-0', 'Ordinary catch-up must not replace the day')
  const incomingCheckpoint = state.operations.some((op) => op.type === 'replace_full_state' && op.payload.generation >= 2)
  assert.equal(incomingCheckpoint, checkpoint, 'Scenario must receive exactly the intended checkpoint coverage')
  assert(!state.operations.some((op) => op.type === 'generate_plan'), 'No regeneration is allowed')
  const storedTask = findTask(state, task.id)
  const inDatabase = storedTask?.item.text === text
  const inUi = await visible(text)
  result.after = {
    planId: day.id, taskInDatabase: inDatabase, taskVisible: inUi,
    taskLocation: storedTask?.planId ?? null, taskText: storedTask?.item.text ?? null,
    creationOperation: creationOperation(state, task.id),
  }
  result.catchupMs = Math.round(performance.now() - started)
  result.forcedJobId = forcedJobId
  result.reproduced = !storedTask && !inUi
  result.textLost = Boolean(storedTask && !inDatabase)
  result.verificationSync = await invoke('sync_relay_once', { reason: 'stale-task-verify-already-caught-up' })
  assert.equal(result.verificationSync.pulledOperations, 0, 'The scheduler must finish catch-up before verification')
  // Every remote completion edit is checked by ID, including moved tasks.
  for (let offset = 0; offset < backlogCount; offset++) {
    const id = `catchup-item-${Math.floor(offset / 20)}-${offset % 20}`
    if (changedSource === 'deleted' && id === 'catchup-item-0-19') continue
    assert.equal(findTask(state, id)?.item.done, (offset % 20) % 3 !== 0, `Missing remote edit ${id}`)
  }
  adb(['shell', 'am', 'force-stop', packageName])
  client.close()
  launchApp()
  client = await connectDevTools(await waitFor(appPid, 'the reopened synthetic process'))
  assert(!(await waitForDatabaseReady(client)).failed)
  const reopenedTask = findTask(await readState(), task.id)
  result.afterRestart = { taskInDatabase: reopenedTask?.item.text === text, taskVisible: await visible(text) }
  assert.equal(result.afterRestart.taskInDatabase, inDatabase)
  console.log(`[stale-task-repro] ${JSON.stringify(result)}`)
  await writeFile('android-stale-task-repro.json', `${JSON.stringify(report, null, 2)}\n`)
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
  const source = findTask(await readState(), 'catchup-item-0-19').item
  await invoke('persist_operations_for_android_ci', { operationsJson: JSON.stringify([{
    id: 'stale-task-move-source', deviceId: 'catchup-primary', sequence: backlogCount + 1,
    timestamp: '2026-01-02T00:00:00.000Z', type: 'move_plan_item_to_plan',
    payload: { sourcePlanId: 'catchup-plan-0', targetPlanId: 'catchup-plan-4', itemId: source.id,
      targetId: null, placement: 'after', item: source },
  }]) })
  await invoke('sync_relay_once', { reason: 'stale-task-seed-source-move' })
  const movedSequence = (await manifest()).latestSequence
  assert.equal(movedSequence, backlogSequence + 1)
  await invoke('persist_operations_for_android_ci', { operationsJson: JSON.stringify([{
    id: 'stale-task-delete-source', deviceId: 'catchup-primary', sequence: backlogCount + 2,
    timestamp: '2026-01-02T00:00:01.000Z', type: 'delete_plan_item',
    payload: { planId: 'catchup-plan-4', itemId: source.id, completedParentIds: [] },
  }]) })
  await invoke('sync_relay_once', { reason: 'stale-task-seed-source-delete' })
  const deletedSequence = (await manifest()).latestSequence
  assert.equal(deletedSequence, movedSequence + 1)
  // Restore the old anchor before building the checkpoint control. The move
  // and deletion repros stop at earlier cursors and NEVER receive a checkpoint.
  await invoke('persist_operations_for_android_ci', { operationsJson: JSON.stringify([{
    id: 'stale-task-restore-source', deviceId: 'catchup-primary', sequence: backlogCount + 3,
    timestamp: '2026-01-02T00:00:02.000Z', type: 'insert_plan_item_at',
    payload: { planId: 'catchup-plan-0', parentId: null, item: source, position: 19 },
  }]) })
  await invoke('sync_relay_once', { reason: 'stale-task-seed-source-restore' })
  await invoke('sync_enable_primary', { pairingCode })
  await invoke('sync_relay_once', { reason: 'stale-task-seed-checkpoint' })
  const checkpointSequence = (await manifest()).latestSequence
  assert.equal(checkpointSequence, deletedSequence + 2)
  const nativeCheckpoint = (await readOperations()).find((op) => op.type === 'replace_full_state')
  assert(nativeCheckpoint?.payload.generation >= 2)
  assert.equal(nativeCheckpoint.payload.frontiers['catchup-primary'], backlogCount + 3)
  const scenarios = [
    { name: 'add-ordinary', method: 'add', limit: backlogSequence },
    { name: 'enter-ordinary', method: 'enter', limit: backlogSequence },
    { name: 'add-checkpoint', method: 'add', limit: checkpointSequence, checkpoint: true },
    { name: 'enter-checkpoint', method: 'enter', limit: checkpointSequence, checkpoint: true },
    { name: 'add-during-download', method: 'add', limit: backlogSequence, timing: 'during-download' },
    { name: 'enter-during-download', method: 'enter', limit: backlogSequence, timing: 'during-download' },
    { name: 'enter-composing-checkpoint', method: 'enter', limit: checkpointSequence, timing: 'pending-composition', checkpoint: true },
    { name: 'add-background', method: 'add', limit: backlogSequence, timing: 'background' },
    { name: 'enter-background', method: 'enter', limit: backlogSequence, timing: 'background' },
    { name: 'add-source-moved', method: 'add', limit: movedSequence, changedSource: 'moved' },
    { name: 'enter-source-moved', method: 'enter', limit: movedSequence, changedSource: 'moved' },
    { name: 'enter-source-deleted', method: 'enter', limit: deletedSequence, changedSource: 'deleted' },
  ]
  for (const scenario of scenarios) await runScenario(scenario, pairingCode)
  report.completed = true
} catch (error) {
  report.error = error.stack ?? String(error)
  if (client) {
    report.uiAtFailure = await client.evaluate(`({
      syncStatus: document.querySelector('.sync-status-indicator')?.outerHTML ?? null,
      heading: document.querySelector('.day-pane h2')?.textContent ?? null,
      tasks: [...document.querySelectorAll('[data-plan-text-input]')].map((editor) => editor.textContent),
    })`).catch(() => null)
  }
  process.exitCode = 1
} finally {
  releaseBlobs()
  await writeFile('android-stale-task-repro.json', `${JSON.stringify(report, null, 2)}\n`)
  try {
    await writeFile('android-stale-task-repro-logcat.txt', adb(['logcat', '-d'], {
      allowFailure: true, maxBuffer: 32 * 1024 * 1024,
    }))
  } catch (error) {
    relayLog.push(`Could not collect logcat: ${error}\n`)
    process.exitCode = 1
  }
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
