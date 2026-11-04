// Modify only the generated disposable test APK, never the shipped source.
import { readFile, writeFile } from 'node:fs/promises'
const file = 'src-tauri/gen/android/app/src/main/java/app/balance/local/SituateAccessibility.kt'
let source = await readFile(file, 'utf8')
const marker = 'override fun onAccessibilityEvent(event: AccessibilityEvent?) {'
if (!source.includes(marker)) throw new Error('Missing accessibility event entry point')
source = source.replace(marker, marker + `
        if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0 &&
            java.io.File(filesDir, "situate-ci-drop-events").exists()) return
`)
await writeFile(file, source)
// The native stress host uses the real planner process and WebView, but never
// opens the planner database or runs frontend startup/seeding work.
await writeFile('src-tauri/gen/android/app/src/main/java/app/balance/local/SituatePlannerFixture.kt', `package app.balance.local
class SituatePlannerFixture : android.app.Activity() {
    private val delayed = android.os.Handler(android.os.Looper.getMainLooper())
    override fun onCreate(state: android.os.Bundle?) {
        super.onCreate(state)
        if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0) { finish(); return }
        setContentView(android.webkit.WebView(this).apply {
            loadData("<html><body>Synthetic planner process<input></body></html>", "text/html", "UTF-8")
        })
    }
    override fun onResume() {
        super.onResume()
        notifyResume()
    }
    override fun onNewIntent(next: android.content.Intent) {
        super.onNewIntent(next)
        setIntent(next)
        notifyResume()
    }
    private fun notifyResume() {
        delayed.removeCallbacksAndMessages(null)
        SituateAccessibility.appResumed(this)
        if (intent.getBooleanExtra("late_resume", false)) delayed.postDelayed({
            SituateAccessibility.appResumed(this)
        }, 5000)
    }
}
`)
const manifestPath = 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'
const manifest = await readFile(manifestPath, 'utf8')
await writeFile(manifestPath, manifest.replace('</application>', '<activity android:name=".SituatePlannerFixture" android:exported="false" />\n</application>'))
