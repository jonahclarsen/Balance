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
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class BalanceSyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        if (appForeground) {
            Log.i(LOG_TAG, "Skipping background relay sync while Balance is foregrounded")
            return Result.success()
        }
        return try {
            if (runNativeSync(applicationContext.applicationInfo.dataDir) == 0) {
                scheduleNext(applicationContext)
                Result.success()
            } else Result.retry()
        } catch (_: Throwable) {
            Result.retry()
        }
    }

    companion object {
        private const val SYNC_NAME = "balance-relay-sync-background"
        private const val LOG_TAG = "BalanceBackgroundSync"
        private const val SYNC_DELAY_MINUTES = 5L
        @Volatile private var appForeground = false

        init { System.loadLibrary("balance_lib") }

        @JvmStatic external fun runNativeSync(appDataPath: String): Int

        @JvmStatic fun enterForeground(context: Context) {
            appForeground = true
            WorkManager.getInstance(context.applicationContext).cancelUniqueWork(SYNC_NAME)
            Log.i(LOG_TAG, "Deferred background relay sync while Balance is foregrounded")
        }

        @JvmStatic fun enterBackground(context: Context) {
            appForeground = false
            enqueue(context, SYNC_DELAY_MINUTES, ExistingWorkPolicy.REPLACE)
            Log.i(LOG_TAG, "Scheduled background relay sync in five minutes")
        }

        @JvmStatic fun refreshNow(context: Context) {
            enqueue(context, 0, ExistingWorkPolicy.REPLACE)
            Log.i(LOG_TAG, "Scheduled immediate relay sync from widget refresh")
        }

        private fun scheduleNext(context: Context) {
            enqueue(context, SYNC_DELAY_MINUTES, ExistingWorkPolicy.APPEND_OR_REPLACE)
        }

        private fun enqueue(context: Context, delayMinutes: Long, policy: ExistingWorkPolicy) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val manager = WorkManager.getInstance(context.applicationContext)
            val request = OneTimeWorkRequestBuilder<BalanceSyncWorker>()
                .setConstraints(constraints)
                .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
                .build()
            manager.enqueueUniqueWork(SYNC_NAME, policy, request)
        }
    }
}
`

await mkdir(dirname(sourcePath), { recursive: true })
await writeFile(sourcePath, source)

// Cancel any overdue background pass before the WebView starts. Re-register it
// only when the activity stops, with a fresh five-minute delay, so WorkManager
// cannot take the database lock from foreground startup.
let activity = await readFile(activityPath, 'utf8')
activity = activity.replace(/^\s*BalanceSyncWorker\.schedule\(this\)\s*$/m, '')
if (!/class MainActivity\s*:\s*TauriActivity\(\)\s*\{/.test(activity)) {
  if (!activity.includes('import android.os.Bundle')) {
    activity = activity.replace(/^(package [^\n]+\n)/m, '$1\nimport android.os.Bundle\n')
  }
  const body = `class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
  }
}`
  const emptyActivity = /class MainActivity\s*:\s*TauriActivity\(\)\s*(?:\{\s*\})?/
  if (!emptyActivity.test(activity)) {
    throw new Error(`Could not find the generated MainActivity in ${activityPath}`)
  }
  activity = activity.replace(emptyActivity, body)
}

function addLifecycleCall(source, method, call) {
  if (source.includes(call)) return source
  const methodMarker = new RegExp(`override fun ${method}\\s*\\(`)
  if (methodMarker.test(source)) {
    const superCall = new RegExp(`^(\\s*)super\\.${method}\\(\\)$`, 'm')
    if (!superCall.test(source)) {
      throw new Error(`Could not find MainActivity's super.${method} call in ${activityPath}`)
    }
    return source.replace(superCall, (_match, indent) => `${indent}super.${method}()\n${indent}${call}`)
  }
  const closingClass = /\n}\s*$/
  if (!closingClass.test(source)) {
    throw new Error(`Could not find MainActivity's closing brace in ${activityPath}`)
  }
  return source.replace(
    closingClass,
    `\n\n  override fun ${method}() {\n    super.${method}()\n    ${call}\n  }\n}`,
  )
}

activity = addLifecycleCall(activity, 'onStart', 'BalanceSyncWorker.enterForeground(this)')
activity = addLifecycleCall(activity, 'onStop', 'BalanceSyncWorker.enterBackground(this)')
await writeFile(activityPath, activity)

console.log(`Configured Android WorkManager relay sync in ${sourcePath} and ${activityPath}`)
