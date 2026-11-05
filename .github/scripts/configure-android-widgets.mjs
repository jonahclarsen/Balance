import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

const root = process.argv[2] ?? 'src-tauri/gen/android/app/src/main'
const activityPath =
  process.argv[3] ?? join(root, 'java/app/balance/local/MainActivity.kt')
const workerPath =
  process.argv[4] ?? join(root, 'java/app/balance/local/BalanceSyncWorker.kt')
const manifestPath = join(root, 'AndroidManifest.xml')
const sourcePath = join(root, 'java/app/balance/local/BalanceWidgets.kt')
const resPath = join(root, 'res')

const source = `package app.balance.local

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
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
    val activeProjects: List<BalanceWidgetProject> = emptyList(),
)

data class BalanceWidgetProject(
    val id: String,
    val name: String,
    val color: String,
    val activeUntilMs: Long,
)

object BalanceWidgets {
    const val ACTION_REFRESH = "app.balance.local.action.REFRESH_WIDGETS"
    const val ACTION_REDRAW = "app.balance.local.action.REDRAW_WIDGETS"
    private const val SELF_TEST_DELAY_MS = 15_000L
    private const val DAY_ROLLOVER_HOUR = 3
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

    fun updateAsync(context: Context, manager: AppWidgetManager, ids: IntArray, finished: () -> Unit) {
        val appContext = context.applicationContext
        executor.execute {
            try {
                update(appContext, manager, ids)
            } catch (error: Throwable) {
                Log.e("BalanceWidgets", "Could not update widgets", error)
            } finally {
                finished()
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
        scheduleProjectExpiry(context, snapshot)
    }

    // A project stops being active at activeUntil, which can pass while the
    // app is closed. Redraw then; an inexact alarm needs no extra permission.
    private fun scheduleProjectExpiry(context: Context, snapshot: BalanceWidgetSnapshot) {
        val now = System.currentTimeMillis()
        val next = snapshot.activeProjects.map { it.activeUntilMs }.filter { it > now }.minOrNull()
        val alarm = context.getSystemService(AlarmManager::class.java) ?: return
        val intent = Intent(context, BalanceHomeWidgetProvider::class.java).setAction(ACTION_REDRAW)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getBroadcast(context, 43, intent, flags)
        if (next == null) alarm.cancel(pending) else alarm.set(AlarmManager.RTC, next, pending)
    }

    private fun parseProjects(json: JSONObject): List<BalanceWidgetProject> {
        val values = json.optJSONArray("activeProjects") ?: return emptyList()
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        val projects = ArrayList<BalanceWidgetProject>(values.length())
        for (index in 0 until values.length()) {
            val value = values.optJSONObject(index) ?: continue
            val id = value.optString("id", "")
            val activeUntil = try {
                format.parse(value.optString("activeUntil", ""))?.time
            } catch (_: java.text.ParseException) {
                null
            } ?: continue
            if (id.isEmpty()) continue
            projects.add(
                BalanceWidgetProject(id, value.optString("name", ""), value.optString("color", ""), activeUntil),
            )
        }
        return projects
    }

    private fun loadSnapshot(context: Context): BalanceWidgetSnapshot {
        val currentDay = Calendar.getInstance()
        if (currentDay.get(Calendar.HOUR_OF_DAY) < DAY_ROLLOVER_HOUR) {
            currentDay.add(Calendar.DAY_OF_MONTH, -1)
        }
        val date = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(currentDay.time)
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
            parseProjects(json),
        )
    }

    private fun renderHome(context: Context, snapshot: BalanceWidgetSnapshot): RemoteViews {
        val views = RemoteViews(context.packageName, themeLayout(snapshot.themeId))
        views.setTextViewText(R.id.widget_brand, brandText(context, snapshot.themeId))
        val situate = BalanceSituate.status(context).optJSONArray("modes") ?: org.json.JSONArray()
        val pillIds = intArrayOf(R.id.widget_situate_1, R.id.widget_situate_2, R.id.widget_situate_3)
        val activeModes = (0 until situate.length()).map { situate.getJSONObject(it) }.filter { it.optBoolean("active") }
        for ((index, viewId) in pillIds.withIndex()) {
            val mode = activeModes.getOrNull(index)
            views.setViewVisibility(viewId, if(mode == null) View.GONE else View.VISIBLE)
            if(mode != null) {
                views.setTextViewText(viewId, mode.getString("name"))
                val intent = Intent(context, MainActivity::class.java).setData(android.net.Uri.parse("balance://situate?mode=" + android.net.Uri.encode(mode.getString("id"))))
                views.setOnClickPendingIntent(viewId, PendingIntent.getActivity(context, 6700 + index, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            }
        }
        renderProjects(context, views, snapshot)
        views.setTextViewText(
            R.id.widget_title,
            snapshot.title.ifBlank { "Today’s plan" },
        )
        views.setTextViewText(R.id.widget_date, "TODAY")
        val headingVisibility = if (snapshot.hasPlan && !snapshot.unavailable) View.VISIBLE else View.GONE
        views.setViewVisibility(R.id.widget_date, headingVisibility)
        views.setViewVisibility(R.id.widget_title, headingVisibility)
        views.setTextViewText(R.id.widget_progress, compactStatus(snapshot))
        views.setContentDescription(R.id.widget_progress, status(snapshot))
        views.setViewVisibility(
            R.id.widget_progress,
            if (snapshot.hasPlan || snapshot.unavailable) View.VISIBLE else View.GONE,
        )
        val showProgress = snapshot.hasPlan && !snapshot.unavailable && snapshot.total > 0
        views.setProgressBar(
            R.id.widget_progress_bar,
            snapshot.total.coerceAtLeast(1),
            snapshot.done.coerceIn(0, snapshot.total.coerceAtLeast(1)),
            false,
        )
        views.setViewVisibility(
            R.id.widget_progress_glow,
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

    private fun renderProjects(context: Context, views: RemoteViews, snapshot: BalanceWidgetSnapshot) {
        val now = System.currentTimeMillis()
        val projects = snapshot.activeProjects.filter { it.activeUntilMs > now }
        val rows = intArrayOf(R.id.widget_project_row_1, R.id.widget_project_row_2, R.id.widget_project_row_3)
        val dots = intArrayOf(R.id.widget_project_dot_1, R.id.widget_project_dot_2, R.id.widget_project_dot_3)
        val names = intArrayOf(R.id.widget_project_1, R.id.widget_project_2, R.id.widget_project_3)
        for (index in rows.indices) {
            val project = projects.getOrNull(index)
            views.setViewVisibility(rows[index], if (project == null) View.GONE else View.VISIBLE)
            if (project == null) continue
            views.setTextViewText(names[index], project.name.ifBlank { "Untitled project" })
            views.setContentDescription(rows[index], project.name + ", active project")
            // The generated dot already uses the theme accent; tint only valid colors.
            val color = if (Regex("#[0-9A-Fa-f]{6}").matches(project.color)) {
                android.graphics.Color.parseColor(project.color)
            } else {
                null
            }
            if (color != null) views.setInt(dots[index], "setColorFilter", color)
            val intent = Intent(context, MainActivity::class.java)
                .setData(android.net.Uri.parse("balance://projects/" + android.net.Uri.encode(project.id)))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            views.setOnClickPendingIntent(
                rows[index],
                PendingIntent.getActivity(
                    context,
                    6900 + index,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
        }
        views.setViewVisibility(R.id.widget_projects, if (projects.isEmpty()) View.GONE else View.VISIBLE)
    }

    private fun brandText(context: Context, themeId: String): CharSequence {
        if (themeId != "iridescent") return "Balance"
        val dark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES
        val colors = if (dark) {
            intArrayOf(
                0xFFEF77BC.toInt(),
                0xFFC184DB.toInt(),
                0xFF929CDF.toInt(),
                0xFF61BDC9.toInt(),
                0xFFA7BA94.toInt(),
                0xFFEAA47F.toInt(),
                0xFFEF77BC.toInt(),
            )
        } else {
            intArrayOf(
                0xFFA13C91.toInt(),
                0xFF8251AA.toInt(),
                0xFF5E62AA.toInt(),
                0xFF367B8F.toInt(),
                0xFF6B755C.toInt(),
                0xFF9D614B.toInt(),
                0xFFA13C91.toInt(),
            )
        }
        return SpannableString("Balance").apply {
            colors.forEachIndexed { index, color ->
                setSpan(
                    ForegroundColorSpan(color),
                    index,
                    index + 1,
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
            }
        }
    }

    private fun themeLayout(themeId: String): Int = when (themeId) {
        "iridescent" -> R.layout.balance_home_widget_iridescent
        "windows98" -> R.layout.balance_home_widget_windows98
        "windowsxp" -> R.layout.balance_home_widget_windowsxp
        "windowsvista" -> R.layout.balance_home_widget_windowsvista
        "system1" -> R.layout.balance_home_widget_system1
        "graphite" -> R.layout.balance_home_widget_graphite
        "forest" -> R.layout.balance_home_widget_forest
        "ocean" -> R.layout.balance_home_widget_ocean
        "orange" -> R.layout.balance_home_widget_orange
        "earth" -> R.layout.balance_home_widget_earth
        "crimson" -> R.layout.balance_home_widget_crimson
        "banana" -> R.layout.balance_home_widget_banana
        "pink" -> R.layout.balance_home_widget_pink
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
        snapshot.total == 0 -> "No tasks"
        snapshot.done == snapshot.total -> "Done"
        else -> "\${snapshot.done}/\${snapshot.total}"
    }

    private fun attachActions(context: Context, views: RemoteViews) {
        views.setOnClickPendingIntent(R.id.widget_root, openAppIntent(context))
        val refresh = Intent(context, BalanceHomeWidgetProvider::class.java)
            .setAction(ACTION_REFRESH)
            .addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
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
    // The snapshot opens the encrypted database and can wait on its lock
    // behind a sync. On the main thread that froze the whole app.
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val pending = goAsync()
        BalanceWidgets.updateAsync(context, manager, ids) { pending.finish() }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == BalanceWidgets.ACTION_REFRESH) {
            val pending = goAsync()
            BalanceWidgets.refreshAllAsync(context) {
                try {
                    BalanceSyncWorker.refreshNow(context) { pending.finish() }
                } catch (error: Throwable) {
                    Log.e("BalanceWidgets", "Could not schedule widget sync", error)
                    pending.finish()
                }
            }
        } else if (intent.action == BalanceWidgets.ACTION_REDRAW) {
            val pending = goAsync()
            BalanceWidgets.refreshAllAsync(context) { pending.finish() }
        } else {
            super.onReceive(context, intent)
        }
    }
}
`

