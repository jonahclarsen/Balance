import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const root = process.argv[2] ?? 'src-tauri/gen/android/app/src/main'
const activityPath =
  process.argv[3] ?? join(root, 'java/app/balance/local/MainActivity.kt')
const workerPath =
  process.argv[4] ?? join(root, 'java/app/balance/local/BalanceSyncWorker.kt')
const manifestPath = join(root, 'AndroidManifest.xml')
const sourcePath = join(root, 'java/app/balance/local/BalanceWidgets.kt')
const resPath = join(root, 'res')

const source = `package app.balance.local

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import org.json.JSONObject

data class BalanceWidgetSnapshot(
    val date: String,
    val hasPlan: Boolean,
    val unavailable: Boolean,
    val title: String,
    val reminder: String,
    val done: Int,
    val total: Int,
    val items: List<String>,
    val itemDepths: List<Int>,
    val itemTimes: List<String>,
)

object BalanceWidgets {
    const val ACTION_REFRESH = "app.balance.local.action.REFRESH_WIDGETS"
    private const val SELF_TEST_DELAY_MS = 15_000L
    private val executor = Executors.newSingleThreadExecutor()

    init { System.loadLibrary("balance_lib") }

    @JvmStatic external fun nativeSnapshot(appDataPath: String, date: String): String

    fun refreshAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        update(
            context,
            manager,
            manager.getAppWidgetIds(ComponentName(context, BalanceHomeWidgetProvider::class.java)),
        )
    }

    fun refreshAllAsync(context: Context, finished: (() -> Unit)? = null) {
        val appContext = context.applicationContext
        executor.execute {
            try {
                refreshAll(appContext)
            } catch (error: Throwable) {
                Log.e("BalanceWidgets", "Could not refresh widgets", error)
            } finally {
                finished?.invoke()
            }
        }
    }

    fun update(
        context: Context,
        manager: AppWidgetManager,
        ids: IntArray,
    ) {
        if (ids.isEmpty()) return
        val snapshot = loadSnapshot(context)
        for (id in ids) {
            manager.updateAppWidget(id, renderHome(context, snapshot))
        }
    }

    private fun loadSnapshot(context: Context): BalanceWidgetSnapshot {
        val date = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
        val json = JSONObject(nativeSnapshot(context.applicationInfo.dataDir, date))
        val itemValues = json.getJSONArray("items")
        val depthValues = json.optJSONArray("itemDepths")
        val timeValues = json.optJSONArray("itemTimes")
        val items = ArrayList<String>(itemValues.length())
        val itemDepths = ArrayList<Int>(itemValues.length())
        val itemTimes = ArrayList<String>(itemValues.length())
        for (index in 0 until itemValues.length()) items.add(itemValues.getString(index))
        for (index in 0 until itemValues.length()) {
            itemDepths.add(depthValues?.optInt(index, 0) ?: 0)
            itemTimes.add(timeValues?.optString(index, "") ?: "")
        }
        return BalanceWidgetSnapshot(
            json.getString("date"),
            json.getBoolean("hasPlan"),
            json.getBoolean("unavailable"),
            json.getString("title"),
            json.getString("reminder"),
            json.getInt("done"),
            json.getInt("total"),
            items,
            itemDepths,
            itemTimes,
        )
    }

    private fun renderHome(context: Context, snapshot: BalanceWidgetSnapshot): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.balance_home_widget)
        views.setTextViewText(R.id.widget_title, snapshot.title)
        views.setTextViewText(
            R.id.widget_date,
            SimpleDateFormat("EEE, MMM d", Locale.getDefault()).format(Date()),
        )
        views.setTextViewText(R.id.widget_progress, status(snapshot))
        views.setTextViewText(R.id.widget_reminder, snapshot.reminder)
        views.setViewVisibility(
            R.id.widget_reminder,
            if (snapshot.reminder.isBlank() || !snapshot.hasPlan) View.GONE else View.VISIBLE,
        )

        val rows = intArrayOf(
            R.id.widget_item_1,
            R.id.widget_item_2,
            R.id.widget_item_3,
            R.id.widget_item_4,
            R.id.widget_item_5,
            R.id.widget_item_6,
            R.id.widget_item_7,
            R.id.widget_item_8,
            R.id.widget_item_9,
            R.id.widget_item_10,
        )
        for (index in rows.indices) {
            val text = snapshot.items.getOrNull(index)
            val depth = snapshot.itemDepths.getOrNull(index)?.coerceIn(0, 4) ?: 0
            val indent = "\\u00a0\\u00a0".repeat(depth)
            val time = snapshot.itemTimes.getOrNull(index).orEmpty()
            val timePrefix = if (time.isEmpty()) "" else "$time "
            views.setTextViewText(rows[index], if (text == null) "" else "\${indent}• $timePrefix$text")
            views.setViewVisibility(rows[index], if (text == null) View.GONE else View.VISIBLE)
        }
        attachActions(context, views)
        return views
    }

    private fun status(snapshot: BalanceWidgetSnapshot): String = when {
        snapshot.unavailable -> "Unlock and open Balance to refresh"
        !snapshot.hasPlan -> "Open Balance to make today's plan"
        snapshot.total == 0 -> "No tasks yet"
        snapshot.done == snapshot.total -> "All \${snapshot.total} tasks complete"
        else -> "\${snapshot.done} of \${snapshot.total} complete"
    }

    private fun attachActions(context: Context, views: RemoteViews) {
        views.setOnClickPendingIntent(R.id.widget_root, openAppIntent(context))
        val refresh = Intent(context, BalanceHomeWidgetProvider::class.java).setAction(ACTION_REFRESH)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        views.setOnClickPendingIntent(
            R.id.widget_refresh,
            PendingIntent.getBroadcast(context, 42, refresh, flags),
        )
    }

    private fun openAppIntent(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getActivity(context, 41, intent, flags)
    }

    fun scheduleSelfTest(context: Context) {
        val appContext = context.applicationContext
        Handler(Looper.getMainLooper()).postDelayed({
            runSelfTest(appContext, 10)
        }, SELF_TEST_DELAY_MS)
    }

    private fun runSelfTest(context: Context, attemptsRemaining: Int) {
        val database = File(context.applicationInfo.dataDir, "Balance/balance.sqlite3")
        if (!database.isFile && attemptsRemaining > 0) {
            Handler(Looper.getMainLooper()).postDelayed({
                runSelfTest(context, attemptsRemaining - 1)
            }, 2_000L)
            return
        }
        if (!database.isFile) {
            Log.e("BalanceWidgets", "BALANCE_WIDGET_E2E: FAIL encrypted database is missing")
            return
        }

        executor.execute {
            try {
                val snapshot = loadSnapshot(context)
                val manager = AppWidgetManager.getInstance(context)
                val providers = manager.installedProviders
                val home = providers.firstOrNull {
                    it.provider.className == BalanceHomeWidgetProvider::class.java.name
                } ?: error("home provider is not installed")
                check(home.widgetCategory.and(1) != 0) { "home provider category is missing" }
                check(home.initialLayout != 0) { "home initial layout is missing" }
                Handler(Looper.getMainLooper()).post {
                    try {
                        check(renderHome(context, snapshot).apply(context, null) != null)
                        Log.i(
                            "BalanceWidgets",
                            "BALANCE_WIDGET_E2E: OK home native-snapshot",
                        )
                    } catch (error: Throwable) {
                        Log.e("BalanceWidgets", "BALANCE_WIDGET_E2E: FAIL", error)
                    }
                }
            } catch (error: Throwable) {
                Log.e("BalanceWidgets", "BALANCE_WIDGET_E2E: FAIL", error)
            }
        }
    }

}

class BalanceHomeWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        BalanceWidgets.update(context, manager, ids)
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == BalanceWidgets.ACTION_REFRESH) {
            val pending = goAsync()
            BalanceWidgets.refreshAllAsync(context) { pending.finish() }
        } else {
            super.onReceive(context, intent)
        }
    }
}
`

