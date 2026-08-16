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
import kotlin.math.roundToInt
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
    val themeId: String,
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
            json.optString("themeId", "violet"),
        )
    }

    private fun renderHome(context: Context, snapshot: BalanceWidgetSnapshot): RemoteViews {
        val views = RemoteViews(context.packageName, themeLayout(snapshot.themeId))
        views.setTextViewText(
            R.id.widget_title,
            snapshot.title.ifBlank { "Today’s plan" },
        )
        views.setTextViewText(
            R.id.widget_date,
            SimpleDateFormat("EEEE, MMM d", Locale.getDefault()).format(Date()).uppercase(),
        )
        views.setTextViewText(R.id.widget_progress, compactStatus(snapshot))
        views.setContentDescription(R.id.widget_progress, status(snapshot))
        val showProgress = snapshot.hasPlan && !snapshot.unavailable && snapshot.total > 0
        views.setProgressBar(
            R.id.widget_progress_bar,
            snapshot.total.coerceAtLeast(1),
            snapshot.done.coerceIn(0, snapshot.total.coerceAtLeast(1)),
            false,
        )
        views.setViewVisibility(
            R.id.widget_progress_bar,
            if (showProgress) View.VISIBLE else View.GONE,
        )
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
        val density = context.resources.displayMetrics.density
        val verticalPadding = (5 * density).roundToInt()
        for (index in rows.indices) {
            val text = snapshot.items.getOrNull(index)
            val depth = snapshot.itemDepths.getOrNull(index)?.coerceIn(0, 4) ?: 0
            val time = snapshot.itemTimes.getOrNull(index).orEmpty()
            val timePrefix = if (time.isEmpty()) "" else "$time  "
            views.setTextViewText(rows[index], if (text == null) "" else "$timePrefix$text")
            views.setViewPadding(
                rows[index],
                (depth * 12 * density).roundToInt(),
                verticalPadding,
                0,
                verticalPadding,
            )
            views.setViewVisibility(rows[index], if (text == null) View.GONE else View.VISIBLE)
        }
        attachActions(context, views)
        return views
    }

    private fun themeLayout(themeId: String): Int = when (themeId) {
        "forest" -> R.layout.balance_home_widget_forest
        "ocean" -> R.layout.balance_home_widget_ocean
        "sunset" -> R.layout.balance_home_widget_sunset
        "berry" -> R.layout.balance_home_widget_berry
        "pink" -> R.layout.balance_home_widget_pink
        "mint" -> R.layout.balance_home_widget_mint
        "midnight" -> R.layout.balance_home_widget_midnight
        else -> R.layout.balance_home_widget_violet
    }

    private fun status(snapshot: BalanceWidgetSnapshot): String = when {
        snapshot.unavailable -> "Unlock and open Balance to refresh"
        !snapshot.hasPlan -> "Open Balance to make today's plan"
        snapshot.total == 0 -> "No tasks yet"
        snapshot.done == snapshot.total -> "All \${snapshot.total} tasks complete"
        else -> "\${snapshot.done} of \${snapshot.total} complete"
    }

    private fun compactStatus(snapshot: BalanceWidgetSnapshot): String = when {
        snapshot.unavailable -> "Open Balance"
        !snapshot.hasPlan -> "Start today"
        snapshot.total == 0 -> "No tasks"
        snapshot.done == snapshot.total -> "Done"
        else -> "\${snapshot.done}/\${snapshot.total}"
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

const widgetThemes = [
  { id: 'forest', paper: '#FFFDF8', ink: '#1D2428', muted: '#687276', line: '#D8D4CA', accent: '#2F6F68', accentStrong: '#245A54', soft: '#DFECE7', reminder: '#EEF7F3' },
  { id: 'ocean', paper: '#F9FCFF', ink: '#172733', muted: '#637581', line: '#CCD9E1', accent: '#276A9F', accentStrong: '#1F527C', soft: '#D7E9F5', reminder: '#EAF5FB' },
  { id: 'violet', paper: '#FCFAFF', ink: '#292332', muted: '#756C7F', line: '#DAD2E2', accent: '#7355A2', accentStrong: '#593D83', soft: '#E4D9F2', reminder: '#F3EDF9' },
  { id: 'sunset', paper: '#FFFAF5', ink: '#33241F', muted: '#7B6B63', line: '#E2D3C7', accent: '#B9563F', accentStrong: '#8F3F2E', soft: '#F4D8CD', reminder: '#FBECE3' },
  { id: 'berry', paper: '#FFFAFD', ink: '#30242A', muted: '#786B72', line: '#DFD2D9', accent: '#9B496B', accentStrong: '#793650', soft: '#F2DBE6', reminder: '#F9EAF1' },
  { id: 'pink', paper: '#FFF9FC', ink: '#31232B', muted: '#7D6A74', line: '#E6D0DC', accent: '#C33F7A', accentStrong: '#932956', soft: '#F8D5E5', reminder: '#FBE7F0' },
  { id: 'mint', paper: '#F9FDFA', ink: '#1E2D29', muted: '#657771', line: '#CCDDD7', accent: '#287968', accentStrong: '#1C5C4F', soft: '#D0EAE0', reminder: '#E7F5EF' },
  { id: 'midnight', paper: '#FAFBFE', ink: '#202738', muted: '#687083', line: '#D1D6E2', accent: '#425B9B', accentStrong: '#304477', soft: '#D9E0F1', reminder: '#EAF0FA' },
]

const alphaColor = (hex, alpha) => `#${alpha}${hex.slice(1)}`

function taskRows(theme) {
  const preview = [
    'Plan the day around what matters most',
    '9am–10am  Focus on the next thing',
    'Take a proper break',
  ]
  return Array.from({ length: 10 }, (_, index) => {
    const text = preview[index] ? `\n        android:text="${preview[index]}"` : ''
    return `    <TextView
        android:id="@+id/widget_item_${index + 1}"
        style="@style/BalanceWidgetItem"
        android:drawableStart="@drawable/balance_widget_${theme.id}_task_circle"
        android:textColor="${theme.ink}"${text} />`
  }).join('\n')
}

function homeLayout(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/widget_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/balance_widget_${theme.id}_background"
    android:clickable="true"
    android:orientation="vertical"
    android:padding="18dp">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:gravity="top"
        android:orientation="horizontal">

        <LinearLayout
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:orientation="vertical">
            <TextView
                android:id="@+id/widget_date"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:fontFamily="sans-serif-medium"
                android:letterSpacing="0.08"
                android:text="SATURDAY, AUG 1"
                android:textColor="${theme.accent}"
                android:textSize="10sp" />
            <TextView
                android:id="@+id/widget_title"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:ellipsize="end"
                android:fontFamily="sans-serif-medium"
                android:maxLines="2"
                android:text="Today’s plan"
                android:textColor="${theme.ink}"
                android:textSize="18sp" />
        </LinearLayout>

        <TextView
            android:id="@+id/widget_progress"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginStart="8dp"
            android:layout_marginTop="1dp"
            android:background="@drawable/balance_widget_${theme.id}_pill"
            android:fontFamily="sans-serif-medium"
            android:gravity="center"
            android:maxLines="1"
            android:paddingBottom="5dp"
            android:paddingEnd="9dp"
            android:paddingStart="9dp"
            android:paddingTop="5dp"
            android:text="2/6"
            android:textColor="${theme.accentStrong}"
            android:textSize="11sp" />

        <TextView
            android:id="@+id/widget_refresh"
            android:layout_width="32dp"
            android:layout_height="32dp"
            android:layout_marginStart="6dp"
            android:background="@drawable/balance_widget_${theme.id}_refresh_background"
            android:contentDescription="Refresh Balance widget"
            android:gravity="center"
            android:text="↻"
            android:textColor="${theme.accent}"
            android:textSize="18sp" />
    </LinearLayout>

    <ProgressBar
        android:id="@+id/widget_progress_bar"
        style="?android:attr/progressBarStyleHorizontal"
        android:layout_width="match_parent"
        android:layout_height="4dp"
        android:layout_marginTop="8dp"
        android:indeterminate="false"
        android:progress="33"
        android:progressDrawable="@drawable/balance_widget_${theme.id}_progress" />

    <TextView
        android:id="@+id/widget_reminder"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="9dp"
        android:background="@drawable/balance_widget_${theme.id}_reminder_background"
        android:ellipsize="end"
        android:maxLines="2"
        android:paddingBottom="7dp"
        android:paddingEnd="9dp"
        android:paddingStart="9dp"
        android:paddingTop="7dp"
        android:textColor="${theme.muted}"
        android:textSize="12sp"
        android:textStyle="italic" />

${taskRows(theme)}
</LinearLayout>
`
}

const styles = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="BalanceWidgetItem">
        <item name="android:layout_width">match_parent</item>
        <item name="android:layout_height">wrap_content</item>
        <item name="android:breakStrategy">high_quality</item>
        <item name="android:drawablePadding">8dp</item>
        <item name="android:ellipsize">end</item>
        <item name="android:fontFamily">sans-serif</item>
        <item name="android:gravity">top</item>
        <item name="android:lineSpacingExtra">1dp</item>
        <item name="android:maxLines">3</item>
        <item name="android:textSize">13sp</item>
    </style>
</resources>
`

function background(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="${theme.paper}" />
    <corners android:radius="24dp" />
    <stroke android:width="1dp" android:color="${theme.line}" />
</shape>
`
}

function pill(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="${theme.soft}" />
    <corners android:radius="999dp" />
    <stroke android:width="1dp" android:color="${alphaColor(theme.accent, '4D')}" />
</shape>
`
}

function refreshBackground(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="oval">
    <solid android:color="${theme.soft}" />
    <stroke android:width="1dp" android:color="${alphaColor(theme.accent, '33')}" />
</shape>
`
}

function reminderBackground(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="${theme.reminder}" />
    <corners android:radius="8dp" />
    <stroke android:width="1dp" android:color="${alphaColor(theme.accent, '26')}" />
</shape>
`
}

function taskCircle(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="oval">
    <size android:width="11dp" android:height="11dp" />
    <solid android:color="@android:color/transparent" />
    <stroke android:width="1.5dp" android:color="${alphaColor(theme.accent, 'B3')}" />
</shape>
`
}

function progress(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:id="@android:id/background">
        <shape android:shape="rectangle">
            <corners android:radius="4dp" />
            <solid android:color="${theme.line}" />
        </shape>
    </item>
    <item android:id="@android:id/progress">
        <clip>
            <shape android:shape="rectangle">
                <corners android:radius="4dp" />
                <solid android:color="${theme.accent}" />
            </shape>
        </clip>
    </item>
</layer-list>
`
}

const strings = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="balance_home_widget_name">Balance Today</string>
    <string name="balance_home_widget_description">Today’s plan and next tasks</string>
</resources>
`

const homeInfo = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/balance_home_widget_description"
    android:initialLayout="@layout/balance_home_widget_violet"
    android:minHeight="180dp"
    android:minResizeHeight="120dp"
    android:minResizeWidth="180dp"
    android:minWidth="250dp"
    android:previewLayout="@layout/balance_home_widget_violet"
    android:resizeMode="horizontal|vertical"
    android:targetCellHeight="3"
    android:targetCellWidth="4"
    android:updatePeriodMillis="1800000"
    android:widgetCategory="home_screen" />
`

const files = new Map([
  [sourcePath, source],
  [join(resPath, 'values/balance_widget_styles.xml'), styles],
  [join(resPath, 'values/balance_widget_strings.xml'), strings],
  [join(resPath, 'xml/balance_home_widget_info.xml'), homeInfo],
])

for (const theme of widgetThemes) {
  files.set(join(resPath, `layout/balance_home_widget_${theme.id}.xml`), homeLayout(theme))
  files.set(join(resPath, `drawable/balance_widget_${theme.id}_background.xml`), background(theme))
  files.set(join(resPath, `drawable/balance_widget_${theme.id}_pill.xml`), pill(theme))
  files.set(
    join(resPath, `drawable/balance_widget_${theme.id}_refresh_background.xml`),
    refreshBackground(theme),
  )
  files.set(
    join(resPath, `drawable/balance_widget_${theme.id}_reminder_background.xml`),
    reminderBackground(theme),
  )
  files.set(join(resPath, `drawable/balance_widget_${theme.id}_task_circle.xml`), taskCircle(theme))
  files.set(join(resPath, `drawable/balance_widget_${theme.id}_progress.xml`), progress(theme))
}

for (const [path, content] of files) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

for (const path of [
  join(resPath, 'layout/balance_lock_widget.xml'),
  join(resPath, 'xml/balance_lock_widget_info.xml'),
  join(resPath, 'layout/balance_home_widget.xml'),
  join(resPath, 'drawable/balance_widget_background.xml'),
  join(resPath, 'drawable/balance_widget_pill.xml'),
  join(resPath, 'drawable/balance_widget_refresh_background.xml'),
  join(resPath, 'drawable/balance_widget_reminder_background.xml'),
  join(resPath, 'drawable/balance_widget_task_circle.xml'),
  join(resPath, 'drawable/balance_widget_progress.xml'),
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
