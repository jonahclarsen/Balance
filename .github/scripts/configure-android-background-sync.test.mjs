import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)
const script = resolve('.github/scripts/configure-android-background-sync.mjs')

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

test('defers periodic relay sync while the Android activity is foregrounded', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'balance-background-sync-'))
  const gradle = join(fixture, 'app/build.gradle.kts')
  const worker = join(fixture, 'app/src/main/java/app/balance/local/BalanceSyncWorker.kt')
  const activity = join(fixture, 'app/src/main/java/app/balance/local/MainActivity.kt')

  try {
    await write(gradle, 'dependencies {\n}\n')
    await write(activity, 'package app.balance.local\n\nclass MainActivity : TauriActivity()\n')

    await execute(process.execPath, [script, gradle, worker, activity])
    await execute(process.execPath, [script, gradle, worker, activity])

    const configuredGradle = await readFile(gradle, 'utf8')
    assert.equal((configuredGradle.match(/androidx\.work:work-runtime:2\.10\.1/g) ?? []).length, 1)

    const configuredWorker = await readFile(worker, 'utf8')
    assert.match(configuredWorker, /if \(appForeground\)/)
    assert.match(configuredWorker, /cancelUniqueWork\(PERIODIC_NAME\)/)
    assert.match(configuredWorker, /setInitialDelay\(15, TimeUnit\.MINUTES\)/)
    assert.match(configuredWorker, /ExistingPeriodicWorkPolicy\.KEEP/)

    const configuredActivity = await readFile(activity, 'utf8')
    assert.equal((configuredActivity.match(/override fun onStart/g) ?? []).length, 1)
    assert.equal((configuredActivity.match(/override fun onStop/g) ?? []).length, 1)
    assert.equal(
      (configuredActivity.match(/BalanceSyncWorker\.enterForeground\(this\)/g) ?? []).length,
      1,
    )
    assert.equal(
      (configuredActivity.match(/BalanceSyncWorker\.enterBackground\(this\)/g) ?? []).length,
      1,
    )
    assert.doesNotMatch(configuredActivity, /BalanceSyncWorker\.schedule\(this\)/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
