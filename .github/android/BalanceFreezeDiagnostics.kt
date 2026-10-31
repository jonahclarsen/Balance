package app.balance.local

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.MediaStore
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
    /**
     * Saves the report to Downloads (1), or opens the share sheet where that
     * would need a storage permission (2). 0 means neither worked. Called on a
     * Rust blocking worker.
     */
    // Rust calls this by name through JNI; R8 cannot see that reference.
    @androidx.annotation.Keep
    @JvmStatic fun save(report: String): Int {
        val app = context ?: return 0
        if (Build.VERSION.SDK_INT < 29) return if (share(app, report)) 2 else 0
        return try {
            val stamp = java.text.SimpleDateFormat("yyyy-MM-dd-HHmmss", java.util.Locale.US).format(java.util.Date())
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, "balance-freeze-report-$stamp.json")
                put(MediaStore.MediaColumns.MIME_TYPE, "application/json")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = app.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return 0
            try {
                resolver.openOutputStream(uri)!!.use { it.write(report.toByteArray()) }
                resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                1
            } catch (_: Throwable) {
                resolver.delete(uri, null, null)
                0
            }
        } catch (_: Throwable) { 0 }
    }

    /** Writes the report to the app cache, then posts just the chooser to the UI. */
    private fun share(app: Context, report: String): Boolean {
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
