package app.balance.local

import android.accessibilityservice.AccessibilityService
import android.app.*
import android.content.*
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.view.accessibility.AccessibilityEvent
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
        initialize(activity)
        activity.intent?.data?.toString()?.let { if (it.startsWith("balance://situate")) { nativeDeepLink(it); activity.intent.data = null } }
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
    @Synchronized fun refresh(context: Context) {
        val status = status(context)
        val modes = status.optJSONArray("modes") ?: JSONArray()
        val prefs = context.getSharedPreferences("situate-runtime", Context.MODE_PRIVATE)
        val previous = prefs.getStringSet("active", emptySet()) ?: emptySet()
        val active = mutableSetOf<String>()
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("situate", "Situate mode changes", NotificationManager.IMPORTANCE_DEFAULT))
        for (i in 0 until modes.length()) {
            val mode = modes.getJSONObject(i)
            if (!mode.optBoolean("active")) continue
            val id = mode.getString("id"); active.add(id)
            if (!previous.contains(id)) {
                val intent = Intent(context, MainActivity::class.java).setData(Uri.parse("balance://situate?mode=" + Uri.encode(id))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                val pending = PendingIntent.getActivity(context, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                try { manager.notify(id.hashCode(), Notification.Builder(context,"situate").setSmallIcon(android.R.drawable.ic_lock_idle_lock).setContentTitle(mode.getString("name") + " is on").setContentText("Tap to open Situate.").setContentIntent(pending).setAutoCancel(true).build()) } catch (_: SecurityException) { }
            }
        }
        prefs.edit().putStringSet("active", active).apply()
        val alarm = context.getSystemService(AlarmManager::class.java)
        val pending = PendingIntent.getBroadcast(context, 32741, Intent(context, SituateReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val at = maxOf(System.currentTimeMillis()+1000, status.optLong("refreshAt", System.currentTimeMillis()+3600000))
        if (Build.VERSION.SDK_INT < 31 || alarm.canScheduleExactAlarms()) alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,at,pending)
        else alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,at,pending)
        SituateAccessibility.enforceCurrent()
        BalanceWidgets.refreshAllAsync(context)
    }
    @JvmStatic fun call(context: Context, action: String, query: String): String {
        when (action) {
            "refresh" -> {
                val document = JSONObject(query).getJSONObject("document")
                val file = rules(context); val tmp = File(file.parentFile,"situate-rules.tmp")
                tmp.writeText(document.toString()); check(tmp.renameTo(file)); executor.execute { refresh(context) }; return "{}"
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
class SituateAccessibility : AccessibilityService() {
    private var lastPackage=""
    private var lastAt=0L
    private var foregroundPackage=""
    companion object {
        @Volatile private var current: SituateAccessibility? = null
        fun enforceCurrent() { android.os.Handler(android.os.Looper.getMainLooper()).post { current?.enforce() } }
    }
    override fun onServiceConnected() { super.onServiceConnected(); current=this }
    override fun onDestroy() { if(current===this) current=null; super.onDestroy() }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if(event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg=event.packageName?.toString() ?: return
        if(pkg=="com.android.systemui") return
        foregroundPackage=pkg
        enforce()
    }
    private fun enforce() {
        val pkg=foregroundPackage
        if(pkg.isBlank()) return
        if(pkg==lastPackage && System.currentTimeMillis()-lastAt<1500) return
        val modes = try { BalanceSituate.blocked(this,pkg) } catch (_: Exception) { return }
        if(modes.isEmpty()) return
        lastPackage=pkg; lastAt=System.currentTimeMillis()
        performGlobalAction(GLOBAL_ACTION_HOME)
        val mode=modes.first()
        val targets=mode.getJSONArray("targets")
        val target=(0 until targets.length()).map { targets.getJSONObject(it) }.first { it.optString("value")==pkg }
        val uri=Uri.Builder().scheme("balance").authority("situate").appendQueryParameter("mode",mode.getString("id"))
        if(target.optString("category")=="entertainment") uri.appendQueryParameter("target",target.getString("id"))
        startActivity(Intent(this,SituateBlockedActivity::class.java).putExtra("url",uri.build().toString()).putExtra("mode",mode.getString("name")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
    }
    override fun onInterrupt() { }
}
class SituateBlockedActivity : Activity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        val layout=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(48,100,48,48) }
        layout.addView(TextView(this).apply { text=intent.getStringExtra("mode")+" is on"; textSize=28f })
        layout.addView(TextView(this).apply { text="Take a moment before opening this app."; textSize=18f })
        layout.addView(Button(this).apply { text="Open quiz"; setOnClickListener { startActivity(Intent(this@SituateBlockedActivity,MainActivity::class.java).setData(Uri.parse(intent.getStringExtra("url"))).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)); finish() } })
        layout.addView(Button(this).apply { text="Keep the boundary"; setOnClickListener { finish() } })
        setContentView(layout)
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
