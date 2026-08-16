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
        views.setTextViewText(R.id.widget_date, "TODAY")
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
            if (snapshot.reminder.isBlank() || !snapshot.hasPlan || snapshot.unavailable) {
                View.GONE
            } else {
                View.VISIBLE
            },
        )

        val rows = intArrayOf(
            R.id.widget_item_row_1,
            R.id.widget_item_row_2,
            R.id.widget_item_row_3,
            R.id.widget_item_row_4,
            R.id.widget_item_row_5,
            R.id.widget_item_row_6,
            R.id.widget_item_row_7,
            R.id.widget_item_row_8,
            R.id.widget_item_row_9,
            R.id.widget_item_row_10,
        )
        val taskViews = intArrayOf(
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
        val timeViews = intArrayOf(
            R.id.widget_item_time_1,
            R.id.widget_item_time_2,
            R.id.widget_item_time_3,
            R.id.widget_item_time_4,
            R.id.widget_item_time_5,
            R.id.widget_item_time_6,
            R.id.widget_item_time_7,
            R.id.widget_item_time_8,
            R.id.widget_item_time_9,
            R.id.widget_item_time_10,
        )
        val dividers = intArrayOf(
            R.id.widget_item_divider_1,
            R.id.widget_item_divider_2,
            R.id.widget_item_divider_3,
            R.id.widget_item_divider_4,
            R.id.widget_item_divider_5,
            R.id.widget_item_divider_6,
            R.id.widget_item_divider_7,
            R.id.widget_item_divider_8,
            R.id.widget_item_divider_9,
            R.id.widget_item_divider_10,
        )
        val density = context.resources.displayMetrics.density
        val verticalPadding = (5 * density).roundToInt()
        for (index in rows.indices) {
            val text = snapshot.items.getOrNull(index)
            val depth = snapshot.itemDepths.getOrNull(index)?.coerceIn(0, 4) ?: 0
            val time = snapshot.itemTimes.getOrNull(index).orEmpty()
            views.setTextViewText(taskViews[index], text.orEmpty())
            views.setTextViewText(timeViews[index], time)
            views.setViewVisibility(
                timeViews[index],
                if (text != null && time.isNotEmpty()) View.VISIBLE else View.GONE,
            )
            views.setViewPadding(
                rows[index],
                (depth * 12 * density).roundToInt(),
                verticalPadding,
                0,
                verticalPadding,
            )
            views.setViewVisibility(rows[index], if (text == null) View.GONE else View.VISIBLE)
            views.setViewVisibility(
                dividers[index],
                if (index > 0 && text != null) View.VISIBLE else View.GONE,
            )
        }
        val showTasks = snapshot.hasPlan && !snapshot.unavailable && snapshot.items.isNotEmpty()
        val showAllDone = snapshot.hasPlan && !snapshot.unavailable && snapshot.items.isEmpty()
        views.setViewVisibility(R.id.widget_task_surface, if (showTasks) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.widget_all_done, if (showAllDone) View.VISIBLE else View.GONE)
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
            R.id.widget_refresh_touch_target,
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
            BalanceSyncWorker.refreshNow(context)
        } else {
            super.onReceive(context, intent)
        }
    }
}
`

const widgetThemes = [
  { id: 'forest', paper: '#FFFDF8', surface: '#FFFFFF', ink: '#1D2428', muted: '#687276', line: '#D8D4CA', lineStrong: '#C3BDB0', accent: '#2F6F68', progressHue: 173.4 },
  { id: 'ocean', paper: '#F9FCFF', surface: '#FFFFFF', ink: '#172733', muted: '#637581', line: '#CCD9E1', lineStrong: '#AFC1CC', accent: '#276A9F', progressHue: 206.5 },
  { id: 'violet', paper: '#FCFAFF', surface: '#FFFFFF', ink: '#292332', muted: '#756C7F', line: '#DAD2E2', lineStrong: '#C1B4CE', accent: '#7355A2', progressHue: 263.4 },
  { id: 'sunset', paper: '#FFFAF5', surface: '#FFFFFF', ink: '#33241F', muted: '#7B6B63', line: '#E2D3C7', lineStrong: '#CBB6A6', accent: '#B9563F', progressHue: 11.3 },
  { id: 'berry', paper: '#FFFAFD', surface: '#FFFFFF', ink: '#30242A', muted: '#786B72', line: '#DFD2D9', lineStrong: '#C8B4BF', accent: '#9B496B', progressHue: 335.1 },
  { id: 'pink', paper: '#FFF9FC', surface: '#FFFFFF', ink: '#31232B', muted: '#7D6A74', line: '#E6D0DC', lineStrong: '#CFAEBE', accent: '#C33F7A', progressHue: 333.2 },
  { id: 'mint', paper: '#F9FDFA', surface: '#FFFFFF', ink: '#1E2D29', muted: '#657771', line: '#CCDDD7', lineStrong: '#ADC7BE', accent: '#287968', progressHue: 167.4 },
  { id: 'midnight', paper: '#FAFBFE', surface: '#FFFFFF', ink: '#202738', muted: '#687083', line: '#D1D6E2', lineStrong: '#B3BBCC', accent: '#425B9B', progressHue: 223.1 },
]

const darkWidgetThemes = [
  { id: 'forest', paper: '#1B201F', surface: '#232A28', ink: '#E7ECE8', muted: '#9BA8A3', line: '#34403C', lineStrong: '#4A5A55', accent: '#79B9AE', progressHue: 173.4 },
  { id: 'ocean', paper: '#18222B', surface: '#202D38', ink: '#E8F0F6', muted: '#9FB0BD', line: '#30414E', lineStrong: '#465C6C', accent: '#73B7E6', progressHue: 206.5 },
  { id: 'violet', paper: '#201C25', surface: '#29232F', ink: '#EEE9F2', muted: '#AFA3B8', line: '#42384B', lineStrong: '#5C4C68', accent: '#B69ADB', progressHue: 263.4 },
  { id: 'sunset', paper: '#241C18', surface: '#2E241F', ink: '#F1E9E4', muted: '#B8A69B', line: '#493A32', lineStrong: '#655044', accent: '#E5947F', progressHue: 11.3 },
  { id: 'berry', paper: '#241B20', surface: '#2E2329', ink: '#F1E8ED', muted: '#B5A3AD', line: '#493741', lineStrong: '#634B58', accent: '#DB8BAA', progressHue: 335.1 },
  { id: 'pink', paper: '#261A20', surface: '#312229', ink: '#F4E8EE', muted: '#BAA3AF', line: '#4D3541', lineStrong: '#684857', accent: '#F08DB8', progressHue: 333.2 },
  { id: 'mint', paper: '#18231F', surface: '#202E29', ink: '#E7F1ED', muted: '#9DB2AA', line: '#30453E', lineStrong: '#456057', accent: '#77C8B1', progressHue: 167.4 },
  { id: 'midnight', paper: '#181C29', surface: '#212638', ink: '#E9ECF5', muted: '#A1A9BD', line: '#343B52', lineStrong: '#4B5572', accent: '#91A7E4', progressHue: 223.1 },
]

const alphaColor = (hex, alpha) => `#${alpha}${hex.slice(1)}`