// Historical days may reference every shipped theme forever. Never delete a
// palette; retire the theme from current selection and Random mode instead.
const widgetThemes = [
  { id: 'iridescent', paper: '#FFFDFE', surface: '#FFFFFF', ink: '#282134', muted: '#736B80', line: '#DDD3E6', accent: '#A13C91', brand: '#A13C91', statusAccent: '#7B5BD6', taskAccent: '#7B5BD6', doneAccent: '#28A987', progressAccent: '#7B5BD6', progressColors: ['#4257C9', '#C85FB0', '#F9A94F'], timePill: '#52798A', timePillGradients: [['#4257A8', '#6655A7'], ['#6B4F92', '#87527F'], ['#34726F', '#466C91'], ['#825A4B', '#7E526C']], timePillInk: '#FFFFFF', backgroundColors: ['#F8F3FB', '#F2F8FA', '#FAF6EF'] },
  { id: 'forest', paper: '#FFFDF8', surface: '#FFFFFF', ink: '#1D2428', muted: '#687276', line: '#D8D4CA', accent: '#2F6F68' },
  { id: 'ocean', paper: '#F9FCFF', surface: '#FFFFFF', ink: '#172733', muted: '#637581', line: '#CCD9E1', accent: '#276A9F' },
  { id: 'violet', paper: '#FCFAFF', surface: '#FFFFFF', ink: '#292332', muted: '#756C7F', line: '#DAD2E2', accent: '#7355A2' },
  { id: 'orange', paper: '#FFFDF9', surface: '#FFFFFF', ink: '#30271F', muted: '#796D61', line: '#E4D8CA', accent: '#B96F25' },
  { id: 'earth', paper: '#FCFAF6', surface: '#FFFFFF', ink: '#2D2924', muted: '#756E65', line: '#DED7CD', accent: '#796451' },
  { id: 'crimson', paper: '#FFFAFB', surface: '#FFFFFF', ink: '#321F23', muted: '#78666A', line: '#E1CFD3', accent: '#A92F42' },
  { id: 'banana', paper: '#FFFDF8', surface: '#FFFFFF', ink: '#302D24', muted: '#777164', line: '#E2DED0', accent: '#827136' },
  { id: 'pink', paper: '#FFF9FC', surface: '#FFFFFF', ink: '#31232B', muted: '#7D6A74', line: '#E6D0DC', accent: '#C33F7A' },
  { id: 'midnight', paper: '#FAFBFE', surface: '#FFFFFF', ink: '#202738', muted: '#687083', line: '#D1D6E2', accent: '#425B9B' },
  { id: 'graphite', paper: '#F9F9F7', surface: '#FFFFFF', ink: '#191918', muted: '#6D6D69', line: '#D1D1CD', accent: '#3A3A38' },
  { id: 'windows98', paper: '#FFFFFF', surface: '#C0C0C0', ink: '#000000', muted: '#404040', line: '#808080', accent: '#000080', taskAccent: '#000080', doneAccent: '#006060', timePill: '#DFDFDF', timePillInk: '#000080' },
  { id: 'system1', paper: '#FFFFFF', surface: '#FFFFFF', ink: '#000000', muted: '#404040', line: '#000000', accent: '#000000', taskAccent: '#000000', doneAccent: '#404040', timePill: '#FFFFFF', timePillInk: '#000000' },
  { id: 'windowsxp', paper: '#FFFFFF', surface: '#ECE9D8', ink: '#000000', muted: '#454339', line: '#ACA899', accent: '#0055B8', taskAccent: '#0055B8', doneAccent: '#347B2A', timePill: '#F5F3E9', timePillInk: '#003B82' },
  { id: 'windowsvista', paper: '#FFFFFF', surface: '#EFF7FB', ink: '#14232D', muted: '#455E6D', line: '#7E9DAD', accent: '#176B98', taskAccent: '#176B98', doneAccent: '#277B50', timePill: '#E4F1F9', timePillInk: '#174F70' },
]

