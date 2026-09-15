import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
const rows = readFileSync(join(root, 'results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
const median = values => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const versions = ['two-weeks', 'one-week', 'baseline', 'candidate']
const groups = new Map()
for (const row of rows.filter(row => row.scenario === 'plan-after-reload' || row.sample > 0)) {
  const key = [row.size, row.scenario, row.direction].join('/')
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(row)
}
const summaries = []
for (const [key, samples] of groups) {
  const revisions = {}
  for (const revision of versions) {
    const selected = samples.filter(row => row.revision === revision)
    const expected = key.includes('/plan-after-reload/') ? 4 : 6
    if (selected.length !== expected || new Set(selected.map(row => row.round)).size !== 2) {
      throw Error(`Incomplete measurements for ${key}/${revision}: ${selected.length} samples`)
    }
    const metrics = {}
    for (const field of ['openMs', 'operationMs', 'housekeepingMs', 'nativeMs', 'storeMs', 'revealMs', 'totalMs', 'responseBytes']) {
      const values = selected.map(row => row[field]).filter(value => typeof value === 'number')
      if (values.length) metrics[field] = { median: median(values), samples: values,
        roundMedians: ['1', '2'].map(round => median(selected.filter(row => row.round === round).map(row => row[field]))) }
    }
    revisions[revision] = metrics
  }
  summaries.push({ key, revisions })
}
writeFileSync(join(root, 'summary.json'), JSON.stringify(summaries, null, 2) + '\n')
const lines = [
  '# Undo comparison', '',
  'Median milliseconds, excluding the first sample in each round except for full-state reloads (two samples per round). Each revision ran on the same macOS runner under CPU contention.', '',
  '| Fixture / scenario / direction | Sept 1 | Sept 8 | Sept 15 baseline | Candidate |',
  '|---|---:|---:|---:|---:|',
]
for (const { key, revisions } of summaries) {
  lines.push(`| ${key} | ${versions.map(version => revisions[version].totalMs.median.toFixed(1)).join(' | ')} |`)
}
lines.push('', 'Store totals include the synthetic native bridge; rendered scenarios include the actual app keyboard handler and two animation frames. Native operation and database-open timings are recorded separately in summary.json. This is a debug/test-profile comparison, not installed-app latency.', '')
writeFileSync(join(root, 'summary.md'), lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'))
console.log(lines.join('\n'))
