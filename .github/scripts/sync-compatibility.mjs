import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { once } from 'node:events'

const [oldBinary, currentBinary, futureBinary = currentBinary, frontendFixtures] = process.argv.slice(2)
assert(oldBinary && currentBinary, 'Provide old and current test executables')
const root = mkdtempSync(join(tmpdir(), 'balance-version-compat-'))
writeFileSync(join(root, 'SYNTHETIC_FIXTURES_ONLY'), 'Generated synthetic data; public test-only key')
let requests = 0
function run(binary, database, command, extra = {}, allowError = false) {
  const input = join(root, `request-${++requests}.json`)
  writeFileSync(input, JSON.stringify({ root, database, command, ...extra }))
  const result = spawnSync(binary, ['sync_compat_driver::compatibility_process_driver', '--exact', '--ignored', '--nocapture'], {
    env: { ...process.env, BALANCE_COMPAT_REQUEST: input }, encoding: 'utf8', timeout: 120_000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const response = JSON.parse(readFileSync(join(root, 'response.json'), 'utf8'))
  assert.equal(response.integrity, 'ok')
  if (!allowError) assert.equal(response.error, null, `${database}: ${command}: ${response.error}`)
  return response
}
const state = (deviceId) => ({ schemaVersion: 1, deviceId, localSequence: 0, historyRevision: 0, activePlanDate: '', templates: [], plans: [], goals: [], goalCompletions: [], listTemplates: [], lists: [], metrics: [], metricEntries: [], notes: [], images: [], projects: [], projectCheckIns: [], uneditedPlanItems: [], operations: [] })
const operation = (device, sequence, type, payload) => ({ id: `${device}-${sequence}`, deviceId: device, sequence, type, timestamp: `2026-09-08T12:00:${String(sequence).padStart(2, '0')}.000Z`, payload })
const record = (collection, key, value, patches = []) => ({ collection, key, position: 0, value, patches })
const generic = (device, seq, upserts, deletes = []) => operation(device, seq, 'apply_entity_changes', { action: 'future_feature_action', entityChanges: { version: 2, upserts, deletes } })

// An actual released executable creates the encrypted DB and legacy operation
// log. The new executable opens the same bytes, replays, edits, undoes and compacts.
run(oldBinary, 'legacy', 'init', { state: state('old-device') })
const legacy = run(oldBinary, 'legacy', 'write', { operation: operation('old-device', 1, 'add_note', { entityChanges: { version: 1, upserts: [{ collection: 'notes', key: 'n', position: 0, value: { id: 'n', title: 'Synthetic old note', items: [] } }], deletes: [] } }) })
const blindBinary = legacy.protocolVersion >= 6 ? oldBinary : currentBinary
copyFileSync(join(root, 'legacy.sqlite3'), join(root, 'upgrade.sqlite3'))
let upgraded = run(currentBinary, 'upgrade', 'read')
assert.deepEqual(upgraded.entities, legacy.entities)
assert.deepEqual(upgraded.operations, legacy.operations)
run(currentBinary, 'upgrade', 'undo')
upgraded = run(currentBinary, 'upgrade', 'redo')
assert.deepEqual(upgraded.entities, legacy.entities)
upgraded = run(currentBinary, 'upgrade', 'checkpoint')
assert.deepEqual(upgraded.entities, legacy.entities)

// A released engine supplies the baseline and a remote anchor move. Upgrade
// with a locally saved split, then replay, undo/redo, checkpoint and reopen.
const splitInitial = state('split-desktop')
const splitItem = (id, text) => ({ id, text, html: text, done: false, startMinutes: null, endMinutes: null, children: [] })
splitInitial.plans = [
  { id: 'split-day', date: '2026-09-08', title: 'Synthetic day', dailyReminder: '', createdAt: '2026-09-08T00:00:00Z', items: [splitItem('anchor', 'Original')] },
  { id: 'split-other', date: '2026-09-09', title: 'Synthetic tomorrow', dailyReminder: '', createdAt: '2026-09-08T00:00:00Z', items: [] },
]
run(oldBinary, 'split-desktop', 'init', { state: splitInitial })
run(currentBinary, 'split-phone', 'init', { state: { ...splitInitial, deviceId: 'split-phone' } })
const movedAnchor = run(oldBinary, 'split-desktop', 'write', { operation: operation('split-desktop', 1, 'move_plan_item_to_plan', {
  sourcePlanId: 'split-day', targetPlanId: 'split-other', itemId: 'anchor', targetId: null, placement: 'after', item: splitItem('anchor', 'Remote edit'),
}) })
run(currentBinary, 'split-phone', 'write', { operation: { ...operation('split-phone', 1, 'split_plan_item', {
  planId: 'split-day', itemId: 'anchor', patch: { text: 'Left', html: 'Left' }, newItem: splitItem('new-task', 'Right'), placement: 'after',
}), timestamp: '2026-09-08T12:00:02.000Z' } })
const verifySplit = (response, exists) => {
  const day = response.state.plans.find(plan => plan.id === 'split-day')
  assert.equal(day.items.filter(item => item.id === 'new-task' && item.text === 'Right').length, Number(exists))
  assert.equal(response.state.plans.find(plan => plan.id === 'split-other').items[0].text, 'Remote edit')
}
verifySplit(run(currentBinary, 'split-phone', 'merge', { operations: movedAnchor.operations }), true)
verifySplit(run(currentBinary, 'split-phone', 'undo'), false)
verifySplit(run(currentBinary, 'split-phone', 'redo'), true)
const splitCheckpoint = run(currentBinary, 'split-phone', 'checkpoint')
verifySplit(splitCheckpoint, true)
verifySplit(run(currentBinary, 'split-phone', 'read'), true)
// The other device upgrades before it receives the new replay semantics.
verifySplit(run(currentBinary, 'split-desktop', 'merge', { operations: splitCheckpoint.operations }), true)
console.log('PASS: released anchor move, preserved split, guarded undo/redo and checkpoint after upgrade')

// A real released engine replaces a day with a new ID. A newer offline
// phone adds a task using its old ID, then both engines upgrade and converge.
const dayInitial = state('day-desktop')
dayInitial.plans = [{ id: 'old-day', date: '2026-09-08', title: 'Synthetic day', dailyReminder: '',
  createdAt: '2026-09-08T00:00:00Z', items: [splitItem('old-template-task', 'Old template')] }]
run(oldBinary, 'day-desktop', 'init', { state: dayInitial })
run(currentBinary, 'day-phone', 'init', { state: { ...dayInitial, deviceId: 'day-phone' } })
const replacedDay = run(oldBinary, 'day-desktop', 'write', { operation: operation('day-desktop', 1, 'generate_plan', {
  date: '2026-09-08', replaceExisting: true, generatedPlan: { ...dayInitial.plans[0], id: 'replacement-day', items: [splitItem('fresh-template-task', 'Fresh template')] },
}) })
assert.equal(replacedDay.state.plans[0].id, 'replacement-day')
const replacementCheckpoint = run(oldBinary, 'day-desktop', 'checkpoint')
run(currentBinary, 'day-phone', 'write', { operation: { ...operation('day-phone', 1, 'add_plan_item', {
  planId: 'old-day', planDate: '2026-09-08', parentId: null, item: splitItem('offline-day-task', 'Saved offline'),
}), timestamp: '2026-09-08T12:00:02.000Z' } })
// Exercise both a retained legacy generation and an already compacted old checkpoint.
for (const incoming of [replacedDay.operations, replacementCheckpoint.operations]) {
  const merged = run(currentBinary, 'day-phone', 'merge', { operations: incoming })
  assert.equal(merged.state.plans.length, 1)
  assert.equal(merged.state.plans[0].items.filter(item => item.id === 'offline-day-task').length, 1)
}
const dayCompact = run(currentBinary, 'day-phone', 'checkpoint')
const dayDesktop = run(currentBinary, 'day-desktop', 'merge', { operations: dayCompact.operations })
assert.deepEqual(dayDesktop.state.plans, dayCompact.state.plans)
assert.deepEqual(run(currentBinary, 'day-phone', 'read').state.plans, dayCompact.state.plans)
console.log('PASS: released day replacement/checkpoint preserves an offline addition after upgrade')

// A future producer uses only this release's generic storage contract. This
// executable has no schema/UI for the future collection or nested field.
run(futureBinary, 'future', 'init', { state: state('future-device') })
let future = run(futureBinary, 'future', 'write', { operation: generic('future-device', 1, [
  record('futureHabitCheckIns', 'f', { id: 'f', amount: 7 }),
  record('uneditedPlanItems', 'synthetic-generated-task', { id: 'synthetic-generated-task', futureRetention: { enabled: true } }),
  record('notes', 'n', { id: 'n', title: 'Before', futureColor: 'blue', items: [{ id: 'task', text: 'Synthetic task', done: false, futureLink: 'f' }] }),
]) })
assert.deepEqual(future.state.futureHabitCheckIns, [{ id: 'f', amount: 7 }])
run(blindBinary, 'blind', 'init', { state: state('blind-device') })
const blindView = run(blindBinary, 'blind', 'merge', { operations: future.operations })
assert(!Object.hasOwn(blindView.state, 'futureHabitCheckIns'))
let blind = run(blindBinary, 'blind', 'write', { operation: generic('blind-device', 1, [record('notes', 'n', { id: 'n', title: 'After', items: [] }, [
  { kind: 'object', fields: { title: { kind: 'replace', value: 'After' }, items: { kind: 'records', entries: { task: { kind: 'object', fields: { done: { kind: 'replace', value: true } }, remove: [] } }, remove: [] } }, remove: [] },
])]) })
let note = blind.entities.find((row) => row.key === 'n').value
assert.equal(note.futureColor, 'blue')
assert.equal(note.items[0].futureLink, 'f')
assert.equal(note.items[0].done, true)
assert.deepEqual(blind.entities.find((row) => row.collection === 'uneditedPlanItems').value, { id: 'synthetic-generated-task', futureRetention: { enabled: true } })
run(blindBinary, 'blind', 'undo')
blind = run(blindBinary, 'blind', 'redo')
const beforeCompact = blind.entities
blind = run(blindBinary, 'blind', 'checkpoint')
assert.deepEqual(blind.entities, beforeCompact)
future = run(futureBinary, 'future', 'merge', { operations: blind.operations })
assert.deepEqual(future.entities, blind.entities)

// Deleting unfamiliar records/fields must survive an older client's next
// edit and checkpoint rather than being resurrected from a stale whole record.
future = run(futureBinary, 'future', 'write', { operation: generic('future-device', 2, [record('notes', 'n', { id: 'n' }, [
  { kind: 'object', fields: {}, remove: ['futureColor'] },
])], [{ collection: 'futureHabitCheckIns', key: 'f' }, { collection: 'uneditedPlanItems', key: 'synthetic-generated-task' }]) })
blind = run(blindBinary, 'blind', 'merge', { operations: future.operations })
assert(!blind.entities.some((row) => row.collection === 'futureHabitCheckIns'))
assert(!blind.entities.some((row) => row.collection === 'uneditedPlanItems'))
assert(!Object.hasOwn(blind.entities.find((row) => row.key === 'n').value, 'futureColor'))

future = run(futureBinary, 'future', 'undo')
assert(future.entities.some((row) => row.collection === 'uneditedPlanItems'))
blind = run(blindBinary, 'blind', 'merge', { operations: future.operations })
assert.deepEqual(blind.entities, future.entities)
future = run(futureBinary, 'future', 'redo')
blind = run(blindBinary, 'blind', 'merge', { operations: future.operations })
assert(!blind.entities.some((row) => row.collection === 'uneditedPlanItems'))
blind = run(blindBinary, 'blind', 'checkpoint')
future = run(futureBinary, 'future', 'merge', { operations: blind.operations })
assert.deepEqual(future.entities, blind.entities)

// Unsupported primitives roll back the entire incoming transaction; the failed
// operation is never acknowledged or compacted away.
const bad = structuredClone(generic('future-device', 10, [record('futureHabitCheckIns', 'f', { id: 'f' }, [{ kind: 'future_primitive' }])]))
const envelope = { id: bad.id, device_id: bad.deviceId, sequence: bad.sequence, type: bad.type, timestamp: bad.timestamp, payload_json: JSON.stringify(bad.payload) }
const failed = run(blindBinary, 'blind', 'merge', { operations: [envelope] }, true)
assert.match(failed.error, /Update required/)
assert.deepEqual(failed.entities, blind.entities)
assert.deepEqual(failed.operations, blind.operations)
console.log(`PASS: released database upgrade, legacy undo/redo, unknown features, nested fields, two-way edits, compaction, rollback (${requests} real-engine process calls)`)

// Exercise real encrypted relay envelopes as well as the merge/materializer.
// The port is randomly assigned once for this isolated fixture server.
const relayPort = randomInt(20_000, 60_000)
const relaySecret = 'synthetic_compatibility_relay_only'
const relay = spawn(process.execPath, ['scripts/relay-server.mjs', String(relayPort)], {
  env: { ...process.env, BALANCE_RELAY_SECRET: relaySecret }, stdio: ['ignore', 'pipe', 'inherit'],
})
try {
  await Promise.race([once(relay.stdout, 'data'), once(relay, 'exit').then(() => { throw Error('Fixture relay exited before startup') })])
  const url = `http://127.0.0.1:${relayPort}/${relaySecret}`
  run(oldBinary, 'legacy', 'relay', { url })
  run(currentBinary, 'network', 'init', { state: state('network-device') })
  const downloaded = run(currentBinary, 'network', 'relay', { url })
  assert.deepEqual(downloaded.entities, legacy.entities)
  run(currentBinary, 'network', 'write', { operation: generic('network-device', 1, [record('futureNetworkCollection', 'network-row', { id: 'network-row', value: 19 })]) })
  run(currentBinary, 'network', 'relay', { url })
  const incompatible = run(oldBinary, 'legacy', 'relay', { url }, true)
  if (legacy.protocolVersion < downloaded.protocolVersion) {
    assert.match(incompatible.error, /incompatible protocol|Update required/)
    assert.deepEqual(incompatible.entities, legacy.entities)
  } else {
    assert.equal(incompatible.error, null)
    assert(incompatible.entities.some((row) => row.collection === 'futureNetworkCollection'))
  }
  const recovered = run(currentBinary, 'legacy', 'relay', { url })
  assert(recovered.entities.some((row) => row.collection === 'futureNetworkCollection'))
  console.log(`PASS: protocol ${legacy.protocolVersion} encrypted relay download, compatibility boundary, in-place upgrade recovery`)
} finally {
  relay.kill()
  await once(relay, 'exit')
}

function comparable(collection, values) {
  if (collection === 'uneditedPlanItems') return [...values].sort((a, b) => a.id.localeCompare(b.id))
  if (collection !== 'plans') return values
  // SQL rows normalize optional time visibility and do not expose the existing
  // frontend-only generation diagnostics. Compare all persisted planner data.
  const items = (rows) => rows.map(({ id, text, html, done, startMinutes, endMinutes, timeHidden, children }) =>
    ({ id, text, html, done, startMinutes, endMinutes, timeHidden: timeHidden === true, children: items(children) }))
  return values.map(({ generatedGoalIds, items: rows, ...plan }) => ({ ...plan, items: items(rows) }))
}
if (frontendFixtures) {
  const collections = ['notes', 'listTemplates', 'lists', 'metrics', 'metricEntries', 'goals', 'goalCompletions', 'projects', 'projectCheckIns', 'uneditedPlanItems', 'plans']
  for (const [index, filename] of readdirSync(frontendFixtures).filter((name) => name.endsWith('.json')).entries()) {
    const fixture = JSON.parse(readFileSync(join(frontendFixtures, filename), 'utf8'))
    const database = `frontend-${index}`
    const baseline = run(currentBinary, database, 'init', { state: fixture.initial })
    let applied
    for (const operation of fixture.operations) applied = run(currentBinary, database, 'write', { operation })
    for (const collection of collections) assert.deepEqual(comparable(collection, applied.state[collection]), comparable(collection, fixture.expected[collection]), `${filename}: ${collection} replay`)
    for (const operation of fixture.operations) applied = run(currentBinary, database, 'undo')
    for (const collection of collections) assert.deepEqual(comparable(collection, applied.state[collection]), comparable(collection, baseline.state[collection]), `${filename}: ${collection} undo`)
    for (const operation of fixture.operations) applied = run(currentBinary, database, 'redo')
    const compacted = run(currentBinary, database, 'checkpoint')
    for (const collection of collections) assert.deepEqual(comparable(collection, compacted.state[collection]), comparable(collection, fixture.expected[collection]), `${filename}: ${collection} redo/checkpoint`)
    console.log(`PASS: ${filename} frontend-generated operations replay, undo, redo and compact in SQLCipher`)
  }
}