const darkWidgetThemes = [
  { id: 'iridescent', paper: '#1F1926', surface: '#2A2232', ink: '#F4EDF6', muted: '#B5A6BD', line: '#493B54', accent: '#F5B8E3', brand: '#EF77BC', statusAccent: '#B79AF2', taskAccent: '#B79AF2', doneAccent: '#65CFAA', progressAccent: '#B79AF2', progressColors: ['#4257C9', '#C85FB0', '#F9A94F'], timePill: '#4C6877', timePillGradients: [['#4A5E91', '#645586'], ['#654F80', '#80536F'], ['#3F706B', '#4B6684'], ['#7B594C', '#78526A']], timePillInk: '#FFFFFF', backgroundColors: ['#3D2B39', '#274144', '#493D2E'] },
  { id: 'forest', paper: '#1B201F', surface: '#232A28', ink: '#E7ECE8', muted: '#9BA8A3', line: '#34403C', accent: '#79B9AE' },
  { id: 'ocean', paper: '#18222B', surface: '#202D38', ink: '#E8F0F6', muted: '#9FB0BD', line: '#30414E', accent: '#73B7E6' },
  { id: 'violet', paper: '#201C25', surface: '#29232F', ink: '#EEE9F2', muted: '#AFA3B8', line: '#42384B', accent: '#B69ADB' },
  { id: 'orange', paper: '#231F1A', surface: '#2D2821', ink: '#F2ECE5', muted: '#B7AA9D', line: '#473E34', accent: '#DFA15F' },
  { id: 'earth', paper: '#201B17', surface: '#2A231E', ink: '#F0EBE5', muted: '#AFA49A', line: '#40362E', accent: '#BDA58F' },
  { id: 'crimson', paper: '#24181B', surface: '#2E2023', ink: '#F2E8EA', muted: '#BAA4A9', line: '#4B3439', accent: '#E67F8E' },
  { id: 'banana', paper: '#211F18', surface: '#2B2920', ink: '#EEEADE', muted: '#AAA38F', line: '#403C30', accent: '#C3B574' },
  { id: 'pink', paper: '#261A20', surface: '#312229', ink: '#F4E8EE', muted: '#BAA3AF', line: '#4D3541', accent: '#F08DB8' },
  { id: 'midnight', paper: '#181C29', surface: '#212638', ink: '#E9ECF5', muted: '#A1A9BD', line: '#343B52', accent: '#91A7E4' },
  { id: 'graphite', paper: '#161617', surface: '#202022', ink: '#F0F0ED', muted: '#A1A19D', line: '#343436', accent: '#70706E', timePillInk: '#FFFFFF' },
  { id: 'windows98', paper: '#202020', surface: '#303030', ink: '#F2F2F2', muted: '#C0C0C0', line: '#808080', accent: '#80D0D0', taskAccent: '#80D0D0', doneAccent: '#80C0B0', timePill: '#303030', timePillInk: '#80D0D0' },
  { id: 'system1', paper: '#101010', surface: '#181818', ink: '#FFFFFF', muted: '#BDBDBD', line: '#BDBDBD', accent: '#FFFFFF', taskAccent: '#FFFFFF', doneAccent: '#BDBDBD', timePill: '#181818', timePillInk: '#FFFFFF' },
  { id: 'windowsxp', paper: '#202631', surface: '#303846', ink: '#F4F4EF', muted: '#C1C7D2', line: '#727E91', accent: '#8ABEFF', taskAccent: '#8ABEFF', doneAccent: '#9ACB82', timePill: '#303846', timePillInk: '#C5DEFF' },
  { id: 'windowsvista', paper: '#17242C', surface: '#20343E', ink: '#F1F7FA', muted: '#BED0D9', line: '#658B9E', accent: '#99D9FA', taskAccent: '#99D9FA', doneAccent: '#94DAB0', timePill: '#203E4F', timePillInk: '#C5ECFF' },
]

