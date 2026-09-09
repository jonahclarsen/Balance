import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const expectedScenarios = [
  'add-ordinary', 'enter-ordinary', 'add-checkpoint', 'enter-checkpoint',
  'add-during-download', 'enter-during-download', 'enter-composing-checkpoint',
  'add-background', 'enter-background', 'add-source-moved', 'enter-source-moved', 'enter-source-deleted',
  'add-regeneration', 'enter-regeneration', 'add-regeneration-checkpoint', 'enter-regeneration-checkpoint',
]

export function assertTaskPreservation(report) {
  assert.equal(report.completed, true, 'Android task scenarios did not finish')
  assert.equal(report.error, undefined, 'Android task scenarios reported an error')
  assert.equal(report.regenerations, 1)
  assert.deepEqual(report.scenarios.map((scenario) => scenario.name).sort(), [...expectedScenarios].sort(),
    'All sixteen distinct Android scenarios must execute')
  for (const scenario of report.scenarios) {
    assert.equal(scenario.before.visible, true, `${scenario.name}: task was never visible`)
    if (scenario.name !== 'enter-composing-checkpoint') {
      assert.equal(scenario.before.durable, true, `${scenario.name}: task was never saved`)
    }
    assert.equal(scenario.after.planId, scenario.before.planId, `${scenario.name}: day changed`)
    assert.equal(scenario.reproduced, false, `${scenario.name}: task disappeared`)
    assert.equal(scenario.textLost, false, `${scenario.name}: task text disappeared`)
    assert.equal(scenario.verificationSync.pulledOperations, 0, `${scenario.name}: catch-up incomplete`)
    for (const stage of ['after', 'afterRestart']) {
      assert.equal(scenario[stage].taskInDatabase, true, `${scenario.name}: missing stored task ${stage}`)
      assert.equal(scenario[stage].taskVisible, true, `${scenario.name}: missing visible task ${stage}`)
      assert.equal(scenario[stage].matchingTaskCount, 1, `${scenario.name}: duplicate or missing task ${stage}`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertTaskPreservation(JSON.parse(readFileSync(process.argv[2], 'utf8')))
  console.log('PASS: all 16 Android task preservation scenarios completed without loss or duplication')
}
