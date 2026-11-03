package app.balance.local

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Process

/** Independent app identity only; never retain a usage log, class names, or event extras. */
class SituateAppIdentity(private val context: Context) {
    data class App(val packageName: String, val at: Long)
    private var queriedAt = 0L
    private var latest: App? = null
    companion object {
        @Suppress("DEPRECATION")
        fun permitted(context: Context): Boolean = context.getSystemService(AppOpsManager::class.java)
            .checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED
    }
    @Suppress("DEPRECATION")
    fun latest(): App? {
        if (!permitted(context)) { queriedAt = 0; latest = null; return null }
        val now = System.currentTimeMillis()
        if (now < queriedAt) { queriedAt = 0; latest = null }
        // One bounded catch-up after process death, then small overlapping queries
        // for late OS deliveries (which can lag more than one polling interval). Only the newest resumed app stays in memory.
        val from = if (queriedAt == 0L) maxOf(0, now - 24 * 60 * 60 * 1000L) else maxOf(0, queriedAt - 60000)
        val events = try { context.getSystemService(UsageStatsManager::class.java).queryEvents(from, now + 1) }
            catch (_: SecurityException) { queriedAt = 0; latest = null; return null }
            ?: return null
        val event = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND && event.timeStamp >= (latest?.at ?: 0)) {
                event.packageName?.let { latest = App(it, event.timeStamp) }
            }
        }
        queriedAt = now
        return latest
    }
}