const alphaColor = (hex, alpha) => `#${alpha}${hex.slice(1)}`

// Retro themes draw the widget as a window from their operating system, like
// the macOS widget. Launchers don't clip these widgets, so the window itself is
// the widget's shape and needs no desktop around it as on macOS. Tahoma can't
// be redistributed, so XP uses Android's sans.
const widgetFontFiles = [
  'balance_chicago',
  'balance_geneva',
  'balance_ms_sans',
  'balance_ms_sans_bold',
  'balance_selawik',
  'balance_selawik_bold',
]
const retroWindows = {
  windowsxp: () => ({
    frame: '#0055EA',
    corners: 8,
    bottomCorners: 0,
    controlRadius: 0,
    clientInset: 4,
    captionInk: '#FFFFFF',
    captionShadow: '#0F1089',
    captionPaddingStart: 12,
    markerFace: ['#DCDCD7', '#FFFFFF'],
    markerBorder: '#1D5281',
    progressRadius: 3,
    progressBlocks: ['#ACEDAD', '#7BE47D', '#4CDA50', '#2ED330', '#42D845', '#76E275', '#8FE791'],
    fonts: { caption: 'sans-serif-medium', status: 'sans-serif', eyebrow: 'sans-serif-medium', title: 'sans-serif-medium', body: 'sans-serif', time: 'sans-serif' },
    sizes: { caption: 15, status: 13, eyebrow: 10, title: 16, body: 13, time: 10, marker: 13 },
  }),
  windowsvista: (dark) => ({
    corners: 7,
    controlRadius: 2,
    clientInset: 5,
    glass: dark ? ['#3B6179', '#1A3544', '#162E3D'] : ['#EEFAFF', '#75A8C2', '#5893AC'],
    captionGlow: dark ? '#071821' : '#FFFFFF',
    captionPaddingStart: 12,
    markerFace: ['#D4D4D4', '#F6F6F6'],
    markerBorder: '#8E8F8F',
    progressRadius: 2,
    fonts: { caption: '@font/balance_selawik', status: '@font/balance_selawik', eyebrow: '@font/balance_selawik_bold', title: '@font/balance_selawik_bold', body: '@font/balance_selawik', time: '@font/balance_selawik' },
    sizes: { caption: 16, status: 14, eyebrow: 10, title: 16, body: 14, time: 11, marker: 13 },
  }),
  windows98: (dark) => ({
    corners: 0,
    controlRadius: 0,
    clientInset: 0,
    windowPadding: 3,
    bevel: [dark ? '#737373' : '#FFFFFF', '#000000'],
    captionInk: '#FFFFFF',
    captionPaddingStart: 6,
    captionGradient: ['#000080', '#1084D0'],
    progressRadius: 0,
    progressBlocks: 'accent',
    fonts: { caption: '@font/balance_ms_sans_bold', status: '@font/balance_ms_sans', eyebrow: '@font/balance_ms_sans_bold', title: '@font/balance_ms_sans_bold', body: '@font/balance_ms_sans', time: '@font/balance_ms_sans' },
    sizes: { caption: 13, status: 13, eyebrow: 11, title: 14, body: 13, time: 11, marker: 13 },
  }),
  system1: () => ({
    corners: 0,
    controlRadius: 0,
    clientInset: 0,
    windowPadding: 1,
    pinstripes: true,
    captionPaddingStart: 6,
    progressRadius: 0,
    fonts: { caption: '@font/balance_chicago', status: '@font/balance_chicago', eyebrow: '@font/balance_chicago', title: '@font/balance_chicago', body: '@font/balance_geneva', time: '@font/balance_geneva' },
    sizes: { caption: 16, status: 16, eyebrow: 12, title: 16, body: 16, time: 14, marker: 12 },
  }),
}
const withRetroWindow = (theme, dark) => ({ ...theme, window: retroWindows[theme.id]?.(dark) })

const fontName = (theme, role, fallback) => theme.window?.fonts[role] ?? fallback
const textSize = (theme, role, fallback) => theme.window?.sizes[role] ?? fallback
const fontAttribute = (theme, role) =>
  theme.window ? `\n        android:fontFamily="${theme.window.fonts[role]}"` : ''
const captionInk = (theme) => theme.window?.captionInk ?? theme.ink

