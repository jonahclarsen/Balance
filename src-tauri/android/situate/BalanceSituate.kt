package app.balance.local

import android.app.*
import android.content.*
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Handler
import android.os.Looper
import android.os.FileObserver
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityManager
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

object BalanceSituate {
    init { System.loadLibrary("balance_lib") }
    @JvmStatic external fun nativeInitialize(context: Context)
    @JvmStatic external fun nativeStatus(document: String, now: Long): String
    @JvmStatic external fun nativeDeepLink(url: String)
    val executor = Executors.newSingleThreadExecutor()
    private fun rules(context: Context) = File(context.noBackupFilesDir, "situate-rules.json")
    fun initialize(context: Context) { nativeInitialize(context.applicationContext); executor.execute { SituateSelfTest.runIfRequested(context); refresh(context) } }
    fun resume(activity: Activity) {
        SituateAccessibility.appResumed(activity)
        initialize(activity)
        activity.intent?.data?.toString()?.let { if (it.startsWith("balance://")) { nativeDeepLink(it); activity.intent.data = null } }
    }
    fun status(context: Context): JSONObject {
        val file = rules(context)
        return if (file.exists()) JSONObject(nativeStatus(file.readText(), System.currentTimeMillis())) else JSONObject().put("modes", JSONArray())
    }
    fun blocked(context: Context, packageName: String, activeOnly: Boolean = true): List<JSONObject> =
        if (packageName == context.packageName || packageName == "com.android.systemui") emptyList() else blocked(status(context), context, packageName, activeOnly)
    fun blocked(status: JSONObject, context: Context, packageName: String, activeOnly: Boolean = true): List<JSONObject> {
        if (packageName == context.packageName || packageName == "com.android.systemui") return emptyList()
        val modes = status.optJSONArray("modes") ?: JSONArray()
        return (0 until modes.length()).map { modes.getJSONObject(it) }.filter { mode ->
            val targets = mode.optJSONArray(if(activeOnly) "targets" else "allTargets") ?: JSONArray()
            (0 until targets.length()).any { val t=targets.getJSONObject(it); t.optString("kind")=="app" && t.optString("value")==packageName }
        }
    }
    // Saves pass announce=false: a mode switched by hand doesn't need a notice.
    @Synchronized fun refresh(context: Context, announce: Boolean = true) {
        val status = status(context)
        val modes = status.optJSONArray("modes") ?: JSONArray()
        val prefs = context.getSharedPreferences("situate-runtime", Context.MODE_PRIVATE)
        val previous = prefs.getStringSet("active", emptySet()) ?: emptySet()
        val previousSoon = prefs.getStringSet("soon", emptySet()) ?: emptySet()
        val active = mutableSetOf<String>()
        val soon = mutableSetOf<String>()
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("situate", "Situate mode changes", NotificationManager.IMPORTANCE_DEFAULT))
        fun notify(mode: JSONObject, title: String) {
            val id = mode.getString("id")
            val intent = Intent(context, MainActivity::class.java).setData(Uri.parse("balance://situate?mode=" + Uri.encode(id))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val pending = PendingIntent.getActivity(context, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            try { BalanceNotificationStack.post(context, null, id.hashCode(), Notification.Builder(context,"situate").setSmallIcon(android.R.drawable.ic_lock_idle_lock).setContentTitle(mode.getString("name") + " " + title).setContentText(mode.optString("description").ifBlank { "Tap to open Situate." }).setContentIntent(pending).setAutoCancel(true)) } catch (_: SecurityException) { }
        }
        var cleared = false
        for (i in 0 until modes.length()) {
            val mode = modes.getJSONObject(i)
            val id = mode.getString("id")
            val wasOn = previous.contains(id)
            val wasSoon = previousSoon.firstOrNull { it.startsWith("$id:") }
            // A notice outlives its news once the mode changes again without a new one.
            fun clear() { manager.cancel(null, id.hashCode()); cleared = true }
            if (!mode.optBoolean("active")) {
                // A heads-up is announced once per threshold before the mode comes back on.
                if (mode.isNull("soon")) { if (wasOn || wasSoon != null) clear(); continue }
                val minutes = mode.getInt("soon"); val key = "$id:$minutes"; soon.add(key)
                if (announce && wasSoon != key) notify(mode, "in $minutes min")
                else if (wasOn || (wasSoon != null && wasSoon != key)) clear()
                continue
            }
            active.add(id)
            if (announce && !wasOn) notify(mode, "is on")
            else if (!wasOn) clear()
        }
        if (cleared) BalanceNotificationStack.update(context)
        prefs.edit().putStringSet("active", active).putStringSet("soon", soon).apply()
        val alarm = context.getSystemService(AlarmManager::class.java)
        val pending = PendingIntent.getBroadcast(context, 32741, Intent(context, SituateReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val at = maxOf(System.currentTimeMillis()+1000, status.optLong("refreshAt", System.currentTimeMillis()+3600000))
        if (Build.VERSION.SDK_INT < 31 || alarm.canScheduleExactAlarms()) alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,at,pending)
        else alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,at,pending)
        SituateAccessibility.enforceCurrent()
        // The widget shows which modes are on. Redrawing it reads the encrypted
        // database, so skip that on the periodic ticks that change nothing.
        if (active != previous || !announce) BalanceWidgets.refreshAllAsync(context)
    }
    fun permissionStatus(context: Context): JSONObject {
        val notifications = context.getSystemService(NotificationManager::class.java)
        val channel = if (Build.VERSION.SDK_INT >= 26) notifications.getNotificationChannel("situate") else null
        val groupBlocked = if (Build.VERSION.SDK_INT >= 28) channel?.group?.let {
            notifications.getNotificationChannelGroup(it)?.isBlocked
        } == true else false
        val listener = ComponentName(context, SituateNotifications::class.java)
        val listenerGranted = if (Build.VERSION.SDK_INT >= 27) notifications.isNotificationListenerAccessGranted(listener)
            else Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
                ?.split(':')?.any { ComponentName.unflattenFromString(it) == listener } == true
        val accessibility = context.getSystemService(AccessibilityManager::class.java)
            .getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { ComponentName(it.resolveInfo.serviceInfo.packageName, it.resolveInfo.serviceInfo.name) == ComponentName(context, SituateAccessibility::class.java) }
        return JSONObject()
            .put("notifications", listenerGranted)
            .put("accessibility", accessibility)
            .put("usage", SituateAppIdentity.permitted(context))
            .put("mode-notifications", notifications.areNotificationsEnabled() && channel?.importance != NotificationManager.IMPORTANCE_NONE && !groupBlocked)
            .put("alarms", Build.VERSION.SDK_INT < 31 || context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms())
            .put("battery", context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName))
            .put("samsung", Build.MANUFACTURER.equals("samsung", ignoreCase = true))
    }
    // Rust calls this by name through JNI; R8 cannot see that reference.
    @androidx.annotation.Keep
    @JvmStatic fun call(context: Context, action: String, query: String): String {
        when (action) {
            "refresh" -> {
                val document = JSONObject(query).getJSONObject("document")
                val file = rules(context); val tmp = File(file.parentFile,"situate-rules.tmp")
                tmp.writeText(document.toString()); check(tmp.renameTo(file)); SituateAccessibility.enforceCurrent(); executor.execute { refresh(context, false) }; return "{}"
            }
            "permissions" -> {
                if (query == "status") return permissionStatus(context).toString()
                val intent = when(query) {
                    "notifications" -> Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                    "mode-notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,context.packageName)
                    "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                    "usage" -> Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
                    "battery" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+context.packageName))
                    "alarms" -> if(Build.VERSION.SDK_INT >=31) Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,Uri.parse("package:"+context.packageName)) else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+context.packageName))
                    else -> throw IllegalArgumentException("Unknown permission")
                }
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return "Return to Balance after granting access."
            }
            "list", "open", "delete-all" -> return SituateArchiveProvider.request(context, action, query)
            "export" -> { context.startActivity(Intent(context,SituateExportActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return "{}" }
            else -> throw IllegalArgumentException("Unknown Situate action")
        }
    }
}
class SituateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context,intent: Intent) { val pending=goAsync(); BalanceSituate.executor.execute { try { BalanceSituate.refresh(context) } finally { pending.finish() } } }
}
class SituateNotifications : NotificationListenerService() {
    companion object {
        @Volatile private var connected: SituateNotifications? = null
        // Silencing never waits behind archive writes, exports or schedule refreshes.
        private val silencer = Executors.newSingleThreadExecutor()
        private val archiver = Executors.newSingleThreadExecutor()
        private val sweepQueued = java.util.concurrent.atomic.AtomicBoolean(false)
        /** Silences notifications already showing from apps an active mode blocks. */
        private fun sweep() {
            val listener = connected ?: return
            if (!sweepQueued.compareAndSet(false, true)) return
            silencer.execute {
                sweepQueued.set(false)
                if (connected === listener) listener.sweepActive()
            }
        }
    }
    private val main = Handler(Looper.getMainLooper())
    private var observer: FileObserver? = null
    private val tick = object : Runnable {
        override fun run() {
            if (connected !== this@SituateNotifications) return
            // Re-evaluate schedules and passes without the planner or its alarms.
            sweep()
            main.postDelayed(this, 1000)
        }
    }
    override fun onListenerConnected() {
        stopWatching()
        connected = this
        // Only the pure evaluator; never start the planner or widget database here.
        BalanceSituate.nativeInitialize(applicationContext)
        @Suppress("DEPRECATION")
        val watcher = object : FileObserver(noBackupFilesDir.absolutePath, CLOSE_WRITE or MOVED_TO or DELETE) {
            override fun onEvent(event: Int, path: String?) {
                if (path == "situate-rules.json") sweep()
            }
        }
        observer = watcher
        watcher.startWatching()
        main.post(tick)
    }
    private fun stopWatching() {
        main.removeCallbacks(tick)
        observer?.stopWatching()
        observer = null
    }
    override fun onListenerDisconnected() {
        if (connected === this) connected = null
        stopWatching()
        // Android can unbind the listener while Balance is in the background.
        if (Build.VERSION.SDK_INT >= 24) requestRebind(ComponentName(this, SituateNotifications::class.java))
    }
    override fun onDestroy() { if (connected === this) connected = null; stopWatching(); super.onDestroy() }
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val appContext = applicationContext
        silencer.execute {
            // Android hides one-time codes from listeners. Leave those
            // notifications alone so the code arrives, and don't archive them.
            if (SituateRedaction.redacted(sbn.notification)) return@execute
            var blocked = emptyList<String>()
            var targeted = emptyList<String>()
            try {
                val status = BalanceSituate.status(appContext)
                targeted = BalanceSituate.blocked(status, appContext, sbn.packageName, false).map { it.getString("id") }
                if (targeted.isNotEmpty()) {
                    val modes = BalanceSituate.blocked(status, appContext, sbn.packageName).map { it.getString("id") }
                    if (modes.isNotEmpty()) {
                        cancelNotification(sbn.key)
                        blocked = modes
                        SituateCodeNotices.post(appContext, sbn)
                    }
                }
            } catch (_: Exception) { /* Never log notification contents or keys. */ }
            // Archive after silencing; a full disk or unavailable key must not delay it.
            archiver.execute { try { NotificationArchive(appContext).use { it.record(sbn, blocked, targeted) } } catch (_: Exception) { } }
        }
    }
    private fun sweepActive() {
        try {
            val active = activeNotifications ?: return
            val status = BalanceSituate.status(applicationContext)
            val blocked = active.filter { !SituateRedaction.redacted(it.notification) && BalanceSituate.blocked(status, applicationContext, it.packageName).isNotEmpty() }
            if (blocked.isNotEmpty()) cancelNotifications(blocked.map { it.key }.toTypedArray())
            blocked.forEach { SituateCodeNotices.post(applicationContext, it) }
        } catch (_: Exception) { }
    }
}

