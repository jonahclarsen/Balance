import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertTaskPreservation, expectedScenarios } from './android-task-preservation-gate.mjs'

const passingReport = () => ({
  completed: true, regenerations: 0,
  scenarios: expectedScenarios.map((name) => ({
    name, before: { visible: true, durable: true, planId: 'synthetic-day' },
    after: { planId: 'synthetic-day', taskInDatabase: true, taskVisible: true, matchingTaskCount: 1 },
    afterRestart: { taskInDatabase: true, taskVisible: true, matchingTaskCount: 1 },
    reproduced: false, textLost: false, verificationSync: { pulledOperations: 0 },
  })),
})
test('accepts all twelve completed preservation scenarios', () => assertTaskPreservation(passingReport()))
for (const [name, mutate] of [
  ['missing scenario', (r) => r.scenarios.pop()],
  ['duplicate scenario', (r) => { r.scenarios[1].name = r.scenarios[0].name }],
  ['unfinished run', (r) => { r.completed = false }],
  ['harness error', (r) => { r.error = 'Synthetic failure' }],
  ['task loss', (r) => { r.scenarios[0].reproduced = true }],
  ['text loss', (r) => { r.scenarios[0].textLost = true }],
  ['duplicate task', (r) => { r.scenarios[0].after.matchingTaskCount = 2 }],
  ['loss after restart', (r) => { r.scenarios[0].afterRestart.taskInDatabase = false }],
  ['missing duplicate check', (r) => { delete r.scenarios[0].afterRestart.matchingTaskCount }],
  ['incomplete catch-up', (r) => { r.scenarios[0].verificationSync.pulledOperations = 1 }],
]) {
  test(`rejects ${name}`, () => {
    const report = passingReport()
    mutate(report)
    assert.throws(() => assertTaskPreservation(report))
  })
}
