package app.balance.local

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import java.lang.ref.WeakReference

/**
 * Bridge for voice ideas (see src/lib/voiceRecorder.ts). Chromium routes a
 * Bluetooth headset's microphone to getUserMedia only while the app may connect
 * to Bluetooth devices, and the recording notification needs its own permission.
 */
internal class BalanceVoiceInput(private val activity: AppCompatActivity) {
    @Volatile private var pending = false
    private val launcher = activity.activityResultRegistry.register(
        "balance-voice-permissions",
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { pending = false }

    private fun missing() = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(Manifest.permission.BLUETOOTH_CONNECT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
    }.filter { activity.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }

    @JavascriptInterface
    fun permissions(): String = when {
        pending -> "pending"
        missing().isEmpty() -> "granted"
        else -> "missing"
    }

    @JavascriptInterface
    fun requestPermissions() {
        val permissions = missing()
        if (permissions.isEmpty() || pending) return
        pending = true
        activity.runOnUiThread { launcher.launch(permissions.toTypedArray()) }
    }

    // Android silences the microphone of a backgrounded app unless a microphone
    // foreground service was started while the app was visible.
    @JavascriptInterface
    fun recordingStarted(startedAt: Long) {
        try {
            activity.startService(Intent(activity, BalanceVoiceRecordingService::class.java).putExtra(STARTED_AT, startedAt))
        } catch (error: IllegalStateException) {
            Log.w("BalanceVoiceInput", "Could not start the recording notification", error)
        }
    }

    // Called after the clip is saved, so the process stays foreground until then.
    @JavascriptInterface
    fun recordingStopped() {
        activity.stopService(Intent(activity, BalanceVoiceRecordingService::class.java))
    }

    companion object {
        const val STARTED_AT = "startedAt"
        private var webView = WeakReference<WebView>(null)

        fun attach(activity: AppCompatActivity, view: WebView) {
            webView = WeakReference(view)
            view.addJavascriptInterface(BalanceVoiceInput(activity), "BalanceVoiceInput")
        }

        // Returns false when no page is left to answer.
        fun requestStop(): Boolean {
            val view = webView.get() ?: return false
            view.evaluateJavascript("window.dispatchEvent(new Event('balance-voice-stop'))", null)
            return true
        }
    }
}

class BalanceVoiceRecordingService : Service() {
    private val handler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopRequested()
        } else {
            val startedAt = intent?.getLongExtra(BalanceVoiceInput.STARTED_AT, 0L)?.takeIf { it > 0 } ?: System.currentTimeMillis()
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    startForeground(NOTIFICATION_ID, notification(startedAt), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
                } else {
                    startForeground(NOTIFICATION_ID, notification(startedAt))
                }
            } catch (error: RuntimeException) {
                Log.w("BalanceVoiceInput", "Could not show the recording notification", error)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun stopRequested() {
        if (!BalanceVoiceInput.requestStop()) {
            stopSelf()
            return
        }
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, builder().setContentTitle("Saving").build())
        // The page calls recordingStopped when the clip is saved. Never leave
        // the notification behind if the page died before answering.
        handler.postDelayed({ stopSelf() }, SAVE_TIMEOUT_MS)
    }

    private fun builder(): Notification.Builder {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Voice recording", NotificationManager.IMPORTANCE_LOW),
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_task_notification)
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
        // Without this, Android may hold the notification back for ten seconds.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        return builder
    }

    private fun notification(startedAt: Long): Notification {
        val stop = PendingIntent.getService(
            this, 0, Intent(this, BalanceVoiceRecordingService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return builder()
            .setContentTitle("Recording")
            .setWhen(startedAt)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_task_notification), "Stop", stop).build())
            .build()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private companion object {
        const val ACTION_STOP = "app.balance.local.STOP_VOICE_RECORDING"
        const val CHANNEL = "voice-recording"
        const val NOTIFICATION_ID = 42820
        const val SAVE_TIMEOUT_MS = 5 * 60 * 1000L
    }
}
