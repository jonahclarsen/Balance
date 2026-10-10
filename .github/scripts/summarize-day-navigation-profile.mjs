// Summarizes the alternating runs written by tests/performance/day-navigation.spec.ts
// as Markdown: per-browser medians across rounds, then Chromium CPU hotspots.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('Usage: summarize-day-navigation-profile.mjs <report directory>')

function reports(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return reports(path)
    return name.endsWith('.json') ? [JSON.parse(readFileSync(path, 'utf8'))] : []
  })
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const all = reports(root)
const groups = new Map()
for (const report of all) {
  const key = `${report.project}\u0000${report.revision}`
  groups.set(key, [...(groups.get(key) ?? []), report])
}

console.log('| Browser | Revision | Runs | Painted median (ms) | Painted p95 (ms) | Script (ms) | Style (ms) | Layout (ms) | Heap (MiB) | DOM nodes |')
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const [key, runs] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
  const [project, revision] = key.split('\u0000')
  const renderer = (field) => runs[0].renderer ? median(runs.map((run) => run.renderer[field] / run.steps)).toFixed(1) : '–'
  console.log(`| ${project} | ${revision} | ${runs.length} | ${median(runs.map((run) => run.paint.medianMs)).toFixed(1)} | ${median(runs.map((run) => run.paint.p95Ms)).toFixed(1)} | ${renderer('scriptMs')} | ${renderer('recalcStyleMs')} | ${renderer('layoutMs')} | ${runs[0].retainedMemory ? (median(runs.map((run) => run.retainedMemory.heapBytes)) / 1024 / 1024).toFixed(1) : '–'} | ${runs[0].retainedMemory ? median(runs.map((run) => run.retainedMemory.nodes)) : '–'} |`)
}
console.log('\nScript, style and layout are Chromium renderer time per measured navigation. In the hotspot tables, style and layout forced by a script appear as that function\'s self time.')

for (const revision of ['baseline', 'candidate']) {
  const runs = all.filter((report) => report.revision === revision && report.cpu)
  if (runs.length === 0) continue
  const totals = new Map()
  for (const run of runs) {
    for (const entry of run.cpu.selfTop) totals.set(entry.name, (totals.get(entry.name) ?? 0) + entry.ms / run.steps / runs.length)
  }
  console.log(`\n### ${revision}: Chromium self time per measured navigation\n`)
  console.log('| ms | Function |')
  console.log('| ---: | --- |')
  for (const [name, ms] of [...totals].sort((left, right) => right[1] - left[1]).slice(0, 15)) {
    console.log(`| ${ms.toFixed(2)} | \`${name}\` |`)
  }
}
