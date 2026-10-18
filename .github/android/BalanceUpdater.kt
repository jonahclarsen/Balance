package app.balance.local

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/** Downloads a GitHub release APK straight into Android's package installer. */
object BalanceUpdater {
    private const val LOG_TAG = "BalanceUpdater"
    private const val RELEASE_DOWNLOAD = "https://github.com/jonahclarsen/Balance/releases/download/"
    private const val APK_NAME = "balance-arm64.apk"
    private val TAG_PATTERN = Regex("^v\\d+\\.\\d+\\.\\d+$")

    init { System.loadLibrary("balance_lib") }
    @JvmStatic external fun nativeRegister()
    @JvmStatic external fun nativeStatus(state: String, message: String)
    private val busy = AtomicBoolean(false)

    @Volatile private var context: Context? = null

    fun attach(activity: Context) {
        context = activity.applicationContext
        nativeRegister()
        // CI only: exercise the real installer with this disposable debug APK.
        val marker = File(activity.filesDir, "updater-ci-selftest")
        if (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0 && marker.delete()) {
            Thread {
                Thread.sleep(10_000)
                val result = installApk(activity.applicationContext, null)
                if (result.isNotEmpty()) Log.e(LOG_TAG, "BALANCE_UPDATE_E2E: FAIL $result")
            }.start()
        }
    }

    /** Called on a Rust blocking worker. Returns an empty string once Android has the APK. */
    @JvmStatic fun install(tag: String): String {
        val app = context ?: return "Balance is still starting. Try again in a moment."
        if (!TAG_PATTERN.matches(tag)) return "GitHub's latest release has an unexpected version."
        return installApk(app, tag)
    }

    private fun installApk(app: Context, tag: String?): String {
        if (!busy.compareAndSet(false, true)) return "An update is already running."
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(app.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ permits eligible self-updates without a confirmation sheet.
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = try {
            installer.createSession(params)
        } catch (error: Throwable) {
            Log.w(LOG_TAG, "Could not create an install session", error)
            busy.set(false)
            return "Android would not start the update."
        }
        try {
            installer.openSession(sessionId).use { session ->
                if (tag == null) {
                    val apk = File(app.applicationInfo.sourceDir)
                    apk.inputStream().use { input ->
                        session.openWrite(APK_NAME, 0, apk.length()).use { output ->
                            input.copyTo(output)
                            session.fsync(output)
                        }
                    }
                } else {
                    val connection = URL(RELEASE_DOWNLOAD + tag + "/" + APK_NAME).openConnection() as HttpURLConnection
                    connection.connectTimeout = 15_000
                    connection.readTimeout = 30_000
                    try {
                        check(connection.responseCode == HttpURLConnection.HTTP_OK) {
                            "GitHub returned ${connection.responseCode} for the update download."
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
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
                val status = PendingIntent.getBroadcast(
                    app,
                    sessionId,
                    Intent(app, BalanceUpdateReceiver::class.java).putExtra("selfTest", tag == null),
                    flags,
                )
                nativeStatus("installing", "")
                session.commit(status.intentSender)
            }
            return ""
        } catch (error: Throwable) {
            busy.set(false)
            Log.w(LOG_TAG, "Could not download the update", error)
            try { installer.abandonSession(sessionId) } catch (_: Throwable) {}
            return "Could not download the update. Check your connection and try again."
        }
    }
    fun finished(message: String = "") {
        busy.set(false)
        nativeStatus("idle", message)
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
                if (intent.getBooleanExtra("selfTest", false)) Log.e("BalanceUpdater", "BALANCE_UPDATE_E2E: FAIL confirmation required")
                try {
                    checkNotNull(confirm) { "Android did not provide an installation confirmation." }
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (error: Exception) {
                    BalanceUpdater.finished("Could not open Android’s installer. Try again.")
                    Log.w("BalanceUpdater", "Could not open installation confirmation", error)
                }
            }
            PackageInstaller.STATUS_SUCCESS -> {
                if (intent.getBooleanExtra("selfTest", false)) Log.i("BalanceUpdater", "BALANCE_UPDATE_E2E: OK installed")
                // Android replaces and closes the old process. Installer callbacks
                // cannot start activities from the background; the next launch
                // opens the updated app normally.
            }
            PackageInstaller.STATUS_FAILURE_ABORTED -> BalanceUpdater.finished()
            else -> {
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown error"
                BalanceUpdater.finished("Balance update failed: $message")
                Log.w("BalanceUpdater", "Update failed: $message")
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(context.applicationContext, "Balance update failed: $message", Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}
