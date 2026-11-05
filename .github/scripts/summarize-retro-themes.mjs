import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2] ?? 'artifacts/retro-profile'
function find(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? find(join(dir, entry.name)) : entry.name === 'results.jsonl' ? [join(dir, entry.name)] : [])
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const groups = new Map()
for (const file of find(directory)) {
  const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const row of rows) {
    const key = `${file}:${row.revision ?? "candidate"}:${row.experiment}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
}
if (!groups.size) throw new Error('No successful profile measurements')
const summary = [...groups].map(([key, rows]) => ({
  source: key.slice(0, key.lastIndexOf(':')),
  revision: rows[0].revision ?? 'candidate',
  experiment: rows[0].experiment,
  theme: rows[0].fixture.themeId,
  tasks: rows[0].fixture.planItems + rows[0].fixture.listItems,
  runs: rows.length,
  visuallyIdentical: rows.every(row => row.visuallyIdentical),
  metrics: Object.fromEntries([
    ['typingMedianMs', row => row.typing.paint.medianMs],
    ['typingP95Ms', row => row.typing.paint.p95Ms],
    ['backspaceMedianMs', row => row.backspacing.paint.medianMs],
    ['checkboxMedianMs', row => row.checkboxClick.paint.medianMs],
    ['focusMedianMs', row => row.taskFocus.paint.medianMs],
    ['scriptMs', row => row.rendererDelta.ScriptDuration * 1000],
    ['layoutMs', row => row.rendererDelta.LayoutDuration * 1000],
    ['styleMs', row => row.rendererDelta.RecalcStyleDuration * 1000],
    ['workspaceReadyMs', row => row.workspaceReadyMs],
  ].map(([metric, get]) => [metric, median(rows.map(get).filter(Number.isFinite))])),
}))
writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log('| Theme | Tasks | Experiment | Pixels match | Typing ms | p95 ms | Backspace ms | Checkbox ms | Script ms | Style ms |')
console.log('|---|---:|---|---|---:|---:|---:|---:|---:|---:|')
for (const row of summary) {
  const m = row.metrics
  console.log(`| ${row.theme} | ${row.tasks} | ${row.revision}/${row.experiment} | ${row.visuallyIdentical} | ${m.typingMedianMs?.toFixed(1)} | ${m.typingP95Ms?.toFixed(1)} | ${m.backspaceMedianMs?.toFixed(1)} | ${m.checkboxMedianMs?.toFixed(1)} | ${m.scriptMs?.toFixed(1)} | ${m.styleMs?.toFixed(1)} |`)
}
