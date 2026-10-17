package app.balance.local

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL

/** Downloads a GitHub release APK straight into Android's package installer. */
object BalanceUpdater {
    private const val LOG_TAG = "BalanceUpdater"
    private const val RELEASE_DOWNLOAD = "https://github.com/jonahclarsen/Balance/releases/download/"
    private const val APK_NAME = "balance-arm64.apk"
    private val TAG_PATTERN = Regex("^v\\d+\\.\\d+\\.\\d+$")

    init { System.loadLibrary("balance_lib") }
    @JvmStatic external fun nativeRegister()

    @Volatile private var context: Context? = null

    fun attach(activity: Context) {
        context = activity.applicationContext
        nativeRegister()
    }

    /** Called on a Rust blocking worker. Returns an empty string once Android has the APK. */
    @JvmStatic fun install(tag: String): String {
        val app = context ?: return "Balance is still starting. Try again in a moment."
        if (!TAG_PATTERN.matches(tag)) return "GitHub's latest release has an unexpected version."
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(app.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // After Balance has installed itself once, later updates need no prompt.
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = try {
            installer.createSession(params)
        } catch (error: Throwable) {
            Log.w(LOG_TAG, "Could not create an install session", error)
            return "Android would not start the update."
        }
        try {
            installer.openSession(sessionId).use { session ->
                val connection = URL(RELEASE_DOWNLOAD + tag + "/" + APK_NAME).openConnection() as HttpURLConnection
                connection.connectTimeout = 15_000
                connection.readTimeout = 30_000
                try {
                    if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                        installer.abandonSession(sessionId)
                        return "GitHub returned ${connection.responseCode} for the update download."
                    }
                    val length = connection.contentLengthLong
                    connection.inputStream.use { input ->
                        session.openWrite(APK_NAME, 0, length).use { output ->
                            input.copyTo(output, 64 * 1024)
                            session.fsync(output)
                        }
                    }
                } finally {
                    connection.disconnect()
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
                val status = PendingIntent.getBroadcast(
                    app,
                    sessionId,
                    Intent(app, BalanceUpdateReceiver::class.java),
                    flags,
                )
                session.commit(status.intentSender)
            }
            return ""
        } catch (error: Throwable) {
            Log.w(LOG_TAG, "Could not download the update", error)
            try { installer.abandonSession(sessionId) } catch (_: Throwable) {}
            return "Could not download the update. Check your connection and try again."
        }
    }
}

class BalanceUpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                // Android's own sheet: allow installs from Balance once, then "Update".
                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { context.startActivity(it) }
            }
            PackageInstaller.STATUS_SUCCESS -> {}
            PackageInstaller.STATUS_FAILURE_ABORTED -> {}
            else -> {
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown error"
                Log.w("BalanceUpdater", "Update failed: $message")
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(context.applicationContext, "Balance update failed: $message", Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}
