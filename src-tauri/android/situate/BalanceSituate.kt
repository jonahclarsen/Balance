package app.balance.local

import android.app.*
import android.content.*
import android.net.Uri
import android.os.Build
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
        SituateAccessibility.appResumed()
        initialize(activity)
        activity.intent?.data?.toString()?.let { if (it.startsWith("balance://")) { nativeDeepLink(it); activity.intent.data = null } }
    }
    fun status(context: Context): JSONObject {
        val file = rules(context)
        return if (file.exists()) JSONObject(nativeStatus(file.readText(), System.currentTimeMillis())) else JSONObject().put("modes", JSONArray())
    }
    fun blocked(context: Context, packageName: String, activeOnly: Boolean = true): List<JSONObject> {
        if (packageName == context.packageName || packageName == "com.android.systemui") return emptyList()
        val modes = status(context).optJSONArray("modes") ?: JSONArray()
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
            try { manager.notify(id.hashCode(), Notification.Builder(context,"situate").setSmallIcon(android.R.drawable.ic_lock_idle_lock).setContentTitle(mode.getString("name") + " " + title).setContentText(mode.optString("description").ifBlank { "Tap to open Situate." }).setContentIntent(pending).setAutoCancel(true).build()) } catch (_: SecurityException) { }
        }
        for (i in 0 until modes.length()) {
            val mode = modes.getJSONObject(i)
            val id = mode.getString("id")
            if (!mode.optBoolean("active")) {
                // A heads-up is announced once per threshold before the mode comes back on.
                if (mode.isNull("soon")) continue
                val minutes = mode.getInt("soon"); val key = "$id:$minutes"; soon.add(key)
                if (announce && !previousSoon.contains(key)) notify(mode, "in $minutes min")
                continue
            }
            active.add(id)
            if (announce && !previous.contains(id)) notify(mode, "is on")
        }
        prefs.edit().putStringSet("active", active).putStringSet("soon", soon).apply()
        val alarm = context.getSystemService(AlarmManager::class.java)
        val pending = PendingIntent.getBroadcast(context, 32741, Intent(context, SituateReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val at = maxOf(System.currentTimeMillis()+1000, status.optLong("refreshAt", System.currentTimeMillis()+3600000))
        if (Build.VERSION.SDK_INT < 31 || alarm.canScheduleExactAlarms()) alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,at,pending)
        else alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,at,pending)
        SituateAccessibility.enforceCurrent()
        BalanceWidgets.refreshAllAsync(context)
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
                val intent = when(query) {
                    "notifications" -> Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                    "mode-notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,context.packageName)
                    "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                    "alarms" -> if(Build.VERSION.SDK_INT >=31) Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,Uri.parse("package:"+context.packageName)) else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+context.packageName))
                    else -> throw IllegalArgumentException("Unknown permission")
                }
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return "Return to Balance after granting access."
            }
            "list" -> return NotificationArchive(context).use { it.list(JSONObject(query)).toString() }
            "open" -> { val id=JSONObject(query).getLong("id"); NotificationArchive(context).use { it.open(id) }; return "{}" }
            "delete-all" -> { NotificationArchive(context).use { it.clear() }; return "{}" }
            "export" -> { context.startActivity(Intent(context,SituateExportActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return "{}" }
            else -> throw IllegalArgumentException("Unknown Situate action")
        }
    }
}
class SituateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context,intent: Intent) { val pending=goAsync(); BalanceSituate.executor.execute { try { BalanceSituate.refresh(context) } finally { pending.finish() } } }
}
class SituateNotifications : NotificationListenerService() {
    override fun onListenerConnected() { BalanceSituate.initialize(this) }
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val appContext = applicationContext
        BalanceSituate.executor.execute {
            try {
                val blocked = BalanceSituate.blocked(appContext,sbn.packageName)
                try {
                    NotificationArchive(appContext).use { it.record(sbn, blocked.map { m -> m.getString("id") }, BalanceSituate.blocked(appContext,sbn.packageName,false).map { m -> m.getString("id") }) }
                } finally {
                    // A full disk or temporarily unavailable key must not disable silencing.
                    if (blocked.isNotEmpty()) cancelNotification(sbn.key)
                }
            } catch (_: Exception) { /* Never log notification contents or keys. */ }
        }
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
