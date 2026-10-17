import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const gradlePath = process.argv[2] ?? 'src-tauri/gen/android/app/build.gradle.kts'
const sourcePath =
  process.argv[3] ??
  'src-tauri/gen/android/app/src/main/java/app/balance/local/BalanceSyncWorker.kt'
const activityPath =
  process.argv[4] ??
  'src-tauri/gen/android/app/src/main/java/app/balance/local/MainActivity.kt'
const manifestPath = process.argv[5] ?? 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'

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

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
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
        // The delayed job and the Doze-safe alarm can both fire near the same
        // time. One completed pass is enough.
        if (SystemClock.elapsedRealtime() - lastSuccessAt < DUPLICATE_WINDOW_MS) return Result.success()
        // Recheck after WorkManager dispatch in case connectivity disappeared.
        // Do not require VALIDATED: a reachable relay can coexist with blocked probes.
        val offline = try {
            val manager = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            manager != null && manager.activeNetwork == null
        } catch (_: Exception) { false }
        if (offline) return Result.retry()
        running = true
        return try {
            if (runNativeSync(applicationContext.applicationInfo.dataDir) == 0) {
                scheduleNext(applicationContext)
                Result.success()
            } else Result.retry()
        } catch (_: Throwable) {
            Result.retry()
        } finally {
            running = false
        }
    }

    companion object {
        private const val SYNC_NAME = "balance-relay-sync-background"
        private const val LOG_TAG = "BalanceBackgroundSync"
        private const val SYNC_DELAY_MINUTES = 5L
        private const val DUPLICATE_WINDOW_MS = 60_000L
        const val ACTION_SYNC_ALARM = "app.balance.local.BACKGROUND_SYNC_ALARM"
        @Volatile private var appForeground = false
        @Volatile private var running = false
        @Volatile private var lastSuccessAt = -DUPLICATE_WINDOW_MS

        init { System.loadLibrary("balance_lib") }

        @JvmStatic external fun runNativeSync(appDataPath: String): Int
        @JvmStatic external fun nativeBeginScheduling()
        @JvmStatic external fun nativeFinishScheduling()

        @JvmStatic fun enterForeground(context: Context) {
            appForeground = true
            WorkManager.getInstance(context.applicationContext).cancelUniqueWork(SYNC_NAME)
            alarmManager(context)?.cancel(alarmIntent(context))
            Log.i(LOG_TAG, "Deferred background relay sync while Balance is foregrounded")
        }

        @JvmStatic fun enterBackground(context: Context) {
            appForeground = false
            enqueue(context, SYNC_DELAY_MINUTES, ExistingWorkPolicy.REPLACE, expedited = false)
            armAlarm(context)
            Log.i(LOG_TAG, "Scheduled background relay sync in five minutes")
        }

        @JvmStatic fun refreshNow(context: Context) {
            enqueue(context, 0, ExistingWorkPolicy.REPLACE, expedited = true)
            Log.i(LOG_TAG, "Scheduled immediate relay sync from widget refresh")
        }

        /** WorkManager jobs wait for Doze maintenance windows even when battery
         *  optimization is off. An allow-while-idle alarm keeps the cadence, and
         *  an expedited job is allowed to use the network while the phone idles. */
        @JvmStatic fun onAlarm(context: Context) {
            if (appForeground) return
            armAlarm(context)
            if (running) return
            enqueue(context, 0, ExistingWorkPolicy.REPLACE, expedited = true)
            Log.i(LOG_TAG, "Started background relay sync from the idle alarm")
        }

        @JvmStatic fun onBootOrUpdate(context: Context) {
            if (!appForeground) armAlarm(context)
        }

        private fun scheduleNext(context: Context) {
            lastSuccessAt = SystemClock.elapsedRealtime()
            armAlarm(context)
        }

        private fun alarmManager(context: Context) =
            context.applicationContext.getSystemService(Context.ALARM_SERVICE) as? AlarmManager

        private fun alarmIntent(context: Context): PendingIntent {
            val intent = Intent(context.applicationContext, BalanceSyncAlarmReceiver::class.java)
                .setAction(ACTION_SYNC_ALARM)
            return PendingIntent.getBroadcast(
                context.applicationContext,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        private fun armAlarm(context: Context) {
            try {
                alarmManager(context)?.setAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + TimeUnit.MINUTES.toMillis(SYNC_DELAY_MINUTES),
                    alarmIntent(context),
                )
            } catch (error: Throwable) {
                Log.w(LOG_TAG, "Could not arm the background relay sync alarm", error)
            }
        }

        private fun enqueue(context: Context, delayMinutes: Long, policy: ExistingWorkPolicy, expedited: Boolean) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val manager = WorkManager.getInstance(context.applicationContext)
            val builder = OneTimeWorkRequestBuilder<BalanceSyncWorker>()
                .setConstraints(constraints)
                .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
            // Older Android versions run expedited work as a foreground service,
            // which would need a notification. Their Doze rules are looser anyway.
            if (expedited && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            }
            val request = builder.build()
            // onStop must not block the UI, but native last-activity shutdown
            // must wait until WorkManager has durably handed off this request.
            nativeBeginScheduling()
            try {
                manager.enqueueUniqueWork(SYNC_NAME, policy, request).result.addListener(
                    { nativeFinishScheduling() },
                    java.util.concurrent.Executor { command -> command.run() }
                )
            } catch (error: Throwable) {
                nativeFinishScheduling()
                throw error
            }
        }
    }
}

class BalanceSyncAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            BalanceSyncWorker.ACTION_SYNC_ALARM -> BalanceSyncWorker.onAlarm(context)
            // Alarms do not survive a reboot or an app update.
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> BalanceSyncWorker.onBootOrUpdate(context)
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

let manifest = await readFile(manifestPath, 'utf8')
const bootPermission = 'android.permission.RECEIVE_BOOT_COMPLETED'
if (!manifest.includes(bootPermission)) {
  const application = /^(\s*)<application\b/m
  if (!application.test(manifest)) throw new Error(`Could not find <application> in ${manifestPath}`)
  manifest = manifest.replace(application, (line, indent) => `${indent}<uses-permission android:name="${bootPermission}" />\n${line}`)
}
if (!manifest.includes('app.balance.local.BalanceSyncAlarmReceiver')) {
  if (!manifest.includes('</application>')) throw new Error(`Could not find </application> in ${manifestPath}`)
  const receivers = `        <receiver android:name="app.balance.local.BalanceSyncAlarmReceiver" android:exported="false">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>`
  manifest = manifest.replace(/^(\s*)<\/application>/m, (line) => `${receivers}\n${line}`)
}
await writeFile(manifestPath, manifest)

console.log(`Configured Android WorkManager relay sync in ${sourcePath}, ${activityPath} and ${manifestPath}`)
