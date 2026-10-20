import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2]
const scenarios = new Map()
for (const file of readdirSync(directory).sort()) {
  const match = /^(baseline|candidate)-(\d+)\.log$/.exec(file)
  if (!match) continue
  for (const line of readFileSync(join(directory, file), 'utf8').split('\n')) {
    const marker = line.indexOf('PERF ')
    if (marker < 0) continue
    const result = JSON.parse(line.slice(marker + 5))
    if (!result.scenario || !Number.isFinite(result.medianMs) || result.medianMs < 0) {
      throw new Error(`Invalid measurement in ${file}`)
    }
    const entry = scenarios.get(result.scenario) ?? { baseline: [], candidate: [] }
    entry[match[1]].push({ round: Number(match[2]), medianMs: result.medianMs })
    scenarios.set(result.scenario, entry)
  }
}
if (!scenarios.size) throw new Error('No performance measurements found')
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const summary = []
console.log('Five alternating runs per revision on one runner; synthetic data only.\n')
console.log('```')
console.log(readFileSync(join(directory, 'revisions.txt'), 'utf8').trim())
console.log('```\n')
console.log('| Scenario | Baseline ms | Candidate ms | Change |')
console.log('| --- | ---: | ---: | ---: |')
for (const [scenario, runs] of scenarios) {
  for (const variant of ['baseline', 'candidate']) {
    if (runs[variant].length !== 5 || new Set(runs[variant].map((r) => r.round)).size !== 5) {
      throw new Error(`Expected five distinct ${variant} rounds for ${scenario}`)
    }
  }
  const baseline = median(runs.baseline.map((r) => r.medianMs))
  const candidate = median(runs.candidate.map((r) => r.medianMs))
  const changePercent = baseline ? (candidate / baseline - 1) * 100 : null
  summary.push({ scenario, baseline, candidate, changePercent, runs })
  console.log(`| ${scenario} | ${baseline.toFixed(3)} | ${candidate.toFixed(3)} | ${changePercent?.toFixed(1) ?? 'n/a'}% |`)
}
writeFileSync(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log('\nTimings are evidence for review, not a flaky wall-clock test gate. Correctness assertions run in every benchmark.')
