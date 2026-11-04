/** Disposable CI emulators only; fixture apps and local synthetic rules. */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { defaults, validate } from '../../src/lib/situate/core.ts'
const pkg = 'app.balance.local'
const service = `${pkg}/app.balance.local.SituateAccessibility`
const blocked = 'app.balance.fixture.blocked'
const allowed = 'app.balance.fixture.allowed'
const scenario = process.env.BALANCE_SITUATE_SCENARIO
const repeats = Number(process.env.BALANCE_SITUATE_REPEATS || 20)
const initialSeed = Number(process.env.BALANCE_SITUATE_SEED || 31)
let seed = initialSeed
const results = []
const canonicalRules = 'situate/rules.json'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function adb(args, options = {}) {
  try { return execFileSync('adb', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, ...options }).trim() }
  catch (error) { if (options.allowFailure) return ''; throw error }
}
assert(process.env.CI === 'true' && adb(['shell', 'getprop', 'ro.kernel.qemu']) === '1', 'CI emulator required')
const shell = (...args) => adb(['shell', ...args])
const platform = { sdk: Number(shell('getprop', 'ro.build.version.sdk')), pageSize: Number(shell('getconf', 'PAGESIZE')) }
if (process.env.BALANCE_SITUATE_PAGES === '16k') assert.equal(platform.pageSize, 16384, '16KB test kernel required')
const marker = (name, present) => adb(['shell', 'run-as', pkg, present ? 'touch' : 'rm', ...(present ? [] : ['-f']), `files/${name}`], { allowFailure: !present })
const bound = () => /Bound services:.*Situate app blocking/.test(shell('dumpsys', 'accessibility'))
const windows = () => shell('dumpsys', 'window', 'windows')
function visibleWindow(title) {
  return windows().split(/(?=^  Window #)/m).some(block => block.split('\n')[0].includes(title) &&
    ['mHasSurface=true', 'mDrawState=HAS_DRAWN', 'isVisible=true', 'mObscured=false'].every(value => block.includes(value)))
}
const gate = () => visibleWindow('Situate app boundary')
async function waitFor(predicate, label, timeout = 12000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { if (predicate()) return Date.now() - started; await sleep(250) }
  throw new Error(`${label} did not settle within ${timeout}ms`)
}
async function stable(expected, label) {
  await waitFor(() => gate() === expected, label)
  // Include several policy ticks to catch a gate resurrecting over an allowed app.
  for (let i = 0; i < 4; i++) { await sleep(550); assert.equal(gate(), expected, label) }
}
function launchPlanner(extras = []) { shell('am', 'start', '-W', '-f', '0x30000000', '-n', `${pkg}/app.balance.local.SituatePlannerFixture`, ...extras) }
function launch(target, extras = []) {
  shell('am', 'start', '-W', '-n', `${target}/app.balance.fixture.FixtureActivity`, ...extras)
}
function rules(state = 'on', until = 0) {
  const now = Number(shell('date', '+%s')) * 1000
  const target = { id: 'fixture', kind: 'app', value: blocked, category: 'custom' }
  const doc = { ...defaults(now), revision: now, generatedAt: now - 10000, manual: { fixture: now - 10000 }, epochs: [], windows: [],
    modes: [{ id: 'fixture', name: 'Synthetic boundary', description: '', color: '#8040c0', dayQuiz: [], nightQuiz: [], platforms: ['android'], scheduled: false, targets: [target] }],
    grants: state === 'off' ? [{ mode: 'fixture', epoch: now, until: until || now + 3600000 }] : [] }
  validate(doc)
  // Mirror the app's canonical local rules as well: a real planner relaunch must
  // load this fixture instead of restoring the original default modes over it.
  if (canonicalRules) {
    adb(['shell', 'run-as', pkg, 'tee', canonicalRules + '.ci.tmp'], { input: JSON.stringify(doc) })
    shell('run-as', pkg, 'mv', canonicalRules + '.ci.tmp', canonicalRules)
  }
  adb(['shell', 'run-as', pkg, 'tee', 'no_backup/situate-ci-stress.tmp'], { input: JSON.stringify(doc) })
  shell('run-as', pkg, 'mv', 'no_backup/situate-ci-stress.tmp', 'no_backup/situate-rules.json')
}
function diagnostics(label) {
  writeFileSync(`situate-stress-${label}-rules.json`, adb(['shell', 'run-as', pkg, 'cat', 'no_backup/situate-rules.json'], { allowFailure: true }))
  for (const kind of ['accessibility', 'window', 'activity', 'power', 'deviceidle', 'usagestats']) {
    const content = adb(['shell', 'dumpsys', kind], { allowFailure: true })
    writeFileSync(`situate-stress-${label}-${kind}.txt`, content)
  }
  writeFileSync(`situate-stress-${label}-logcat.txt`, adb(['logcat', '-d', '-s', 'BalanceSituate:I', 'AndroidRuntime:E', '*:S'], { allowFailure: true }))
}
async function check(name, run) {
  const started = Date.now()
  try {
    // Start each case from a settled allowed app. A gate left by the previous
    // case must not satisfy the next case's initial blocked-app assertion while
    // Android is still completing an earlier activity transition.
    marker('situate-ci-drop-events', false)
    shell('appops', 'set', pkg, 'GET_USAGE_STATS', 'allow')
    rules('off'); launch(allowed); await stable(false, 'case starts on an allowed app')
    await run(); results.push({ name, passed: true, ms: Date.now() - started }); console.log(`PASS ${name}`) }
  catch (error) { results.push({ name, passed: false, error: String(error), ms: Date.now() - started }); console.log(`FAIL ${name}: ${error}`); diagnostics(name) }
  finally { marker('situate-ci-drop-events', false); writeFileSync('situate-stress-results.json', JSON.stringify({ scenario, seed: initialSeed, repeats, platform, results }, null, 2)) }
}
async function enable() { shell('settings', 'put', 'secure', 'enabled_accessibility_services', service); shell('settings', 'put', 'secure', 'accessibility_enabled', '1'); await waitFor(bound, 'accessibility bind', 25000) }
async function restart() {
  const monitor = pkg + ':situate'
  const previous = shell('pidof', monitor).split(' ')[0]
  assert(previous, 'missing app process')
  shell('kill', '-9', previous)
  await waitFor(() => { const pid = adb(['shell', 'pidof', monitor], { allowFailure: true }); return pid && !pid.split(' ').includes(previous) && bound() }, 'automatic process/service restart', 30000)
}
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
try {
  adb(['root'], { allowFailure: true })
  await waitFor(() => adb(['shell', 'id', '-u'], { allowFailure: true }) === '0', 'rooted emulator after adbd restart', 30000)
  for (const apk of ['balance-debug.apk', 'situate-allowed.apk', 'situate-blocked.apk']) adb(['install', '-r', apk], { timeout: 60000 })
  shell('run-as', pkg, 'mkdir', '-p', 'files', 'no_backup', 'situate')
  rules('off'); launchPlanner()
  shell('input', 'keyevent', 'KEYCODE_HOME')
  marker('situate-ci-trace', true)
  // Same permissions a user can grant. The baseline has no independent detector.
  shell('appops', 'set', pkg, 'GET_USAGE_STATS', 'allow')
  shell('appops', 'set', pkg, 'SCHEDULE_EXACT_ALARM', 'deny')
  shell('settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1')
  rules('off'); await enable()
  if (scenario === 'restart') {
    await check('rebind-over-already-open-target', async () => {
      rules('on'); launch(blocked); await waitFor(gate, 'initial gate')
      shell('settings', 'put', 'secure', 'enabled_accessibility_services', 'null'); await waitFor(() => !gate(), 'gate removal')
      await enable(); await waitFor(gate, 'gate after rebind without relaunch')
    })
    await check('planner-process-deaths-keep-blocker-alive', async () => {
      rules('on')
      for (let i = 0; i < Math.min(repeats, 10); i++) {
        launchPlanner()
        launch(blocked); await waitFor(gate, `gate before planner death ${i}`)
        const planner = shell('pidof', pkg).split(' ')[0]
        const monitor = adb(['shell', 'pidof', pkg + ':situate'], { allowFailure: true })
        assert(monitor && !monitor.split(' ').includes(planner), 'blocker must not share the planner process')
        shell('kill', '-9', planner)
        await stable(true, `gate survives planner death ${i}`)
        assert.equal(shell('pidof', pkg + ':situate'), monitor, 'blocker process changed with planner')
      }
    })
    await check('blocking-process-death-over-target', async () => {
      rules('on'); launch(allowed); launch(blocked); await waitFor(gate, 'initial gate')
      await restart(); await waitFor(gate, 'gate after blocker process restart')
    })
    await check('process-death-over-allowed-app', async () => {
      launchPlanner()
      launch(allowed); await stable(false, 'allowed app before death')
      shell('kill', '-9', shell('pidof', pkg).split(' ')[0]); await stable(false, 'allowed app after death')
      launch(blocked); await waitFor(gate, 'blocking after restart')
    })
  } else if (scenario === 'event-loss') {
    await check('lost-switch-into-blocked-app', async () => {
      rules('on'); launch(allowed); await stable(false, 'initial allowed app'); marker('situate-ci-drop-events', true)
      launch(blocked); await waitFor(gate, 'independent detection of blocked app')
    })
    await check('lost-switch-out-of-blocked-app', async () => {
      rules('on'); launch(allowed); await stable(false, 'allowed before blocked transition'); launch(blocked); await stable(true, 'initial gate'); marker('situate-ci-drop-events', true)
      launch(allowed); await stable(false, 'independent detection of allowed app')
    })
    await check('lost-home-and-balance-switch', async () => {
      rules('on'); launch(allowed); await stable(false, 'allowed before blocked transition'); launch(blocked); await stable(true, 'initial gate'); marker('situate-ci-drop-events', true)
      shell('input', 'keyevent', 'KEYCODE_HOME'); await stable(false, 'Home without event')
      launchPlanner(); await stable(false, 'Balance without event')
    })
    await check('delayed-planner-resume-does-not-clear-gate', async () => {
      rules('on'); shell('am', 'force-stop', blocked)
      launchPlanner(['--ez', 'late_resume', 'true']); launch(blocked); await waitFor(gate, 'gate before delayed acknowledgement')
      marker('situate-ci-drop-events', true); await sleep(5500)
      await stable(true, 'stale legitimate resume cannot clear a blocked app')
    })
    await check('foreign-app-cannot-dismiss-gate-through-private-channel', async () => {
      rules('on'); launch(allowed); shell('am', 'force-stop', blocked); launch(blocked, ['--ez', 'spoof_resume', 'true'])
      await stable(true, 'untrusted app cannot announce Balance resumed')
    })
    await check('permission-revocation-keeps-accessibility-working', async () => {
      rules('on')
      shell('appops', 'set', pkg, 'GET_USAGE_STATS', 'deny'); launch(allowed); await stable(false, 'allowed without usage access')
      launch(blocked); await waitFor(gate, 'accessibility-only gate'); shell('appops', 'set', pkg, 'GET_USAGE_STATS', 'allow')
    })
  } else if (scenario === 'navigation') {
    await check('seeded-app-and-rule-transitions', async () => {
      for (let i = 0; i < repeats * 5; i++) {
        const on = random() > 0.35; const target = random() > 0.4 ? blocked : allowed
        rules(on ? 'on' : 'off'); launch(target)
        await waitFor(() => gate() === (on && target === blocked), `transition ${i}: ${target} ${on}`)
        if (i % 7 === 0) { shell('input', 'keyevent', 'KEYCODE_HOME'); await stable(false, `Home ${i}`) }
      }
    })
    await check('keyboard-does-not-replace-app-identity', async () => {
      rules('off'); shell('am', 'force-stop', blocked); launch(blocked, ['--ez', 'keyboard', 'true'])
      await waitFor(() => visibleWindow('InputMethod'), 'real software keyboard')
      rules('on'); await waitFor(gate, 'gate over keyboard')
      shell('am', 'force-stop', allowed); launch(allowed, ['--ez', 'keyboard', 'true'])
      await stable(false, 'allowed app with keyboard'); await waitFor(() => visibleWindow('InputMethod'), 'allowed app software keyboard')
    })
    await check('late-pane-events-do-not-reblock-allowed-app', async () => {
      rules('off'); shell('am', 'force-stop', blocked); launch(blocked, ['--ez', 'late_pane', 'true']); launch(allowed); rules('on'); await stable(false, 'late background pane')
    })
    await check('slow-main-thread-does-not-latch-stale-gate', async () => {
      launchPlanner(); rules('on'); launch(blocked); await waitFor(gate, 'initial gate')
      const pid = shell('pidof', pkg).split(' ')[0]
      try { shell('kill', '-STOP', pid); launch(allowed); await stable(false, 'blocking process works while planner is stalled') }
      finally { shell('kill', '-CONT', pid) }
      await stable(false, 'allowed after stalled callbacks'); launch(blocked); await waitFor(gate, 'gate after stall')
    })
  } else if (scenario === 'idle') {
    await check('pass-expires-during-forced-doze', async () => {
      const until = Number(shell('date', '+%s')) * 1000 + 30000
      rules('off', until); launch(blocked); await stable(false, 'pass before idle')
      shell('input', 'keyevent', 'KEYCODE_SLEEP'); shell('dumpsys', 'battery', 'unplug')
      shell('dumpsys', 'deviceidle', 'force-idle'); await sleep(60000)
      shell('dumpsys', 'deviceidle', 'unforce'); shell('input', 'keyevent', 'KEYCODE_WAKEUP'); shell('wm', 'dismiss-keyguard')
      await waitFor(gate, 'gate after idle expiry')
    })
    await check('restricted-standby-ten-minute-background', async () => {
      rules('on'); launch(allowed); await stable(false, 'allowed before background')
      shell('am', 'set-standby-bucket', pkg, 'restricted'); shell('appops', 'set', pkg, 'RUN_ANY_IN_BACKGROUND', 'ignore')
      await sleep(600000)
      launch(blocked); await waitFor(gate, 'blocking after restricted background')
      rules('off'); await stable(false, 'off after restricted background')
    })
  } else throw new Error(`Unknown scenario: ${scenario}`)
} finally {
  for (const command of [ ['dumpsys', 'deviceidle', 'unforce'], ['dumpsys', 'battery', 'reset'], ['appops', 'set', pkg, 'RUN_ANY_IN_BACKGROUND', 'allow'], ['am', 'set-standby-bucket', pkg, 'active'] ]) {
    adb(['shell', ...command], { allowFailure: true })
  }
  marker('situate-ci-drop-events', false)
  diagnostics('final')
}
assert(results.length && results.every(result => result.passed), `${results.filter(result => !result.passed).length} Situate cases failed`)
