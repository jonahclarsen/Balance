import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const gradlePath = process.argv[2] ?? 'src-tauri/gen/android/app/build.gradle.kts'
const sourcePath =
  process.argv[3] ??
  'src-tauri/gen/android/app/src/main/java/app/balance/local/BalanceSyncWorker.kt'
const activityPath =
  process.argv[4] ??
  'src-tauri/gen/android/app/src/main/java/app/balance/local/MainActivity.kt'

let gradle = await readFile(gradlePath, 'utf8')
// Tauri's generated project currently uses Kotlin 1.9. WorkManager 2.11 is
// compiled with Kotlin 2.1 metadata, so 2.10.1 is the newest compatible line.
const dependency = 'implementation("androidx.work:work-runtime:2.10.1")'
if (!gradle.includes(dependency)) {
  const existing = /implementation\("androidx\.work:work-runtime:[^"\)]+"\)/
  if (existing.test(gradle)) {
    gradle = gradle.replace(existing, dependency)
  } else {
    const marker = /dependencies\s*\{/
    if (!marker.test(gradle)) throw new Error(`Could not find dependencies block in ${gradlePath}`)
    gradle = gradle.replace(marker, (match) => `${match}\n    ${dependency}`)
  }
  await writeFile(gradlePath, gradle)
}

const source = `package app.balance.local

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class BalanceSyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = try {
        if (runNativeSync(applicationContext.applicationInfo.dataDir) == 0) Result.success()
        else Result.retry()
    } catch (_: Throwable) {
        Result.retry()
    }

    companion object {
        private const val PERIODIC_NAME = "balance-relay-sync-periodic"
        private const val ONCE_NAME = "balance-relay-sync-once"

        init { System.loadLibrary("balance_lib") }

        @JvmStatic external fun runNativeSync(appDataPath: String): Int

        @JvmStatic fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val manager = WorkManager.getInstance(context.applicationContext)
            val periodic = PeriodicWorkRequestBuilder<BalanceSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()
            manager.enqueueUniquePeriodicWork(
                PERIODIC_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                periodic,
            )
            val once = OneTimeWorkRequestBuilder<BalanceSyncWorker>()
                .setConstraints(constraints)
                .build()
            manager.enqueueUniqueWork(ONCE_NAME, ExistingWorkPolicy.KEEP, once)
        }
    }
}
`

await mkdir(dirname(sourcePath), { recursive: true })
await writeFile(sourcePath, source)

// Register from native startup as well as from the frontend command. Startup is
// deterministic and does not depend on the webview finishing initialization;
// the unique-work policies make subsequent calls harmless.
let activity = await readFile(activityPath, 'utf8')
if (!activity.includes('BalanceSyncWorker.schedule(this)')) {
  if (!activity.includes('import android.os.Bundle')) {
    activity = activity.replace(/^(package [^\n]+\n)/m, '$1\nimport android.os.Bundle\n')
  }

  if (/override fun onCreate\s*\(/.test(activity)) {
    const superCall = /^(\s*)super\.onCreate\(savedInstanceState\)$/m
    if (!superCall.test(activity)) {
      throw new Error(`Could not find MainActivity's super.onCreate call in ${activityPath}`)
    }
    activity = activity.replace(
      superCall,
      (_match, indent) => `${indent}super.onCreate(savedInstanceState)\n${indent}BalanceSyncWorker.schedule(this)`,
    )
  } else {
    const body = `class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    BalanceSyncWorker.schedule(this)
  }
}`
    const emptyActivity = /class MainActivity\s*:\s*TauriActivity\(\)\s*(?:\{\s*\})?/
    if (!emptyActivity.test(activity)) {
      throw new Error(`Could not find the generated MainActivity in ${activityPath}`)
    }
    activity = activity.replace(emptyActivity, body)
  }
  await writeFile(activityPath, activity)
}

console.log(`Configured Android WorkManager relay sync in ${sourcePath} and ${activityPath}`)
