import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'

const out = 'artifacts/retro-profile'
mkdirSync(out, { recursive: true })
const experiments = (process.env.EXPERIMENTS ?? 'baseline,sidebar-style,sidebar-layout,sidebar-layer,header-layer,panel-style,panel-layout,workspace-style').split(',')
const rounds = Number(process.env.ROUNDS ?? 3)
let failed = false
for (let round = 0; round < rounds; round++) {
  const order = round % 2 ? [...experiments].reverse() : experiments
  for (const experiment of order) {
    const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.interaction-performance.config.ts', '--project', 'mac-desktop-6x-cpu', '--grep', 'common typing', '--trace', 'off'], {
      env: { ...process.env, BALANCE_RETRO_EXPERIMENT: experiment }, encoding: 'utf8', timeout: 400_000, maxBuffer: 20 * 1024 * 1024,
    })
    const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    writeFileSync(`${out}/${experiment}-${round}.log`, log)
    console.log(`${experiment} round ${round + 1}: ${result.status}`)
    const line = log.split('\n').find(line => line.startsWith('INTERACTION_PERF '))
    if (result.status !== 0 || !line) { console.log(log); failed = true; continue }
    const row = { round: round + 1, ...JSON.parse(line.slice('INTERACTION_PERF '.length)) }
    appendFileSync(`${out}/results.jsonl`, JSON.stringify(row) + '\n')
    console.log(JSON.stringify(row))
    // Playwright clears its output directory on every invocation.
    const copy = spawnSync('cp', ['-R', 'artifacts/playwright-interaction-performance', `${out}/${experiment}-${round}-attachments`])
    if (copy.status !== 0) throw new Error('Failed to preserve profile attachments')
  }
}
if (failed) process.exitCode = 1
