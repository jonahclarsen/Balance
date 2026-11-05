import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const out = resolve('artifacts/retro-profile')
mkdirSync(out, { recursive: true })
const experiments = (process.env.EXPERIMENTS || 'baseline,sidebar-no-blur,header-no-blur,sidebar-style,sidebar-layout,sidebar-layer,header-layer,panel-style,panel-layout,workspace-style').split(',')
const rounds = Number(process.env.ROUNDS || 3)
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('Rounds must be between 1 and 10')
const variants = process.env.BASELINE_DIR
  ? [{ revision: 'baseline', cwd: process.env.BASELINE_DIR }, { revision: 'candidate', cwd: process.cwd() }]
  : [{ revision: 'candidate', cwd: process.cwd() }]
const env = { ...process.env, BALANCE_INTERACTION_PERF_PREBUILT: '1' }
if (env.BALANCE_INTERACTION_PERF_RELEASE === '1') {
  for (const variant of variants) {
    const result = spawnSync('pnpm', ['exec', 'vite', 'build'], { cwd: variant.cwd, env: { ...env, VITE_BALANCE_START_VIEW: 'today', VITE_BALANCE_SKIP_SEED_GOALS: '1' }, encoding: 'utf8' })
    writeFileSync(`${out}/${variant.revision}-build.log`, `${result.stdout}\n${result.stderr}`)
    if (result.status !== 0) throw new Error(`Build failed for ${variant.revision}`)
  }
}
function appearance(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) { const found = appearance(path); if (found) return found }
    else if (entry.name === 'appearance.png') return path
  }
}
const screenshots = new Map()
let failed = false
for (let round = 0; round < rounds; round++) {
  const order = round % 2 ? [...experiments].reverse() : experiments
  const revisions = round % 2 ? [...variants].reverse() : variants
  for (const experiment of order) for (const variant of revisions) {
    const label = `${variant.revision}-${experiment}-${round}`
    const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.interaction-performance.config.ts', '--project', 'mac-desktop-6x-cpu', '--grep', 'common typing', '--trace', 'off'], {
      cwd: variant.cwd, env: { ...env, BALANCE_RETRO_EXPERIMENT: experiment }, encoding: 'utf8', timeout: 400_000, maxBuffer: 20 * 1024 * 1024,
    })
    const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    writeFileSync(`${out}/${label}.log`, log)
    console.log(`${label}: ${result.status}`)
    cpSync(resolve(variant.cwd, 'artifacts/playwright-interaction-performance'), `${out}/${label}-attachments`, { recursive: true })
    const line = log.split('\n').find(line => line.startsWith('INTERACTION_PERF '))
    if (result.status !== 0 || !line) { console.log(log); failed = true; continue }
    const imagePath = appearance(`${out}/${label}-attachments`)
    if (!imagePath) throw new Error('Missing appearance screenshot')
    const pairKey = `${experiment}-${round}`
    const held = screenshots.get(pairKey)
    if (held) {
      const identical = readFileSync(held).equals(readFileSync(imagePath))
      appendFileSync(`${out}/appearance-comparisons.jsonl`, JSON.stringify({ experiment, round: round + 1, identical }) + '\n')
      if (!identical) console.log(`APPEARANCE_MISMATCH ${pairKey}`)
    } else screenshots.set(pairKey, imagePath)
    const row = { revision: variant.revision, round: round + 1, ...JSON.parse(line.slice('INTERACTION_PERF '.length)) }
    appendFileSync(`${out}/results.jsonl`, JSON.stringify(row) + '\n')
    console.log(JSON.stringify(row))
    // Attachments above are preserved even on failures, before the next run clears them.
  }
}
if (failed) process.exitCode = 1
