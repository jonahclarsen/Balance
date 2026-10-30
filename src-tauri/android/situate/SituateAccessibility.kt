package app.balance.local

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.*
import android.graphics.PixelFormat
import android.os.*
import android.view.*
import android.view.accessibility.AccessibilityEvent
import android.widget.*
import org.json.JSONObject
import java.util.concurrent.Executors

/** Observes app identities only. No node trees, text, usage history, or gestures. */
class SituateAccessibility : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var foregroundPackage = ""
    private var eventTime = 0L
    private var generation = 0L
    private var evaluating = false
    private var connected = false
    private var tracing = false
    private fun trace(message: String) { if (tracing) android.util.Log.i("BalanceSituate", message) }
    private var gate: LinearLayout? = null
    private var gateTitle: TextView? = null
    private var quizUrl = ""
    private var observer: FileObserver? = null
    private val tick = object : Runnable {
        override fun run() {
            if (!connected) return
            reconcile()
            main.postDelayed(this, 1000)
        }
    }
    private val screen = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { invalidate() }
    }
    companion object {
        @Volatile private var current: SituateAccessibility? = null
        fun enforceCurrent() { Handler(Looper.getMainLooper()).post { current?.invalidate() } }
        fun appResumed() { Handler(Looper.getMainLooper()).post {
            current?.let { it.foregroundPackage = it.packageName; it.eventTime = SystemClock.uptimeMillis(); it.invalidate() }
        } }
    }
    override fun onServiceConnected() {
        super.onServiceConnected()
        if (connected) return
        connected = true
        // Explicit opt-in on a disposable debug CI installation; never log real app usage.
        tracing = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0 &&
            java.io.File(filesDir, "situate-ci-trace").exists()
        current = this
        // Accessibility can restart without the planner activity or notification listener.
        BalanceSituate.initialize(this)
        @Suppress("DEPRECATION")
        val watcher = object : FileObserver(noBackupFilesDir.absolutePath, CLOSE_WRITE or MOVED_TO or DELETE) {
            override fun onEvent(event: Int, path: String?) {
                if (path == "situate-rules.json") main.post { if (connected) invalidate() }
            }
        }
        observer = watcher
        watcher.startWatching()
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_USER_PRESENT)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screen, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(screen, filter)
        main.post(tick)
    }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || event.eventTime < eventTime) return
        val pkg = event.packageName?.toString() ?: return
        trace("window package=$pkg changes=${event.contentChangeTypes} class=${event.className} time=${event.eventTime}")
        // Pane changes (including a pane disappearing from the app we just left)
        // are not foreground-window changes. Accepting them can re-block Home.
        if (event.contentChangeTypes != 0) return
        // System panels and our own overlay are not a new foreground app.
        // MainActivity reports its own resume explicitly, including quiz navigation.
        if (pkg == "com.android.systemui" || (pkg == packageName && gate != null)) return
        if (getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                .enabledInputMethodList.any { it.packageName == pkg }) return
        eventTime = event.eventTime
        // Repeated pane events in the same app must not continually discard the
        // in-flight decision. Only an identity/rule/lifecycle change makes it stale.
        if (pkg == foregroundPackage) reconcile()
        else { foregroundPackage = pkg; invalidate() }
    }
    private fun interactive() = getSystemService(PowerManager::class.java).isInteractive &&
        !getSystemService(KeyguardManager::class.java).isKeyguardLocked
    private fun invalidate() {
        generation++
        reconcile()
    }
    private fun reconcile() {
        if (!connected) return
        if (!interactive() || foregroundPackage.isBlank() || foregroundPackage == packageName) {
            hideGate()
            return
        }
        if (evaluating) return
        val expected = generation
        val pkg = foregroundPackage
        evaluating = true
        // Never queue behind archive encryption/export, and never read rules on the UI thread.
        worker.execute {
            val mode = try { BalanceSituate.blocked(this, pkg).firstOrNull() }
            catch (error: Exception) {
                android.util.Log.w("BalanceSituate", "App rule evaluation failed: " + error.javaClass.simpleName)
                null
            }
            main.post {
                evaluating = false
                if (!connected) return@post
                // A queued result must not resurrect a gate after a pass, app switch, or Home.
                if (expected != generation || pkg != foregroundPackage) { reconcile(); return@post }
                trace("decision package=$pkg blocked=${mode != null} generation=$generation")
                if (mode == null || !interactive()) hideGate() else showGate(pkg, mode)
            }
        }
    }
    private fun showGate(pkg: String, mode: JSONObject) {
        val targets = mode.getJSONArray("targets")
        val target = (0 until targets.length()).map { targets.getJSONObject(it) }
            .first { it.optString("kind") == "app" && it.optString("value") == pkg }
        val uri = android.net.Uri.Builder().scheme("balance").authority("situate")
            .appendQueryParameter("mode", mode.getString("id"))
        if (target.optString("category") == "entertainment") uri.appendQueryParameter("target", target.getString("id"))
        quizUrl = uri.build().toString()
        val title = mode.getString("name") + " is on"
        gateTitle?.text = title
        if (gate != null) return
        val themed = ContextThemeWrapper(this, applicationInfo.theme)
        val layout = object : LinearLayout(themed) {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                if (event.keyCode == KeyEvent.KEYCODE_BACK) {
                    if (event.action == KeyEvent.ACTION_UP) leave()
                    return true
                }
                return super.dispatchKeyEvent(event)
            }
        }.apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 100, 48, 48)
            // A service window has no Activity decor to supply an opaque background.
            val background = android.util.TypedValue()
            themed.theme.resolveAttribute(android.R.attr.colorBackground, background, true)
            setBackgroundColor(background.data)
        }
        val heading = TextView(themed).apply { text = title; textSize = 28f }
        layout.addView(heading)
        layout.addView(TextView(themed).apply { text = "Take a moment before opening this app."; textSize = 18f })
        layout.addView(Button(themed).apply { text = "Open quiz"; setOnClickListener {
            startActivity(Intent(this@SituateAccessibility, MainActivity::class.java)
                .setData(android.net.Uri.parse(quizUrl))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            // MainActivity.resume acknowledges the handoff and removes the gate.
        } })
        layout.addView(Button(themed).apply { text = "Keep the boundary"; setOnClickListener { leave() } })
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.OPAQUE
        ).apply { setTitle("Situate app boundary") }
        try {
            getSystemService(WindowManager::class.java).addView(layout, params)
            gate = layout
            gateTitle = heading
            layout.post {
                if (Build.VERSION.SDK_INT >= 33 && gate === layout) layout.findOnBackInvokedDispatcher()?.registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT
                ) { leave() }
            }
        } catch (error: RuntimeException) {
            android.util.Log.w("BalanceSituate", "App gate unavailable: " + error.javaClass.simpleName)
            // Retry on the next tick; never mark a failed window as displayed.
        }
    }
    private fun leave() {
        trace("leave generation=$generation")
        // Home is asynchronous. Keep the gate until the launcher's window
        // event arrives; removing it here briefly refocuses the blocked app,
        // which emits a fresh event and can put a stale gate over Home.
        performGlobalAction(GLOBAL_ACTION_HOME)
    }
    private fun hideGate() {
        val view = gate ?: return
        gate = null
        gateTitle = null
        quizUrl = ""
        getSystemService(WindowManager::class.java).removeViewImmediate(view)
    }
    override fun onUnbind(intent: Intent?): Boolean { disconnect(); return super.onUnbind(intent) }
    override fun onDestroy() { disconnect(); worker.shutdown(); super.onDestroy() }
    private fun disconnect() {
        if (!connected) return
        connected = false
        generation++
        if (current === this) current = null
        observer?.stopWatching()
        observer = null
        unregisterReceiver(screen)
        main.removeCallbacksAndMessages(null)
        hideGate()
    }
    override fun onInterrupt() { invalidate() }
}