const homeLayout = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/widget_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/balance_widget_background"
    android:clickable="true"
    android:orientation="vertical"
    android:padding="16dp">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:gravity="center_vertical"
        android:orientation="horizontal">
        <TextView
            android:id="@+id/widget_title"
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:ellipsize="end"
            android:maxLines="1"
            android:text="Today"
            android:textColor="#24211D"
            android:textSize="18sp"
            android:textStyle="bold" />
        <TextView
            android:id="@+id/widget_refresh"
            android:layout_width="40dp"
            android:layout_height="40dp"
            android:gravity="center"
            android:text="↻"
            android:textColor="#5F574D"
            android:textSize="22sp" />
    </LinearLayout>

    <TextView
        android:id="@+id/widget_date"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="Sat, Aug 1"
        android:textColor="#746A5E"
        android:textSize="12sp" />
    <TextView
        android:id="@+id/widget_progress"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:layout_marginTop="2dp"
        android:text="Open Balance to make today's plan"
        android:textColor="#9B5B43"
        android:textSize="13sp"
        android:textStyle="bold" />
    <TextView
        android:id="@+id/widget_reminder"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="6dp"
        android:ellipsize="end"
        android:maxLines="1"
        android:textColor="#746A5E"
        android:textSize="12sp"
        android:textStyle="italic" />
    <TextView android:id="@+id/widget_item_1" style="@style/BalanceWidgetItem" />
    <TextView android:id="@+id/widget_item_2" style="@style/BalanceWidgetItem" />
    <TextView android:id="@+id/widget_item_3" style="@style/BalanceWidgetItem" />
    <TextView android:id="@+id/widget_item_4" style="@style/BalanceWidgetItem" />
    <TextView android:id="@+id/widget_item_5" style="@style/BalanceWidgetItem" />
    <TextView android:id="@+id/widget_item_6" style="@style/BalanceWidgetItem" />
    <TextView android:id="@+id/widget_item_7" style="@style/BalanceWidgetItem" />
    <TextView android:id="@+id/widget_item_8" style="@style/BalanceWidgetItem" />
    <TextView android:id="@+id/widget_item_9" style="@style/BalanceWidgetItem" />
    <TextView android:id="@+id/widget_item_10" style="@style/BalanceWidgetItem" />