/** Detects notifications whose text Android replaced because they hold a one-time code. */
object SituateRedaction {
    private const val FALLBACK = "Sensitive notification content hidden"
    @Volatile private var cached: Pair<java.util.Locale, String>? = null
    private fun placeholder(): String {
        val system = android.content.res.Resources.getSystem()
        val locale = system.configuration.locales[0]
        cached?.let { if (it.first == locale) return it.second }
        @Suppress("DiscouragedApi")
        val id = system.getIdentifier("redacted_notification_message", "string", "android")
        val text = if (id != 0) try { system.getString(id) } catch (_: Exception) { FALLBACK } else FALLBACK
        cached = locale to text
        return text
    }
    fun redacted(notification: Notification): Boolean {
        val extras = notification.extras
        @Suppress("DEPRECATION")
        val last = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
            ?.mapNotNull { it as? android.os.Bundle }?.lastOrNull()?.getCharSequence("text")
        val texts = listOf(last, extras.getCharSequence(Notification.EXTRA_TEXT), extras.getCharSequence(Notification.EXTRA_BIG_TEXT))
            .mapNotNull { it?.toString()?.trim() }
        val hidden = setOf(placeholder(), FALLBACK)
        return texts.any { it in hidden }
    }
}

object SituateCodes {
    // Phone numbers ("416-555-1234") and amounts ("$2500") are not codes.
    private val digits = Regex("(?<![\\d+\$€£¥])(?<!\\d[-.\\s/,])\\d{4,8}(?![\\d%])(?![-.\\s/,]\\d)")
    private val phrase = Regex("verification\\s+code", RegexOption.IGNORE_CASE)
    // A lone 4-digit number near the current year reads as a year, not a code.
    fun extract(text: String, year: Int = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR)): String? {
        val codes = digits.findAll(text).map { it.value }.filter {
            it.length != 4 || it.toInt() !in year - 2..year + 6
        }.distinct().take(8).toList()
        return if (codes.isNotEmpty()) codes.joinToString(" · ") else if (phrase.containsMatchIn(text)) "" else null
    }
    fun extract(notification: Notification): String? {
        val extras = notification.extras
        // Only the newest message can produce a code notice. Expanded text may
        // repeat historical messages, including old sign-in codes.
        @Suppress("DEPRECATION")
        val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
            ?.mapNotNull { it as? android.os.Bundle }
        if (!messages.isNullOrEmpty()) return extract(messages.last().getCharSequence("text")?.toString().orEmpty())
        val lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        if (!lines.isNullOrEmpty()) return extract(lines.last().toString())
        val parts = mutableListOf<CharSequence?>(notification.tickerText)
        for (key in listOf(Notification.EXTRA_TITLE, Notification.EXTRA_TITLE_BIG, Notification.EXTRA_TEXT, Notification.EXTRA_BIG_TEXT, Notification.EXTRA_SUB_TEXT, Notification.EXTRA_SUMMARY_TEXT)) parts.add(extras.getCharSequence(key))
        val matches = parts.mapNotNull { it?.toString()?.let { text -> extract(text) } }
        return matches.firstOrNull { it.isNotEmpty() } ?: matches.firstOrNull()
    }
}