function pngTile(width, height, pixel) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = pixel(x, y)
      if (!color) continue
      const offset = y * (width * 4 + 1) + 1 + x * 4
      raw.writeUInt32BE(Number.parseInt(`${color.slice(1)}FF`, 16), offset)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Physical-pixel tiles: 15px is about 5dp on a typical phone.
const pinstripeTile = (theme) =>
  pngTile(4, 15, (_x, y) => (y >= 6 && y < 9 ? theme.ink : theme.paper))
function progressBlockTile(theme) {
  const colors = theme.window.progressBlocks === 'accent' ? [theme.accent] : theme.window.progressBlocks
  return pngTile(30, 33, (x, y) => (x < 24 ? colors[Math.floor((y / 33) * colors.length)] : null))
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
    const timePillVariant = theme.timePillGradients
      ? `_${(index % theme.timePillGradients.length) + 1}`
      : ''
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

        <ImageView
            android:layout_width="${textSize(theme, 'marker', 11)}dp"
            android:layout_height="${textSize(theme, 'marker', 11)}dp"
            android:layout_marginEnd="8dp"
            android:contentDescription="@null"
            android:importantForAccessibility="no"
            android:src="@drawable/balance_widget_${theme.id}_task_circle" />

        <TextView
            android:id="@+id/widget_item_time_${item}"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginEnd="6dp"
            android:background="@drawable/balance_widget_${theme.id}_time_pill${timePillVariant}"
            android:fontFamily="${fontName(theme, 'time', 'sans-serif')}"
            android:maxLines="1"
            android:paddingBottom="2dp"
            android:paddingEnd="6dp"
            android:paddingStart="6dp"
            android:paddingTop="2dp"
            android:textColor="${theme.timePillInk ?? theme.paper}"
            android:textSize="${textSize(theme, 'time', 9)}sp"${time} />

        <TextView
            android:id="@+id/widget_item_${item}"
            style="@style/BalanceWidgetItem"${theme.window ? `
            android:fontFamily="${theme.window.fonts.body}"
            android:textSize="${theme.window.sizes.body}sp"` : ''}
            android:textColor="${theme.ink}"${text} />
    </LinearLayout>`
  }).join('\n')
}

function projectRows(theme) {
  return Array.from({ length: 3 }, (_, index) => {
    const item = index + 1
    return `                <LinearLayout
                    android:id="@+id/widget_project_row_${item}"
                    android:layout_width="match_parent"
                    android:layout_height="wrap_content"
                    android:gravity="center_vertical"
                    android:minHeight="32dp"
                    android:orientation="horizontal"
                    android:visibility="gone">
                    <ImageView
                        android:id="@+id/widget_project_dot_${item}"
                        android:layout_width="7dp"
                        android:layout_height="7dp"
                        android:layout_marginEnd="6dp"
                        android:contentDescription="@null"
                        android:importantForAccessibility="no"
                        android:src="@drawable/balance_widget_${theme.id}_project_dot" />
                    <TextView
                        android:id="@+id/widget_project_${item}"
                        android:layout_width="0dp"
                        android:layout_height="wrap_content"
                        android:layout_weight="1"
                        android:ellipsize="end"
                        android:fontFamily="${fontName(theme, 'body', 'sans-serif-medium')}"
                        android:maxLines="1"
                        android:textColor="${theme.ink}"
                        android:textSize="${textSize(theme, 'body', 12)}sp" />
                </LinearLayout>`
  }).join('\n')
}

function situateRow(theme) {
  return `<LinearLayout android:layout_width="match_parent" android:layout_height="wrap_content" android:orientation="horizontal">
        ${[1,2,3].map(index => `<TextView android:id="@+id/widget_situate_${index}" android:background="@drawable/balance_widget_${theme.id}_pill" android:layout_marginEnd="6dp" android:layout_width="wrap_content" android:layout_height="wrap_content" android:minHeight="48dp" android:gravity="center" android:paddingHorizontal="8dp" android:textSize="12sp" android:textColor="${theme.accent}" android:visibility="gone" />`).join('\n')}
    </LinearLayout>`
}

function planBody(theme) {
  const block = theme.window ? 12 : 8
  const inset = theme.window ? 0 : 2
  return `<TextView
        android:id="@+id/widget_reminder"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="9dp"
        android:ellipsize="end"${fontAttribute(theme, 'body')}
        android:maxLines="2"
        android:text="This shouldn’t be aspirational"
        android:textColor="${theme.muted}"
        android:textSize="${textSize(theme, 'body', 12)}sp" />

    <FrameLayout
        android:id="@+id/widget_progress_glow"
        android:layout_width="match_parent"
        android:layout_height="${block}dp"
        android:layout_marginTop="6dp"
        android:background="@drawable/balance_widget_${theme.id}_progress_glow"
        android:padding="${inset}dp">
        <ProgressBar
            android:id="@+id/widget_progress_bar"
            style="?android:attr/progressBarStyleHorizontal"
            android:layout_width="match_parent"
            android:layout_height="match_parent"
            android:indeterminate="false"
            android:progress="33"
            android:progressDrawable="@drawable/balance_widget_${theme.id}_progress" />
    </FrameLayout>

    <TextView
        android:id="@+id/widget_all_done"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="9dp"
        android:fontFamily="${fontName(theme, 'title', 'sans-serif-medium')}"
        android:text="✓  All done"
        android:textColor="${theme.doneAccent ?? theme.accent}"
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
    </LinearLayout>`
}

function retroHomeLayout(theme) {
  const win = theme.window
  const shadow = win.captionShadow
    ? `
            android:shadowColor="${win.captionShadow}"
            android:shadowDx="1"
            android:shadowDy="1"
            android:shadowRadius="1"`
    : win.captionGlow
      ? `
            android:shadowColor="${win.captionGlow}"
            android:shadowRadius="8"`
      : ''
  const knockout = win.pinstripes ? `\n            android:background="${theme.paper}"` : ''
  const spacer = `<TextView
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1" />`
  return `<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/widget_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/balance_widget_${theme.id}_background"
    android:clickable="true">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        android:background="@drawable/balance_widget_${theme.id}_window"
        android:orientation="vertical"
        android:padding="${win.windowPadding ?? 0}dp">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="36dp"
        android:background="@drawable/balance_widget_${theme.id}_caption"
        android:gravity="center_vertical"
        android:orientation="horizontal"
        android:paddingEnd="48dp"
        android:paddingStart="${win.captionPaddingStart}dp">
        ${win.pinstripes ? spacer : ''}
        <TextView
            android:id="@+id/widget_brand"
            android:layout_width="${win.pinstripes ? 'wrap_content' : '0dp'}"
            android:layout_height="wrap_content"${win.pinstripes ? '' : '\n            android:layout_weight="1"'}${knockout}
            android:fontFamily="${win.fonts.caption}"
            android:maxLines="1"
            android:paddingEnd="6dp"
            android:paddingStart="${win.pinstripes ? 6 : 0}dp"${shadow}
            android:text="Balance"
            android:textColor="${captionInk(theme)}"
            android:textSize="${win.sizes.caption}sp" />
        ${win.pinstripes ? spacer : ''}
        <TextView
            android:id="@+id/widget_progress"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"${knockout}
            android:fontFamily="${win.fonts.status}"
            android:gravity="center"
            android:maxLines="1"
            android:paddingEnd="4dp"
            android:paddingStart="4dp"${shadow}
            android:text="2/6"
            android:textColor="${captionInk(theme)}"
            android:textSize="${win.sizes.status}sp" />
    </LinearLayout>

    ${win.pinstripes ? `<TextView
        android:layout_width="match_parent"
        android:layout_height="1dp"
        android:background="${theme.ink}" />` : ''}

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_marginBottom="${win.clientInset}dp"
        android:layout_marginEnd="${win.clientInset}dp"
        android:layout_marginStart="${win.clientInset}dp"
        android:layout_weight="1"
        android:background="@drawable/balance_widget_${theme.id}_face"
        android:orientation="vertical"
        android:padding="12dp">

    <LinearLayout
        android:id="@+id/widget_projects"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="vertical"
        android:visibility="gone">
${projectRows(theme)}
    </LinearLayout>

    <TextView
        android:id="@+id/widget_date"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:fontFamily="${win.fonts.eyebrow}"
        android:letterSpacing="0.08"
        android:text="TODAY"
        android:textColor="${theme.accent}"
        android:textSize="${win.sizes.eyebrow}sp" />

    <TextView
        android:id="@+id/widget_title"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:ellipsize="end"
        android:fontFamily="${win.fonts.title}"
        android:maxLines="2"
        android:text="Today’s plan"
        android:textColor="${theme.ink}"
        android:textSize="${win.sizes.title}sp" />

    ${situateRow(theme)}

    ${planBody(theme)}
    </LinearLayout>
    </LinearLayout>

    <FrameLayout
        android:id="@+id/widget_refresh_touch_target"
        android:layout_width="48dp"
        android:layout_height="48dp"
        android:layout_gravity="top|end"
        android:contentDescription="Sync and refresh Balance widget">
        <ImageView
            android:id="@+id/widget_refresh"
            android:layout_width="36dp"
            android:layout_height="36dp"
            android:layout_gravity="top|end"
            android:background="@drawable/balance_widget_${theme.id}_refresh_background"
            android:contentDescription="@null"
            android:importantForAccessibility="no"
            android:padding="9dp"
            android:src="@drawable/balance_widget_${theme.id}_refresh_arrow" />
    </FrameLayout>
</FrameLayout>
`
}

