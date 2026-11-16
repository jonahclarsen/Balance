import { readFileSync } from 'node:fs'

const samples = Object.fromEntries(['baseline', 'candidate'].map((variant) => [variant,
  [1, 2, 3].flatMap((round) => JSON.parse(readFileSync(`artifacts/idea-refinement-profile/round-${round}/${variant}.json`, 'utf8')).samples),
]))
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
console.log('\n18 measured sorts per revision, after warmup; same runner, 4× CPU throttle. Lower costs are better.\n')
console.log('| Metric (median) | Baseline | Candidate | Reduction |')
console.log('| --- | ---: | ---: | ---: |')
for (const metric of ['TaskDurationMs', 'ScriptDurationMs', 'LayoutDurationMs', 'RecalcStyleDurationMs', 'frameP95Ms', 'slowFrames', 'nodes']) {
  const baseline = median(samples.baseline.map((s) => s[metric]))
  const candidate = median(samples.candidate.map((s) => s[metric]))
  console.log(`| ${metric} | ${baseline.toFixed(2)} | ${candidate.toFixed(2)} | ${baseline ? ((1 - candidate / baseline) * 100).toFixed(1) : '0'}% |`)
}