/** Replaces blocked code-bearing notifications without copying their message bodies. */
object SituateCodeNotices {
    private const val CHANNEL = "situate-codes"
    // Accessed only on the listener's silencer executor; no disk or planner data.
    private val seen = object : LinkedHashMap<String, Long>(128, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?): Boolean = size > 500
    }
    internal fun builder(context: Context, app: String, code: String): Notification.Builder {
        val open = PendingIntent.getActivity(context, 0,
            Intent(context, MainActivity::class.java).setData(Uri.parse("balance://situate")),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setContentTitle("Sign-in code received")
            .setContentText(if (code.isEmpty()) app else "$code · $app")
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOnlyAlertOnce(true).setAutoCancel(true).setContentIntent(open)
    }
    fun post(context: Context, sbn: StatusBarNotification) {
        val code = SituateCodes.extract(sbn.notification) ?: return
        // Group summaries and children can repeat the same code. Forward once,
        // including when a persistent notification resists Android cancellation.
        val identity = java.security.MessageDigest.getInstance("SHA-256")
            .digest((sbn.packageName + "\u0000" + code).toByteArray()).joinToString("") { "%02x".format(it) }
        val now = android.os.SystemClock.elapsedRealtime()
        if (seen[identity]?.let { now - it < 10 * 60 * 1000 } == true) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Sign-in codes", NotificationManager.IMPORTANCE_HIGH))
        val app = try { context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(sbn.packageName, 0)).toString() }
            catch (_: Exception) { sbn.packageName }
        try {
            BalanceNotificationStack.post(context, "situate-code-$identity", 0, builder(context, app, code))
            seen[identity] = now
        } catch (_: SecurityException) { }
    }
}

class SituateExportActivity : Activity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        if(savedInstanceState==null) startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/x-ndjson").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,"situate-notifications.ndjson"), 1)
    }
    override fun onActivityResult(requestCode: Int,resultCode: Int,data: Intent?) {
        super.onActivityResult(requestCode,resultCode,data)
        val uri=data?.data
        if(resultCode==RESULT_OK && uri!=null) BalanceSituate.executor.execute {
            try { contentResolver.openOutputStream(uri)?.bufferedWriter()?.use { writer -> NotificationArchive(this).use { it.export(writer) } } }
            finally { runOnUiThread { finish() } }
        } else finish()
    }
}