function homeLayout(theme) {
  if (theme.window) return retroHomeLayout(theme)
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
                android:id="@+id/widget_brand"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:fontFamily="sans-serif-rounded"
                android:text="Balance"
                android:textColor="${theme.brand ?? theme.ink}"
                android:textSize="20sp"
                android:textStyle="bold" />
            <LinearLayout
                android:id="@+id/widget_projects"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:orientation="vertical"
                android:visibility="gone">
${projectRows(theme)}
            </LinearLayout>
            <TextView
                android:id="@+id/widget_date"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:layout_marginTop="5dp"
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
            android:textColor="${theme.statusAccent ?? theme.accent}"
            android:textSize="11sp" />

        <FrameLayout
            android:id="@+id/widget_refresh_touch_target"
            android:layout_width="56dp"
            android:layout_height="56dp"
            android:layout_marginStart="2dp"
            android:contentDescription="Sync and refresh Balance widget">
            <ImageView
                android:id="@+id/widget_refresh"
                android:layout_width="32dp"
                android:layout_height="32dp"
                android:layout_gravity="center"
                android:background="@drawable/balance_widget_${theme.id}_refresh_background"
                android:contentDescription="@null"
                android:importantForAccessibility="no"
                android:padding="7dp"
                android:src="@drawable/balance_widget_${theme.id}_refresh_arrow" />
        </FrameLayout>
    </LinearLayout>

    ${situateRow(theme)}

    ${planBody(theme)}
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

const shapeFile = (body, shape = 'rectangle') => `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="${shape}">
    ${body}
</shape>
`
const transparentShape = shapeFile('<solid android:color="@android:color/transparent" />')

function retroBackground(theme) {
  const win = theme.window
  // Windows 98 and System 1 draw their square frame on the window surface.
  if (!win.glass && !win.frame) return transparentShape
  const fill = win.glass
    ? `<gradient android:angle="315" android:startColor="${win.glass[0]}" android:centerColor="${win.glass[1]}" android:endColor="${win.glass[2]}" />`
    : `<solid android:color="${win.frame}" />`
  const bottom = win.bottomCorners ?? win.corners
  return shapeFile(`${fill}
    <corners android:topLeftRadius="${win.corners}dp" android:topRightRadius="${win.corners}dp" android:bottomLeftRadius="${bottom}dp" android:bottomRightRadius="${bottom}dp" />`)
}

function retroWindowSurface(theme) {
  const win = theme.window
  if (win.bevel) {
    return `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item><shape><solid android:color="${win.bevel[1]}" /></shape></item>
    <item android:bottom="1dp" android:right="1dp"><shape><solid android:color="${win.bevel[0]}" /></shape></item>
    <item android:bottom="1dp" android:left="1dp" android:right="1dp" android:top="1dp"><shape><solid android:color="${theme.surface}" /></shape></item>
</layer-list>
`
  }
  if (win.pinstripes) {
    return shapeFile(`<solid android:color="${theme.surface}" />
    <stroke android:width="1dp" android:color="${theme.ink}" />`)
  }
  return transparentShape
}

function retroCaption(theme) {
  const win = theme.window
  if (win.pinstripes) {
    return `<?xml version="1.0" encoding="utf-8"?>
<bitmap xmlns:android="http://schemas.android.com/apk/res/android"
    android:src="@drawable/balance_widget_${theme.id}_pinstripes"
    android:tileMode="repeat" />
`
  }
  if (win.captionGradient) {
    return shapeFile(`<gradient android:angle="0" android:startColor="${win.captionGradient[0]}" android:endColor="${win.captionGradient[1]}" />`)
  }
  if (win.glass) {
    return shapeFile(`<gradient android:angle="270" android:startColor="#44FFFFFF" android:endColor="#00FFFFFF" />
    <corners android:topLeftRadius="${win.corners}dp" android:topRightRadius="${win.corners}dp" />`)
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item>
        <shape>
            <gradient android:angle="270" android:centerY="0.1" android:startColor="#0997FF" android:centerColor="#0050EE" android:endColor="#0066FF" />
            <corners android:topLeftRadius="${win.corners}dp" android:topRightRadius="${win.corners}dp" />
        </shape>
    </item>
    <item android:gravity="bottom" android:height="1dp"><shape><solid android:color="#003DD7" /></shape></item>
</layer-list>
`
}

function retroFace(theme) {
  const stroke = theme.window.glass ? `\n    <stroke android:width="1dp" android:color="${theme.line}" />` : ''
  return shapeFile(`<solid android:color="${theme.surface}" />${stroke}`)
}

function retroProgress(theme) {
  const win = theme.window
  const fill = win.progressBlocks
    ? `<bitmap android:src="@drawable/balance_widget_${theme.id}_progress_blocks" android:tileModeX="repeat" android:tileModeY="clamp" />`
    : win.glass
      ? `<shape><gradient android:angle="270" android:startColor="#CFF5CF" android:centerColor="#2AC92A" android:endColor="#8DEB8D" /></shape>`
      : `<shape><solid android:color="${theme.ink}" /></shape>`
  return `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:id="@android:id/background">
        <shape android:shape="rectangle">
            <corners android:radius="${win.progressRadius}dp" />
            <solid android:color="${theme.paper}" />
            <stroke android:width="1dp" android:color="${win.pinstripes ? theme.ink : theme.line}" />
        </shape>
    </item>
    <item android:id="@android:id/progress" android:bottom="2dp" android:left="2dp" android:right="2dp" android:top="2dp">
        <clip>
            ${fill}
        </clip>
    </item>
</layer-list>
`
}

function background(theme) {
  if (theme.window) return retroBackground(theme)
  const fill = theme.backgroundColors
    ? `<gradient
        android:angle="135"
        android:centerColor="${theme.backgroundColors[1]}"
        android:endColor="${theme.backgroundColors[2]}"
        android:startColor="${theme.backgroundColors[0]}" />`
    : `<solid android:color="${theme.paper}" />`
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    ${fill}
    <corners android:radius="24dp" />
    <stroke android:width="1dp" android:color="${theme.line}" />
</shape>
`
}

function pill(theme) {
  const accent = theme.statusAccent ?? theme.accent
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="${alphaColor(accent, '1F')}" />
    <corners android:radius="${theme.window?.controlRadius ?? 999}dp" />
    <stroke android:width="1dp" android:color="${alphaColor(accent, '33')}" />
</shape>
`
}

function refreshBackground(theme) {
  if (theme.window) {
    return theme.window.pinstripes ? shapeFile(`<solid android:color="${theme.paper}" />`) : transparentShape
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="oval">
    <solid android:color="${alphaColor(theme.accent, '1F')}" />
    <stroke android:width="1dp" android:color="${alphaColor(theme.accent, '33')}" />
</shape>
`
}

function refreshArrow(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="${theme.window ? captionInk(theme) : theme.accent}"
        android:pathData="M12,4V1L8,5l4,4V6c3.31,0 6,2.69 6,6 0,1.01 -0.25,1.97 -0.69,2.8l1.46,1.46C19.54,15.03 20,13.57 20,12c0,-4.42 -3.58,-8 -8,-8zM12,18c-3.31,0 -6,-2.69 -6,-6 0,-1.01 0.25,-1.97 0.69,-2.8L5.23,7.74C4.46,8.97 4,10.43 4,12c0,4.42 3.58,8 8,8v3l4,-4 -4,-4v3z" />
</vector>
`
}

function taskSurface(theme) {
  if (theme.window) {
    return shapeFile(`<solid android:color="${theme.paper}" />
    <corners android:radius="${theme.window.controlRadius}dp" />
    <stroke android:width="1dp" android:color="${theme.line}" />`)
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="${theme.surface}" />
    <corners android:radius="10dp" />
    <stroke android:width="1dp" android:color="${alphaColor(theme.line, 'CC')}" />
</shape>
`
}

function timePill(theme, colors) {
  const fill = colors
    ? `<gradient android:angle="0" android:startColor="${colors[0]}" android:endColor="${colors[1]}" />`
    : `<solid android:color="${theme.timePill ?? theme.accent}" />`
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    ${fill}
    <corners android:radius="${theme.window?.controlRadius ?? 999}dp" />${theme.window ? `
    <stroke android:width="1dp" android:color="${theme.line}" />` : ''}
</shape>
`
}

function taskCircle(theme) {
  if (theme.window) {
    const face = theme.window.markerFace
      ? `<gradient android:angle="315" android:startColor="${theme.window.markerFace[0]}" android:endColor="${theme.window.markerFace[1]}" />`
      : `<solid android:color="${theme.paper}" />`
    const border = theme.window.markerBorder ?? (theme.window.pinstripes ? theme.ink : theme.line)
    return shapeFile(`<size android:width="${theme.window.sizes.marker}dp" android:height="${theme.window.sizes.marker}dp" />
    ${face}
    <stroke android:width="1dp" android:color="${border}" />`)
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="oval">
    <size android:width="11dp" android:height="11dp" />
    <solid android:color="@android:color/transparent" />
    <stroke android:width="1.5dp" android:color="${alphaColor(theme.taskAccent ?? theme.accent, 'B3')}" />
</shape>
`
}

function projectDot(theme) {
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="${theme.window ? 'rectangle' : 'oval'}">
    <size android:width="7dp" android:height="7dp" />
    <solid android:color="${theme.accent}" />
</shape>
`
}

function progress(theme) {
  if (theme.window) return retroProgress(theme)
  const fill = theme.progressColors
    ? `<gradient android:angle="0" android:startColor="${theme.progressColors[0]}" android:centerColor="${theme.progressColors[1]}" android:endColor="${theme.progressColors[2]}" />`
    : `<solid android:color="${theme.progressAccent ?? theme.accent}" />`
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
                ${fill}
            </shape>
        </clip>
    </item>
</layer-list>
`
}

function progressGlow(theme) {
  if (theme.window) return transparentShape
  return `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="${alphaColor(theme.progressAccent ?? theme.accent, '1F')}" />
    <corners android:radius="999dp" />
</shape>
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
    android:targetCellHeight="4"
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
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_refresh_arrow.xml`),
    refreshArrow(theme),
  )
  files.set(
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_task_surface.xml`),
    taskSurface(theme),
  )
  files.set(
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_time_pill.xml`),
    timePill(theme),
  )
  theme.timePillGradients?.forEach((colors, index) => {
    files.set(
      join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_time_pill_${index + 1}.xml`),
      timePill(theme, colors),
    )
  })
  files.set(
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_task_circle.xml`),
    taskCircle(theme),
  )
  files.set(
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_project_dot.xml`),
    projectDot(theme),
  )
  files.set(
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_progress.xml`),
    progress(theme),
  )
  files.set(
    join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_progress_glow.xml`),
    progressGlow(theme),
  )
  if (!theme.window) return
  const drawable = (name) => join(resPath, `${drawableDirectory}/balance_widget_${theme.id}_${name}.xml`)
  const tile = (name) => join(resPath, `${drawableDirectory}-nodpi/balance_widget_${theme.id}_${name}.png`)
  files.set(drawable('window'), retroWindowSurface(theme))
  files.set(drawable('caption'), retroCaption(theme))
  files.set(drawable('face'), retroFace(theme))
  if (theme.window.pinstripes) files.set(tile('pinstripes'), pinstripeTile(theme))
  if (theme.window.progressBlocks) files.set(tile('progress_blocks'), progressBlockTile(theme))
}

for (const theme of widgetThemes) {
  addThemeFiles(withRetroWindow(theme, false), 'layout', 'drawable')
}
for (const theme of darkWidgetThemes) {
  addThemeFiles(withRetroWindow(theme, true), 'layout-night', 'drawable-night')
}

for (const [path, content] of files) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

await mkdir(join(resPath, 'font'), { recursive: true })
for (const name of widgetFontFiles) {
  await copyFile(
    join(import.meta.dirname, '../../src-tauri/widget-fonts', `${name}.ttf`),
    join(resPath, `font/${name}.ttf`),
  )
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
    join(resPath, `drawable/balance_widget_${theme.id}_progress_fill.xml`),
  ),
  ...darkWidgetThemes.map((theme) =>
    join(resPath, `drawable-night/balance_widget_${theme.id}_progress_fill.xml`),
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
  // doWork already runs off the UI thread. Complete the redraw before returning
  // success, while WorkManager still keeps the process alive.
  worker = worker.replaceAll('BalanceWidgets.refreshAllAsync(applicationContext)', 'BalanceWidgets.refreshAll(applicationContext)')
  if (!worker.includes('BalanceWidgets.refreshAll(applicationContext)')) {
    const success = /if \(runNativeSync\(applicationContext\.applicationInfo\.dataDir\) == 0\) \{/
    if (!success.test(worker)) {
      throw new Error(`Could not find the background sync success path in ${workerPath}`)
    }
    worker = worker.replace(success, '$&\n                BalanceWidgets.refreshAll(applicationContext)')
  }
  await writeFile(workerPath, worker)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

console.log(`Configured Android home-screen widget in ${root}`)
