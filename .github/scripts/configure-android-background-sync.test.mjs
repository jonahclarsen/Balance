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

test('schedules Doze-safe five-minute and immediate relay sync while the activity is backgrounded', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'balance-background-sync-'))
  const gradle = join(fixture, 'app/build.gradle.kts')
  const worker = join(fixture, 'app/src/main/java/app/balance/local/BalanceSyncWorker.kt')
  const activity = join(fixture, 'app/src/main/java/app/balance/local/MainActivity.kt')
  const manifest = join(fixture, 'app/src/main/AndroidManifest.xml')

  try {
    await write(gradle, 'dependencies {\n}\n')
    await write(activity, 'package app.balance.local\n\nclass MainActivity : TauriActivity()\n')
    await write(manifest, '<manifest>\n    <application>\n    </application>\n</manifest>\n')

    await execute(process.execPath, [script, gradle, worker, activity, manifest])
    await execute(process.execPath, [script, gradle, worker, activity, manifest])

    const configuredGradle = await readFile(gradle, 'utf8')
    assert.equal((configuredGradle.match(/androidx\.work:work-runtime:2\.10\.1/g) ?? []).length, 1)

    const configuredWorker = await readFile(worker, 'utf8')
    assert.match(configuredWorker, /if \(appForeground\)/)
    assert.match(configuredWorker, /manager.activeNetwork == null/)
    assert.ok(configuredWorker.indexOf('if (offline) return Result.retry()') < configuredWorker.indexOf('if (runNativeSync'))
    assert.match(configuredWorker, /cancelUniqueWork\(SYNC_NAME\)/)
    assert.match(configuredWorker, /SYNC_DELAY_MINUTES = 5L/)
    assert.match(configuredWorker, /OneTimeWorkRequestBuilder<BalanceSyncWorker>/)
    assert.match(configuredWorker, /setInitialDelay\(delayMinutes, TimeUnit\.MINUTES\)/)
    assert.match(configuredWorker, /fun refreshNow\(context: Context\)/)
    assert.match(configuredWorker, /enqueue\(context, 0, ExistingWorkPolicy\.REPLACE, expedited = true\)/)
    // WorkManager alone waits for Doze maintenance windows, even for apps
    // exempt from battery optimization.
    assert.match(configuredWorker, /setAndAllowWhileIdle\(\s*AlarmManager\.ELAPSED_REALTIME_WAKEUP/)
    assert.match(configuredWorker, /setExpedited\(OutOfQuotaPolicy\.RUN_AS_NON_EXPEDITED_WORK_REQUEST\)/)
    assert.match(configuredWorker, /alarmManager\(context\)\?\.cancel\(alarmIntent\(context\)\)/)
    assert.match(configuredWorker, /scheduleNext\(applicationContext\)\n\s*Result\.success\(\)/)

    const configuredManifest = await readFile(manifest, 'utf8')
    assert.equal((configuredManifest.match(/RECEIVE_BOOT_COMPLETED/g) ?? []).length, 1)
    assert.equal((configuredManifest.match(/BalanceSyncAlarmReceiver" android:exported="false"/g) ?? []).length, 1)
    assert.match(configuredManifest, /BalanceSyncAlarmReceiver[\s\S]*BOOT_COMPLETED[\s\S]*MY_PACKAGE_REPLACED/)
    assert.doesNotMatch(configuredWorker, /PeriodicWorkRequestBuilder|15, TimeUnit\.MINUTES/)

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
