// Compares `pnpm tauri dev` with a release build of the real macOS app on CI:
// real key events, an encrypted synthetic database, idle and under CPU load.
// This deletes Balance's data and keychain entries, so it refuses to run
// anywhere but a disposable CI runner.

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('This profile deletes the app database and only runs on CI.')
}

const results = resolve(process.argv[2] ?? 'artifacts/tauri-typing')
const rounds = Number(process.env.BALANCE_TYPING_PROFILE_ROUNDS) || 6
const launchTimeoutMs = 15 * 60_000
const firstLaunchTimeoutMs = 30 * 60_000
const dataDirectory = join(homedir(), 'Library/Application Support/Balance')
mkdirSync(results, { recursive: true })

const commands = {
  dev: ['pnpm', ['tauri', 'dev', '--no-watch', '--features', 'typing-profile']],
  release: [resolve('src-tauri/target/release/Balance'), []],
}

function clearApp() {
  spawnSync('pkill', ['-f', 'BalanceWidgetDevBridge'])
  spawnSync('pkill', ['-f', 'target/(debug|release)/Balance'])
  spawnSync('pkill', ['-f', 'vite'])
  rmSync(dataDirectory, { recursive: true, force: true })
  while (spawnSync('security', ['delete-generic-password', '-s', 'app.balance.local'], { stdio: 'ignore' }).status === 0);
}

function startLoad() {
  const count = availableParallelism() * 4
  return Array.from({ length: count }, () => spawn('sh', ['-c', 'while :; do :; done'], { stdio: 'ignore' }))
}

