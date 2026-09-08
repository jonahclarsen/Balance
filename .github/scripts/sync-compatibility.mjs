import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const [oldBinary, currentBinary] = process.argv.slice(2)
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
  if (!allowError) assert.equal(response.error, null)
  return response
}
const state = (deviceId) => ({ schemaVersion: 1, deviceId, localSequence: 0, historyRevision: 0, activePlanDate: '', preferences: {}, templates: [], plans: [], goals: [], goalCompletions: [], listTemplates: [], lists: [], metrics: [], metricEntries: [], notes: [], images: [], projects: [], projectCheckIns: [], operations: [] })
const operation = (device, sequence, type, payload) => ({ id: `${device}-${sequence}`, deviceId: device, sequence, type, timestamp: `2026-09-08T12:00:${String(sequence).padStart(2, '0')}.000Z`, payload })
const record = (collection, key, value, patches = []) => ({ collection, key, position: 0, value, patches })
const generic = (device, seq, upserts, deletes = []) => operation(device, seq, 'apply_entity_changes', { action: 'future_feature_action', entityChanges: { version: 2, upserts, deletes } })

// An actual released executable creates the encrypted DB and legacy operation
// log. The new executable opens the same bytes, replays, edits, undoes and compacts.
run(oldBinary, 'legacy', 'init', { state: state('old-device') })
const legacy = run(oldBinary, 'legacy', 'write', { operation: operation('old-device', 1, 'add_note', { entityChanges: { version: 1, upserts: [{ collection: 'notes', key: 'n', position: 0, value: { id: 'n', title: 'Synthetic old note', items: [] } }], deletes: [] } }) })
copyFileSync(join(root, 'legacy.sqlite3'), join(root, 'upgrade.sqlite3'))
let upgraded = run(currentBinary, 'upgrade', 'read')
assert.deepEqual(upgraded.entities, legacy.entities)
assert.deepEqual(upgraded.operations, legacy.operations)
run(currentBinary, 'upgrade', 'undo')
upgraded = run(currentBinary, 'upgrade', 'redo')
assert.deepEqual(upgraded.entities, legacy.entities)
upgraded = run(currentBinary, 'upgrade', 'checkpoint')
assert.deepEqual(upgraded.entities, legacy.entities)

// A future producer uses only this release's generic storage contract. This
// executable has no schema/UI for the future collection or nested field.
run(currentBinary, 'future', 'init', { state: state('future-device') })
let future = run(currentBinary, 'future', 'write', { operation: generic('future-device', 1, [
  record('futureHabitCheckIns', 'f', { id: 'f', amount: 7 }),
  record('notes', 'n', { id: 'n', title: 'Before', futureColor: 'blue', items: [{ id: 'task', text: 'Synthetic task', done: false, futureLink: 'f' }] }),
]) })
run(currentBinary, 'blind', 'init', { state: state('blind-device') })
run(currentBinary, 'blind', 'merge', { operations: future.operations })
let blind = run(currentBinary, 'blind', 'write', { operation: generic('blind-device', 1, [record('notes', 'n', { id: 'n', title: 'After', items: [] }, [
  { kind: 'object', fields: { title: { kind: 'replace', value: 'After' }, items: { kind: 'records', entries: { task: { kind: 'object', fields: { done: { kind: 'replace', value: true } }, remove: [] } }, remove: [] } }, remove: [] },
])]) })
let note = blind.entities.find((row) => row.key === 'n').value
assert.equal(note.futureColor, 'blue')
assert.equal(note.items[0].futureLink, 'f')
assert.equal(note.items[0].done, true)
run(currentBinary, 'blind', 'undo')
blind = run(currentBinary, 'blind', 'redo')
const beforeCompact = blind.entities
blind = run(currentBinary, 'blind', 'checkpoint')
assert.deepEqual(blind.entities, beforeCompact)
future = run(currentBinary, 'future', 'merge', { operations: blind.operations })
assert.deepEqual(future.entities, blind.entities)

// Unsupported primitives roll back the entire incoming transaction; the failed
// operation is never acknowledged or compacted away.
const bad = structuredClone(generic('future-device', 2, [record('futureHabitCheckIns', 'f', { id: 'f' }, [{ kind: 'future_primitive' }])]))
const envelope = { id: bad.id, device_id: bad.deviceId, sequence: bad.sequence, type: bad.type, timestamp: bad.timestamp, payload_json: JSON.stringify(bad.payload) }
const failed = run(currentBinary, 'blind', 'merge', { operations: [envelope] }, true)
assert.match(failed.error, /Update required/)
assert.deepEqual(failed.entities, blind.entities)
assert.deepEqual(failed.operations, blind.operations)
console.log(`PASS: released database upgrade, legacy undo/redo, unknown features, nested fields, two-way edits, compaction, rollback (${requests} real-engine process calls)`)