const progressStopSpecs = [
  [0.00, 0.56, 0.52],
  [0.14, 0.58, 0.57],
  [0.28, 0.52, 0.56],
  [0.43, 0.49, 0.58],
  [0.57, 0.77, 0.67],
  [0.71, 0.90, 0.69],
  [0.85, 0.93, 0.64],
  [1.00, 0.89, 0.69],
]

function hslColor(hueDegrees, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const hue = hueDegrees / 60
  const secondary = chroma * (1 - Math.abs((hue % 2) - 1))
  const offset = lightness - chroma / 2
  let rgb
  if (hue < 1) rgb = [chroma, secondary, 0]
  else if (hue < 2) rgb = [secondary, chroma, 0]
  else if (hue < 3) rgb = [0, chroma, secondary]
  else if (hue < 4) rgb = [0, secondary, chroma]
  else if (hue < 5) rgb = [secondary, 0, chroma]
  else rgb = [chroma, 0, secondary]
  return `#${rgb
    .map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase()
}

function taskRows(theme) {
  const preview = [
    'Plan the day around what matters most',
    '9am–10am  Focus on the next thing',
    'Take a proper break',
  ]
  return Array.from({ length: 10 }, (_, index) => {
    const item = index + 1
    const previewText = preview[index]?.replace(/^9am–10am  /, '')
    const text = previewText ? `\n            android:text="${previewText}"` : ''
    const visibility = preview[index] ? '' : '\n        android:visibility="gone"'
    const dividerVisibility = index > 0 && preview[index] ? '' : '\n        android:visibility="gone"'
    const time = index === 1 ? '\n            android:text="9am–10am"' : '\n            android:visibility="gone"'
    return `    <TextView
        android:id="@+id/widget_item_divider_${item}"
        android:layout_width="match_parent"
        android:layout_height="1dp"
        android:background="${alphaColor(theme.line, 'BF')}"${dividerVisibility} />

    <LinearLayout
        android:id="@+id/widget_item_row_${item}"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:gravity="center_vertical"
        android:orientation="horizontal"
        android:paddingBottom="5dp"
        android:paddingTop="5dp"${visibility}>

        <TextView
            android:id="@+id/widget_item_time_${item}"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginEnd="6dp"
            android:background="@drawable/balance_widget_${theme.id}_time_pill"
            android:fontFamily="sans-serif-medium"
            android:maxLines="1"
            android:paddingBottom="2dp"
            android:paddingEnd="6dp"
            android:paddingStart="6dp"
            android:paddingTop="2dp"
            android:textColor="${theme.paper}"
            android:textSize="10sp"${time} />

        <TextView
            android:id="@+id/widget_item_${item}"
            style="@style/BalanceWidgetItem"
            android:textColor="${theme.ink}"${text} />
    </LinearLayout>`
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
                android:text="TODAY"
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
            android:textColor="${theme.accent}"
            android:textSize="11sp" />

        <FrameLayout
            android:id="@+id/widget_refresh_touch_target"
            android:layout_width="48dp"
            android:layout_height="48dp"
            android:layout_marginStart="2dp"
            android:contentDescription="Sync and refresh Balance widget">
            <TextView
                android:id="@+id/widget_refresh"
                android:layout_width="32dp"
                android:layout_height="32dp"
                android:layout_gravity="center"
                android:background="@drawable/balance_widget_${theme.id}_refresh_background"
                android:gravity="center"
                android:text="↻"
                android:textColor="${theme.accent}"
                android:textSize="18sp" />
        </FrameLayout>
    </LinearLayout>

    <TextView
        android:id="@+id/widget_reminder"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="9dp"
        android:ellipsize="end"
        android:maxLines="2"
        android:text="This shouldn’t be aspirational"
        android:textColor="${theme.muted}"
        android:textSize="12sp" />

    <ProgressBar
        android:id="@+id/widget_progress_bar"
        style="?android:attr/progressBarStyleHorizontal"
        android:layout_width="match_parent"
        android:layout_height="8dp"
        android:layout_marginTop="8dp"
        android:indeterminate="false"
        android:progress="33"
        android:progressDrawable="@drawable/balance_widget_${theme.id}_progress" />

    <TextView
        android:id="@+id/widget_all_done"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="9dp"
        android:fontFamily="sans-serif-medium"
        android:text="✓  All done"
        android:textColor="${theme.accent}"
        android:textSize="14sp"
        android:visibility="gone" />

    <LinearLayout
        android:id="@+id/widget_task_surface"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="9dp"
        android:background="@drawable/balance_widget_${theme.id}_task_surface"
        android:orientation="vertical"
        android:paddingEnd="10dp"
        android:paddingStart="10dp">

${taskRows(theme)}
    </LinearLayout>
</LinearLayout>
`
}

