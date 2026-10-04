package app.balance.local

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.core.content.FileProvider
import java.io.File

// Android requires an app-specific provider for reliable sharing across devices.
class BalanceFreezeReportProvider : FileProvider()

/** No task values, exception strings, URLs, keys or device identifiers. */
object BalanceFreezeDiagnostics {
    init { System.loadLibrary("balance_lib") }
    @JvmStatic external fun signal(kind: Int)
    @JvmStatic external fun device(manufacturer: String, model: String, sdk: Int, webviewVersion: String): Boolean
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var context: Context? = null
    private var deviceRecorded = false
    private val pulse = object : Runnable {
        override fun run() {
            signal(2)
            recordDevice()
            main.postDelayed(this, 5000)
        }
    }
    fun resume(activity: Context) {
        context = activity.applicationContext
        signal(0)
        main.removeCallbacks(pulse)
        main.post(pulse)
    }
    private fun recordDevice() {
        if (deviceRecorded) return
        val version = try { if (Build.VERSION.SDK_INT >= 26) WebView.getCurrentWebViewPackage()?.versionName ?: "unknown" else "unknown" } catch (_: Throwable) { "unknown" }
        // Native setup can follow the first activity callback. Retry from the
        // pulse until the recorder accepts the metadata, without retaining it
        // on an Activity or introducing a startup plugin registration.
        deviceRecorded = device(Build.MANUFACTURER, Build.MODEL, Build.VERSION.SDK_INT, version)
    }
    fun pause() {
        signal(1)
        main.removeCallbacks(pulse)
    }
    /** Called on a Rust blocking worker, then posts just the chooser to the UI. */
    @JvmStatic fun share(report: String): Boolean {
        val app = context ?: return false
        return try {
            val directory = File(app.cacheDir, "freeze-reports")
            directory.mkdirs()
            val file = File(directory, "balance-freeze-report.json")
            file.writeText(report)
            val uri = FileProvider.getUriForFile(app, app.packageName + ".freeze-reports", file)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "application/json"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                clipData = android.content.ClipData.newRawUri("freeze report", uri)
            }
            main.post { try { app.startActivity(Intent.createChooser(intent, "Share freeze report").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Throwable) { signal(3) } }
        } catch (_: Throwable) { false }
    }
}