</LinearLayout>
`

const styles = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="BalanceWidgetItem">
        <item name="android:layout_width">match_parent</item>
        <item name="android:layout_height">wrap_content</item>
        <item name="android:layout_marginTop">4dp</item>
        <item name="android:ellipsize">end</item>
        <item name="android:maxLines">1</item>
        <item name="android:textColor">#3D3831</item>
        <item name="android:textSize">14sp</item>
    </style>
</resources>
`

const background = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#F7F3EA" />
    <corners android:radius="24dp" />
    <stroke android:width="1dp" android:color="#1A6F665C" />
</shape>
`

const strings = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="balance_home_widget_name">Balance Today</string>
    <string name="balance_home_widget_description">Today’s plan and next tasks</string>
</resources>
`

const homeInfo = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/balance_home_widget_description"
    android:initialLayout="@layout/balance_home_widget"
    android:minHeight="180dp"
    android:minResizeHeight="120dp"
    android:minResizeWidth="180dp"
    android:minWidth="250dp"
    android:previewLayout="@layout/balance_home_widget"
    android:resizeMode="horizontal|vertical"
    android:targetCellHeight="3"
    android:targetCellWidth="4"
    android:updatePeriodMillis="1800000"
    android:widgetCategory="home_screen" />
`

const files = new Map([
  [sourcePath, source],
  [join(resPath, 'layout/balance_home_widget.xml'), homeLayout],
  [join(resPath, 'values/balance_widget_styles.xml'), styles],
  [join(resPath, 'values/balance_widget_strings.xml'), strings],
  [join(resPath, 'drawable/balance_widget_background.xml'), background],
  [join(resPath, 'xml/balance_home_widget_info.xml'), homeInfo],
])

for (const [path, content] of files) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

for (const path of [
  join(resPath, 'layout/balance_lock_widget.xml'),
  join(resPath, 'xml/balance_lock_widget_info.xml'),
]) {
  await rm(path, { force: true })
}

let manifest = await readFile(manifestPath, 'utf8')
manifest = manifest.replace(
  /\n[ \t]*<receiver\b(?=[^>]*android:name="\.BalanceLockWidgetProvider")[\s\S]*?<\/receiver>/g,
  '',
)
if (!manifest.includes('BalanceHomeWidgetProvider')) {
  const closingApplication = /^(\s*)<\/application>/m
  const match = manifest.match(closingApplication)
  if (!match) throw new Error(`Could not find </application> in ${manifestPath}`)
  const indent = match[1]
  const receivers = `${indent}    <receiver
