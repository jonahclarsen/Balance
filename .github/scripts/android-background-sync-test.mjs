// CI emulator only: the smoke test has created an isolated synthetic database.
// Registration alone misses workers that never schedule their next pass.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { adb, appPid, findWorkManagerJobIds, packageName, waitFor } from './android-sync-profile-helpers.mjs'

assert(process.env.CI, 'Run this test only against the disposable CI emulator')
const sdk = Number(adb(['shell', 'getprop', 'ro.build.version.sdk']).trim())
const namespaceArgs = sdk >= 34 ? ['-n', 'androidx.work.systemjobscheduler'] : []
const marker = 'Background relay sync and widget refresh completed'
const completions = () => adb(['logcat', '-d', '-s', 'BalanceBackgroundSync:I'])
  .split('\n').filter((line) => line.includes(marker)).length

try {
  let job = await waitFor(() => findWorkManagerJobIds()[0], 'the first background sync job')
  for (let pass = 0; pass < 2; pass += 1) {
    const before = completions()
    await waitFor(() => {
      if (completions() > before) return true
      // A cold WorkManager reconciles OS jobs during initialization and can
      // replace the job we just forced. Force its registered replacement too;
      // this test deliberately advances the five-minute delay, not app startup.
      for (const candidate of findWorkManagerJobIds()) {
        const output = adb(
          ['shell', 'cmd', 'jobscheduler', 'run', '-f', ...namespaceArgs, packageName, candidate],
          { allowFailure: true },
        )
        if (output.includes('Running job')) { job = candidate; break }
      }
      return false
    }, `background pass ${pass + 1} to finish`, 60_000, 1_000)
    // A new OS job proves that the successor was persisted and unblocked when
    // this worker finished. An alarm alone cannot satisfy this assertion.
    const next = await waitFor(
      () => findWorkManagerJobIds().find((id) => id !== job),
      `background pass ${pass + 1} to schedule its successor`,
    )
    assert.notEqual(next, job)
    job = next
    if (pass === 0) {
      // Simulate cached-process reclamation, not force-stop (which disables jobs).
      await waitFor(() => {
        if (!appPid()) return true
        adb(['shell', 'am', 'kill', packageName])
        return !appPid()
      }, 'the cached app process to exit', 30_000, 500)
    }
  }
  console.log('[background-sync] Two passes completed without reopening Balance; each persisted its successor.')
} finally {
  await writeFile('background-sync-log.txt', adb(['logcat', '-d'], { allowFailure: true }))
  await writeFile('jobscheduler.txt', adb(['shell', 'dumpsys', 'jobscheduler'], { allowFailure: true }))
}
