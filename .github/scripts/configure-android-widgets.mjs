import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
import android.content.pm.PackageManager
import android.os.Build
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
import org.xmlpull.v1.XmlPullParser

data class BalanceWidgetSnapshot(
    val date: String,
    val hasPlan: Boolean,
    val unavailable: Boolean,
    val title: String,
    val reminder: String,
    val done: Int,
    val total: Int,
    val items: List<String>,
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
            false,
        )
        update(
            context,
            manager,
            manager.getAppWidgetIds(ComponentName(context, BalanceLockWidgetProvider::class.java)),
            true,
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
        lockScreen: Boolean,
    ) {
        if (ids.isEmpty()) return
        val snapshot = loadSnapshot(context)
        for (id in ids) {
            val views = if (lockScreen) renderLock(context, snapshot) else renderHome(context, snapshot)
            manager.updateAppWidget(id, views)
        }
    }

    private fun loadSnapshot(context: Context): BalanceWidgetSnapshot {
        val date = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
        val json = JSONObject(nativeSnapshot(context.applicationInfo.dataDir, date))
        val itemValues = json.getJSONArray("items")
        val items = ArrayList<String>(itemValues.length())
        for (index in 0 until itemValues.length()) items.add(itemValues.getString(index))
        return BalanceWidgetSnapshot(
            json.getString("date"),
            json.getBoolean("hasPlan"),
            json.getBoolean("unavailable"),
            json.getString("title"),
            json.getString("reminder"),
            json.getInt("done"),
            json.getInt("total"),
            items,
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
        )
        for (index in rows.indices) {
            val text = snapshot.items.getOrNull(index)
            views.setTextViewText(rows[index], if (text == null) "" else "• $text")
            views.setViewVisibility(rows[index], if (text == null) View.GONE else View.VISIBLE)
        }
        attachActions(context, views)
        return views
    }

    private fun renderLock(context: Context, snapshot: BalanceWidgetSnapshot): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.balance_lock_widget)
        // Intentionally omit plan and task text: lock-screen hosts can expose the
        // widget before authentication, so only aggregate progress belongs here.
        views.setTextViewText(R.id.lock_widget_progress, status(snapshot))
        views.setOnClickPendingIntent(R.id.lock_widget_root, openAppIntent(context))
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
                val lockMetadata = providerMetadata(context, BalanceLockWidgetProvider::class.java)
                check(lockMetadata.first.and(2) != 0) { "keyguard provider category is missing" }
                check(lockMetadata.second != 0) { "keyguard initial layout is missing" }

                Handler(Looper.getMainLooper()).post {
                    try {
                        check(renderHome(context, snapshot).apply(context, null) != null)
                        check(renderLock(context, snapshot).apply(context, null) != null)
                        Log.i(
                            "BalanceWidgets",
                            "BALANCE_WIDGET_E2E: OK home+keyguard native-snapshot",
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

    @Suppress("DEPRECATION")
    private fun providerMetadata(context: Context, provider: Class<*>): Pair<Int, Int> {
        val receiver = context.packageManager.getReceiverInfo(
            ComponentName(context, provider),
            PackageManager.GET_META_DATA,
        )
        val resource = receiver.metaData
            ?.getInt(AppWidgetManager.META_DATA_APPWIDGET_PROVIDER)
            ?: error("widget provider metadata is missing")
        check(resource != 0) { "widget provider metadata resource is missing" }

        val parser = context.resources.getXml(resource)
        try {
            while (parser.eventType != XmlPullParser.END_DOCUMENT) {
                if (parser.eventType == XmlPullParser.START_TAG && parser.name == "appwidget-provider") {
                    val namespace = "http://schemas.android.com/apk/res/android"
                    return Pair(
                        parser.getAttributeIntValue(namespace, "widgetCategory", 0),
                        parser.getAttributeResourceValue(namespace, "initialKeyguardLayout", 0),
                    )
                }
                parser.next()
            }
        } finally {
            parser.close()
        }
        error("appwidget-provider metadata tag is missing")
    }
}

class BalanceHomeWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        BalanceWidgets.update(context, manager, ids, false)
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

class BalanceLockWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        BalanceWidgets.update(context, manager, ids, true)
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
</LinearLayout>
`

const lockLayout = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/lock_widget_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/balance_widget_background"
    android:clickable="true"
    android:gravity="center_vertical"
    android:orientation="horizontal"
    android:paddingHorizontal="16dp"
    android:paddingVertical="10dp">
    <TextView
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="Balance"
        android:textColor="#24211D"
        android:textSize="16sp"
        android:textStyle="bold" />
    <TextView
        android:id="@+id/lock_widget_progress"
        android:layout_width="0dp"
        android:layout_height="wrap_content"
        android:layout_marginStart="12dp"
        android:layout_weight="1"
        android:ellipsize="end"
        android:gravity="end"
        android:maxLines="1"
        android:text="Open Balance"
        android:textColor="#746A5E"
        android:textSize="13sp" />
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
    <string name="balance_lock_widget_name">Balance Progress</string>
    <string name="balance_lock_widget_description">Private task progress for the lock screen</string>
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

const lockInfo = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/balance_lock_widget_description"
    android:initialKeyguardLayout="@layout/balance_lock_widget"
    android:initialLayout="@layout/balance_lock_widget"
    android:minHeight="50dp"
    android:minResizeHeight="50dp"
    android:minResizeWidth="180dp"
    android:minWidth="180dp"
    android:previewLayout="@layout/balance_lock_widget"
    android:resizeMode="horizontal"
    android:targetCellHeight="1"
    android:targetCellWidth="3"
    android:updatePeriodMillis="1800000"
    android:widgetCategory="keyguard" />
`

const files = new Map([
  [sourcePath, source],
  [join(resPath, 'layout/balance_home_widget.xml'), homeLayout],
  [join(resPath, 'layout/balance_lock_widget.xml'), lockLayout],
  [join(resPath, 'values/balance_widget_styles.xml'), styles],
  [join(resPath, 'values/balance_widget_strings.xml'), strings],
  [join(resPath, 'drawable/balance_widget_background.xml'), background],
  [join(resPath, 'xml/balance_home_widget_info.xml'), homeInfo],
  [join(resPath, 'xml/balance_lock_widget_info.xml'), lockInfo],
])

for (const [path, content] of files) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

let manifest = await readFile(manifestPath, 'utf8')
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
${indent}    </receiver>
${indent}    <receiver
${indent}        android:name=".BalanceLockWidgetProvider"
${indent}        android:exported="false"
${indent}        android:label="@string/balance_lock_widget_name">
${indent}        <intent-filter>
${indent}            <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
${indent}        </intent-filter>
${indent}        <meta-data
${indent}            android:name="android.appwidget.provider"
${indent}            android:resource="@xml/balance_lock_widget_info" />
${indent}    </receiver>`
  manifest = manifest.replace(closingApplication, `${receivers}\n$&`)
  await writeFile(manifestPath, manifest)
}

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

console.log(`Configured Android home and lock-screen widgets in ${root}`)
