import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2]
const read = name => JSON.parse(readFileSync(join(directory, name), 'utf8'))
const before = read('before.json')
const after = read('after.json')
// A compile failure, bridge error or timeout is never accepted as reproduction.
assert.equal(read('before.exit'), 1)
assert.equal(read('after.exit'), 0)
assert.equal(before.correct, false)
assert.equal(after.correct, true)
assert.equal(before.operationCount, 6)
assert.equal(after.operationCount, 6)
assert.equal(before.distinctOperationIds, 6)
assert.equal(after.distinctOperationIds, 6)
assert.equal(before.historyCount, 6)
assert.equal(after.historyCount, 2)
assert.deepEqual(before.history.map(entry => entry.databaseText), ['abcde', 'abcd', 'abcde', 'abcdef'])
assert.deepEqual(after.history.map(entry => entry.databaseText), ['abc', '', 'abc', 'abcdef'])
assert.deepEqual(after.history.map(entry => entry.frontendText), after.expected)
assert.equal(before.history[0].frontendText, 'abc')
assert.equal(before.history[1].fullState, true)
assert.ok(after.history.every(entry => !entry.fullState && entry.responseBytes < 1024))
assert.ok(before.history[1].responseBytes > after.history[1].responseBytes * 1000)

const rows = [
  '# Offline note undo: original versus fixed', '',
  `Original: ${before.revision}. Fixed: ${after.revision}.`, '',
  'Same frontend-store test connected to each revision’s real native SQLCipher engine. Synthetic 90,000-item databases, six individually saved keystrokes in two typing bursts, browser offline, four background CPU workers. History responses are not mocked.', '',
  '| Measurement | Original | Fixed |', '|---|---:|---:|',
  `| Durable typing operations | ${before.operationCount} | ${after.operationCount} |`,
  `| Undo groups | ${before.historyCount} | ${after.historyCount} |`,
  '| Database text after first undo | `abcde` (wrong) | `abc` |',
  '| Database text after second undo | `abcd` (wrong) | empty |',
  `| Second undo native duration | ${before.history[1].nativeMs.toFixed(2)} ms | ${after.history[1].nativeMs.toFixed(2)} ms |`,
  `| Second undo frontend duration, including bridge | ${before.history[1].frontendMs.toFixed(2)} ms | ${after.history[1].frontendMs.toFixed(2)} ms |`,
  `| Second undo response bytes | ${before.history[1].responseBytes} | ${after.history[1].responseBytes} |`,
  '| Frontend/database agree with expected undo and redo | Fail | Pass |', '',
  'Durations are individual measurements on this CI runner, not estimates for the user’s device. The regression gate checks actual contents, history grouping, and full-state responses; it does not depend on a fragile millisecond threshold.', '',
].join('\n')
console.log(rows)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, rows)