${indent}        android:name=".BalanceHomeWidgetProvider"
${indent}        android:exported="false"
${indent}        android:label="@string/balance_home_widget_name">
${indent}        <intent-filter>
${indent}            <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
${indent}        </intent-filter>
${indent}        <meta-data
${indent}            android:name="android.appwidget.provider"
${indent}            android:resource="@xml/balance_home_widget_info" />
${indent}    </receiver>`
  manifest = manifest.replace(closingApplication, `${receivers}\n$&`)
}
await writeFile(manifestPath, manifest)

let activity = await readFile(activityPath, 'utf8')
if (!activity.includes('BalanceWidgets.scheduleSelfTest(this)')) {
  const scheduleMarker = /^(\s*)BalanceSyncWorker\.schedule\(this\)$/m
  const superMarker = /^(\s*)super\.onCreate\(savedInstanceState\)$/m
  const marker = scheduleMarker.test(activity) ? scheduleMarker : superMarker
  if (!marker.test(activity)) {
    throw new Error(`Could not find Android startup call in ${activityPath}`)
  }
  activity = activity.replace(
    marker,
    (line, indent) => `${line}\n${indent}if (BuildConfig.DEBUG) BalanceWidgets.scheduleSelfTest(this)`,
  )
}
if (!activity.includes('BalanceWidgets.refreshAllAsync(this)')) {
  if (/override fun onStop\s*\(/.test(activity)) {
    const superCall = /^(\s*)super\.onStop\(\)$/m
    if (!superCall.test(activity)) {
      throw new Error(`Could not find MainActivity's super.onStop call in ${activityPath}`)
    }
    activity = activity.replace(
      superCall,
      (_line, indent) => `${indent}super.onStop()\n${indent}BalanceWidgets.refreshAllAsync(this)`,
    )
  } else {
    const closingClass = /\n}\s*$/
    if (!closingClass.test(activity)) {
      throw new Error(`Could not find MainActivity's closing brace in ${activityPath}`)
    }
    activity = activity.replace(
      closingClass,
      `

  override fun onStop() {
    super.onStop()
    BalanceWidgets.refreshAllAsync(this)
  }
}`,
    )
  }
}
await writeFile(activityPath, activity)

try {
  let worker = await readFile(workerPath, 'utf8')
  if (!worker.includes('BalanceWidgets.refreshAllAsync(applicationContext)')) {
    const success = 'if (runNativeSync(applicationContext.applicationInfo.dataDir) == 0) Result.success()'
    if (!worker.includes(success)) {
      throw new Error(`Could not find the background sync success path in ${workerPath}`)
    }
    worker = worker.replace(
      success,
      `if (runNativeSync(applicationContext.applicationInfo.dataDir) == 0) {
            BalanceWidgets.refreshAllAsync(applicationContext)
            Result.success()
        }`,
    )
    await writeFile(workerPath, worker)
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

console.log(`Configured Android home-screen widget in ${root}`)