const styles = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="BalanceWidgetItem">
        <item name="android:layout_width">0dp</item>
        <item name="android:layout_height">wrap_content</item>
        <item name="android:layout_weight">1</item>
        <item name="android:breakStrategy">high_quality</item>
        <item name="android:ellipsize">end</item>
        <item name="android:fontFamily">sans-serif</item>
        <item name="android:gravity">top</item>
        <item name="android:lineSpacingExtra">1dp</item>
        <item name="android:maxLines">2</item>
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
    <solid android:color="${alphaColor(theme.accent, '1F')}" />
    <corners android:radius="999dp" />
    <stroke android:width="1dp" android:color="${alphaColor(theme.accent, '33')}" />
</shape>
`
}

function refreshBackground(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="oval">
    <solid android:color="${alphaColor(theme.accent, '1F')}" />
    <stroke android:width="1dp" android:color="${alphaColor(theme.accent, '33')}" />
</shape>
`
}

function taskSurface(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="${theme.surface}" />
    <corners android:radius="10dp" />
    <stroke android:width="1dp" android:color="${alphaColor(theme.line, 'CC')}" />
</shape>
`
}

function timePill(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="${theme.accent}" />
    <corners android:radius="999dp" />
</shape>
`
}

function progress(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:id="@android:id/background">
        <layer-list>
            <item>
                <shape android:shape="rectangle">
                    <corners android:radius="999dp" />
                    <solid android:color="${alphaColor(theme.line, '8A')}" />
                </shape>
            </item>
            <item>
                <shape android:shape="rectangle">
                    <corners android:radius="999dp" />
                    <gradient
                        android:angle="270"
                        android:endColor="#00FFFFFF"
                        android:startColor="#61FFFFFF" />
                </shape>
            </item>
            <item>
                <shape android:shape="rectangle">
                    <corners android:radius="999dp" />
                    <solid android:color="@android:color/transparent" />
                    <stroke android:width="1dp" android:color="${alphaColor(theme.lineStrong, 'B8')}" />
                </shape>
            </item>
        </layer-list>
    </item>
    <item android:id="@android:id/progress">
        <clip
            android:clipOrientation="horizontal"
            android:drawable="@drawable/balance_widget_${theme.id}_progress_fill"
            android:gravity="left" />
    </item>
</layer-list>
`
}

function progressFill(theme) {
  const colorStops = progressStopSpecs
    .map(
      ([offset, saturation, lightness]) =>
        `                <item android:color="${hslColor(theme.progressHue, saturation, lightness)}" android:offset="${offset.toFixed(2)}" />`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="100dp"
    android:height="8dp"
    android:viewportWidth="100"
    android:viewportHeight="8">
    <path android:pathData="M4,0 H96 A4,4 0,0 1,100 4 A4,4 0,0 1,96 8 H4 A4,4 0,0 1,0 4 A4,4 0,0 1,4 0 Z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:endX="100"
                android:endY="4"
                android:startX="0"
                android:startY="4"
                android:type="linear">
${colorStops}
            </gradient>
        </aapt:attr>
    </path>
    <path android:pathData="M4,0 H96 A4,4 0,0 1,100 4 A4,4 0,0 1,96 8 H4 A4,4 0,0 1,0 4 A4,4 0,0 1,4 0 Z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:endX="0"
                android:endY="8"
                android:startX="0"
                android:startY="0"
                android:type="linear">
                <item android:color="#ADFFFFFF" android:offset="0" />
                <item android:color="#1FFFFFFF" android:offset="0.43" />
                <item android:color="#70FFFFFF" android:offset="1" />
            </gradient>
        </aapt:attr>
    </path>
    <path android:pathData="M4,0 H96 A4,4 0,0 1,100 4 A4,4 0,0 1,96 8 H4 A4,4 0,0 1,0 4 A4,4 0,0 1,4 0 Z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:endX="88.3"
                android:endY="-7.75"
                android:startX="11.7"
                android:startY="15.75"
                android:type="linear">
                <item android:color="#7AFFFFFF" android:offset="0" />
                <item android:color="#00FFFFFF" android:offset="0.22" />
                <item android:color="#00FFFFFF" android:offset="0.48" />
                <item android:color="#57FFFFFF" android:offset="0.68" />
                <item android:color="#00FFFFFF" android:offset="0.86" />
            </gradient>
        </aapt:attr>
    </path>
    <path
        android:fillColor="@android:color/transparent"
        android:pathData="M4,0.5 H96 A3.5,3.5 0,0 1,99.5 4 A3.5,3.5 0,0 1,96 7.5 H4 A3.5,3.5 0,0 1,0.5 4 A3.5,3.5 0,0 1,4 0.5 Z"
        android:strokeColor="#38FFFFFF"
        android:strokeWidth="1" />
</vector>
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

function addThemeFiles(theme, layoutDirectory, drawableDirectory) {
  files.set(join(resPath, `${layoutDirectory}/balance_home_widget_${theme.id}.xml`), homeLayout(theme))
  files.set(join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_background.xml`), background(theme))
  files.set(join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_pill.xml`), pill(theme))
  files.set(
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_refresh_background.xml`),
    refreshBackground(theme),
  )
  files.set(
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_task_surface.xml`),
    taskSurface(theme),
  )
  files.set(
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_time_pill.xml`),
    timePill(theme),
  )
  files.set(
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_progress.xml`),
    progress(theme),
  )
  files.set(
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_progress_fill.xml`),
    progressFill(theme),
  )
}

