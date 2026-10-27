package app.balance.local

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

/**
 * Chromium routes a Bluetooth headset's microphone to getUserMedia only while
 * the app may connect to Bluetooth devices, a runtime permission on Android 12+.
 * Voice ideas ask for it the first time they record (see src/lib/voiceRecorder.ts).
 */
internal class BalanceVoiceInput(private val activity: AppCompatActivity) {
    @Volatile private var pending = false
    private val launcher = activity.activityResultRegistry.register(
        "balance-voice-bluetooth",
        ActivityResultContracts.RequestPermission(),
    ) { pending = false }

    @JavascriptInterface
    fun bluetoothPermission(): String = when {
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S -> "unneeded"
        pending -> "pending"
        activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED -> "granted"
        else -> "missing"
    }

    @JavascriptInterface
    fun requestBluetoothPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || pending) return
        pending = true
        activity.runOnUiThread { launcher.launch(Manifest.permission.BLUETOOTH_CONNECT) }
    }

    companion object {
        fun attach(activity: AppCompatActivity, webView: WebView) {
            webView.addJavascriptInterface(BalanceVoiceInput(activity), "BalanceVoiceInput")
        }
    }
}
