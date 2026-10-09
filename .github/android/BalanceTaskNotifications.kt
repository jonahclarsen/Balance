package app.balance.local

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import java.lang.ref.WeakReference
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors
import org.json.JSONArray

object BalanceTaskNotifications {
    private const val CHANNEL = "sunset-tasks"
    private const val STORE = "task-notification-registry"
    private var activity = WeakReference<Activity>(null)
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var ciTesting = false
    init { System.loadLibrary("balance_lib") }
    @JvmStatic external fun nativeInitialize(context: Context)
    @JvmStatic external fun nativeRefresh(appDataPath: String): Boolean
    @JvmStatic external fun nativeSyncedFixture(scratchPath: String, at: Long): Boolean

    fun initialize(context: Context) { nativeInitialize(context.applicationContext) }

    fun resume(owner: Activity) {
        activity = WeakReference(owner)
        initialize(owner)
        resetAndRefresh(owner) { runCITest(owner.applicationContext) }
    }

    fun refresh(context: Context, complete: () -> Unit = {}) {
        val app = context.applicationContext
        initialize(app)
        executor.execute {
            try {
                if (!nativeRefresh(app.applicationInfo.dataDir)) Log.w("BalanceNotifications", "Could not refresh task schedules")
            } catch (_: Throwable) { Log.w("BalanceNotifications", "Could not refresh task schedules") }
            finally { complete() }
        }
    }

    private fun alarm(context: Context, id: String, text: String? = null): PendingIntent {
        val intent = Intent(context, BalanceTaskNotificationReceiver::class.java)
            .setAction("app.balance.local.SUNSET_TASK")
            .setData(Uri.parse("balance-notification:" + Uri.encode(id)))
        if (text != null) intent.putExtra("text", text).putExtra("id", id)
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    @JvmStatic fun replace(context: Context, json: String) {
        replaceSchedules(context, json, fromNative = true)
    }

    @Synchronized private fun replaceSchedules(context: Context, json: String, fromNative: Boolean = false) {
        if (fromNative && ciTesting && !json.contains("synthetic-notification-ci")) return
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notifications.createNotificationChannel(NotificationChannel(CHANNEL, "Timed tasks", NotificationManager.IMPORTANCE_HIGH))
        val registry = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        val old = registry.getStringSet("ids", emptySet())!!.toSet()
        val records = JSONArray(json)
        val wanted = mutableSetOf<String>()
        val exact = Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms()
        val update = registry.edit()
        for (index in 0 until records.length()) {
            val record = records.getJSONObject(index)
            val id = record.getString("id")
            val at = record.getLong("at")
            if (at <= System.currentTimeMillis()) continue
            wanted.add(id)
            val text = record.getString("text")
            // Only hashes and identifiers are persisted here. The generated
            // task body is given directly to Android's scheduled PendingIntent.
            val fingerprint = MessageDigest.getInstance("SHA-256").digest("$at:$exact:$text".toByteArray())
                .joinToString("") { "%02x".format(it) }
            if (registry.getString(id, null) != fingerprint) {
                val pending = alarm(context, id, text)
                if (exact) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
                else manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
                update.putString(id, fingerprint)
            }
        }
        for (id in old - wanted) {
            val pending = alarm(context, id)
            manager.cancel(pending)
            pending.cancel()
            update.remove(id)
        }
        update.putStringSet("ids", wanted).apply()
        if (wanted.isNotEmpty()) Handler(Looper.getMainLooper()).post { requestPermissions(context) }
    }

    private fun requestPermissions(context: Context) {
        val owner = activity.get() ?: return
        if (owner.isFinishing || owner.isDestroyed || !owner.hasWindowFocus()) return
        val registry = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 && owner.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            if (!registry.getBoolean("notificationAsked", false)) {
                registry.edit().putBoolean("notificationAsked", true).apply()
                owner.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42819)
            }
            return
        }
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        if (Build.VERSION.SDK_INT >= 31 && !manager.canScheduleExactAlarms() && !registry.getBoolean("exactAsked", false)) {
            registry.edit().putBoolean("exactAsked", true).apply()
            owner.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + context.packageName)))
        }
    }

    @Synchronized fun resetAndRefresh(context: Context, complete: () -> Unit = {}) {
        if (ciTesting) { complete(); return }
        // AlarmManager discards alarms on reboot; fingerprints must be cleared
        // so the same durable records are scheduled again.
        val registry = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        val update = registry.edit()
        for (id in registry.getStringSet("ids", emptySet())!!) update.remove(id)
        update.apply()
        refresh(context, complete)
    }

    fun deliver(context: Context, intent: Intent) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val id = intent.getStringExtra("id") ?: return
        if (!context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getStringSet("ids", emptySet())!!.contains(id)) return
        val text = intent.getStringExtra("text") ?: return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_task_notification)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open).setAutoCancel(true).build()
        manager.notify(id, 0, notification)
    }

    private fun runCITest(context: Context) {
        val marker = File(context.filesDir, "notification-ci-selftest")
        if ((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0 || !marker.exists()) return
        marker.delete()
        ciTesting = true
        val id = "synthetic-notification-ci"
        val body = "Synthetic walk 6:51 PM"
        var stage = "exact permission"
        try {
            val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            check(Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms())
            fun record(at: Long) = JSONArray().put(org.json.JSONObject().put("id", id).put("at", at).put("text", body)).toString()
            stage = "desktop-to-Android encrypted sync and registration"
            check(nativeSyncedFixture(context.cacheDir.absolutePath, System.currentTimeMillis() + 5000))
            stage = "delivery"
            val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // Wait outside the scheduler monitor: startup/resume and boot
            // receivers run on the same main thread that delivers the alarm.
            val deadline = System.currentTimeMillis() + 20000
            fun delivered() = notifications.activeNotifications.any { it.tag == id && it.notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() == body }
            while (!delivered() && System.currentTimeMillis() < deadline) Thread.sleep(250)
            check(delivered())
            stage = "cancellation"
            replaceSchedules(context, record(System.currentTimeMillis() + 300000))
            replaceSchedules(context, "[]")
            val intent = Intent(context, BalanceTaskNotificationReceiver::class.java).setAction("app.balance.local.SUNSET_TASK")
                .setData(Uri.parse("balance-notification:" + Uri.encode(id)))
            check(PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE) == null)
            stage = "re-registration"
            replaceSchedules(context, record(System.currentTimeMillis() + 300000))
            check(PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE) != null)
            replaceSchedules(context, "[]")
            notifications.cancel(id, 0)
            Log.i("BalanceNotifications", "BALANCE_NOTIFICATION_E2E: OK delivered desktop-synced generated text, cancelled and re-registered")
        } catch (_: Throwable) {
            replaceSchedules(context, "[]")
            Log.e("BalanceNotifications", "BALANCE_NOTIFICATION_E2E: FAIL $stage")
        } finally { ciTesting = false; refresh(context) }
    }
}

class BalanceTaskNotificationReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        BalanceTaskNotifications.deliver(context, intent)
    }
}

class BalanceTaskNotificationRestoreReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        // Rebuild from the encrypted planner after reboot, replacement or exact
        // alarm permission grant. No separate plaintext copy of tasks is kept.
        BalanceTaskNotifications.resetAndRefresh(context) { pending.finish() }
    }
}