for (const theme of widgetThemes) {
  addThemeFiles(theme, 'layout', 'drawable')
}
for (const theme of darkWidgetThemes) {
  addThemeFiles(theme, 'layout-night', 'drawable-night')
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
  ...widgetThemes.map((theme) =>
    join(resPath, `drawable/balance_widget_${theme.id}_task_circle.xml`),
  ),
  ...darkWidgetThemes.map((theme) =>
    join(resPath, `drawable-night/balance_widget_${theme.id}_task_circle.xml`),
  ),
  ...widgetThemes.map((theme) =>
    join(resPath, `drawable/balance_widget_${theme.id}_reminder_background.xml`),
  ),
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
    const success = /if \(runNativeSync\(applicationContext\.applicationInfo\.dataDir\) == 0\) \{\n(\s*)scheduleNext\(applicationContext\)\n\1Result\.success\(\)\n(\s*)\}/
    if (!success.test(worker)) {
      throw new Error(`Could not find the background sync success path in ${workerPath}`)
    }
    worker = worker.replace(
      success,
      (_match, bodyIndent, closingIndent) =>
        `if (runNativeSync(applicationContext.applicationInfo.dataDir) == 0) {
${bodyIndent}BalanceWidgets.refreshAllAsync(applicationContext)
${bodyIndent}scheduleNext(applicationContext)
${bodyIndent}Result.success()
${closingIndent}}`,
    )
    await writeFile(workerPath, worker)
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

console.log(`Configured Android home-screen widget in ${root}`)