async function launch(variant, label, timeoutMs) {
  clearApp()
  await delay(2_000)
  const output = join(results, `${label}.json`)
  const log = join(results, `${label}.log`)
  rmSync(output, { force: true })
  const [command, args] = commands[variant]
  const child = spawn(command, args, {
    detached: true,
    env: { ...process.env, BALANCE_TYPING_PROFILE_OUTPUT: output },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let exited = false
  child.once('exit', () => { exited = true })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => appendFileSync(log, chunk))

  const started = Date.now()
  const screenshot = () => spawnSync('screencapture', ['-x', join(results, `${label}.png`)])
  let lastScreenshot = started
  while (!existsSync(output) && !exited && Date.now() - started < timeoutMs) {
    await delay(500)
    // Screenshots stall the window server, so only unmeasured launches take them.
    if (label.startsWith('warmup') && Date.now() - lastScreenshot > 15_000) {
      screenshot()
      lastScreenshot = Date.now()
    }
  }
  await delay(1_000)
  if (!exited) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  }
  if (!existsSync(output)) screenshot()
  if (!existsSync(output)) throw new Error(`${label}: no report after ${Math.round((Date.now() - started) / 1000)}s; see ${log}`)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  if (report.error) throw new Error(`${label}: ${report.error} ${JSON.stringify(report.consoleErrors)}`)
  if (report.theme !== 'graphite') throw new Error(`${label}: ran with theme ${report.theme}`)
  if (report.untrustedKeys) throw new Error(`${label}: ${report.untrustedKeys} untrusted key events`)
  return report
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

const median = (values) => percentile(values, 0.5)
const metrics = {
  'Key to screen, 30-line note': (report) => report.typing.small.latencyMs,
  'Key to screen, 150-line note': (report) => report.typing.medium.latencyMs,
  'Key to screen, 1,000-line note': (report) => report.typing.large.latencyMs,
  'Page work per key, 30-line note': (report) => report.typing.small.scriptMs,
  'Page work per key, 1,000-line note': (report) => report.typing.large.scriptMs,
  'Enter, 1,000-line note': (report) => report.enter.latencyMs,
  'Open 150-line note': (report) => report.switchMs.medium,
  'Open 1,000-line note': (report) => report.switchMs.large,
  'Save, 30-line note': (report) => report.typing.small.persistMs,
  'Save, 1,000-line note': (report) => report.typing.large.persistMs,
  'Last key to saved, 1,000-line note': (report) => [report.typing.large.saveLagMs],
  'Reload to usable': (report) => [report.reloadMs],
}

function summarize(runs) {
  const rows = []
  for (const load of ['idle', 'loaded']) {
    for (const [name, read] of Object.entries(metrics)) {
      const launches = (variant) => runs.filter((run) => run.variant === variant && run.load === load)
      const launchMedian = (run) => median(read(run.report))
      const side = (variant) => {
        const medians = launches(variant).map(launchMedian)
        const pooled = launches(variant).flatMap((run) => read(run.report))
        return { median: median(medians), low: Math.min(...medians), high: Math.max(...medians), p95: percentile(pooled, 0.95), count: pooled.length }
      }
      // Each round's dev launch is paired with its release launch, run back to back.
      const ratios = launches('dev').map((run) => {
        const pair = launches('release').find((candidate) => candidate.round === run.round)
        return launchMedian(run) / launchMedian(pair)
      })
      rows.push({
        load,
        name,
        dev: side('dev'),
        release: side('release'),
        ratio: median(ratios),
        ratioLow: Math.min(...ratios),
        ratioHigh: Math.max(...ratios),
        slowerRounds: ratios.filter((ratio) => ratio > 1).length,
      })
    }
  }
  return rows
}

function markdown(rows) {
  const ms = (value) => `${Math.round(value)} ms`
  const lines = [
    '## `pnpm tauri dev` vs release',
    '',
    `${rounds} back-to-back pairs of launches in alternating order, Graphite theme, real key events every 130 ms, 150 background notes, encrypted synthetic database. Dev and release cells are the median launch and the range of launch medians. Dev ÷ release is the median of the paired ratios, with their range.`,
  ]
  for (const load of ['idle', 'loaded']) {
    lines.push('', `### ${load === 'idle' ? 'Idle runner' : `CPU load (${availableParallelism() * 4} busy processes on ${availableParallelism()} cores)`}`, '')
    lines.push('| | Dev | Release | Dev ÷ release | Pairs where dev was slower | Dev p95 | Release p95 |', '|---|---|---|---|---|---|---|')
    for (const row of rows.filter((candidate) => candidate.load === load)) {
      const cell = ({ median, low, high }) => `${ms(median)} (${Math.round(low)}–${Math.round(high)})`
      lines.push(`| ${row.name} | ${cell(row.dev)} | ${cell(row.release)} | ${row.ratio.toFixed(2)}× (${row.ratioLow.toFixed(2)}–${row.ratioHigh.toFixed(2)}) | ${row.slowerRounds}/${rounds} | ${ms(row.dev.p95)} | ${ms(row.release.p95)} |`)
    }
  }
  return `${lines.join('\n')}\n`
}

// The first launches build dev and warm Vite's caches; they are not measured.
await launch('dev', 'warmup-dev', firstLaunchTimeoutMs)
await launch('release', 'warmup-release', launchTimeoutMs)

const runs = []
for (let round = 1; round <= rounds; round += 1) {
  const order = round % 2 ? ['dev', 'release'] : ['release', 'dev']
  for (const load of ['idle', 'loaded']) {
    for (const variant of order) {
      const processes = load === 'loaded' ? startLoad() : []
      try {
        const label = `round${round}-${load}-${variant}`
        console.log(`Measuring ${label}`)
        runs.push({ variant, load, round, report: await launch(variant, label, launchTimeoutMs) })
      } finally {
        for (const process of processes) process.kill('SIGKILL')
      }
      await delay(5_000)
    }
  }
}
clearApp()

const rows = summarize(runs)
const summary = markdown(rows)
writeFileSync(join(results, 'summary.json'), JSON.stringify(rows, null, 2))
writeFileSync(join(results, 'summary.md'), summary)
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
