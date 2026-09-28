import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const activityPath = process.argv[2] ?? 'src-tauri/gen/android/app/src/main/java/app/balance/local/MainActivity.kt'
const marker = '// Balance Android selection formatting'
let activity = await readFile(activityPath, 'utf8')
if (!activity.includes(marker)) {
  const end = activity.lastIndexOf('}')
  if (end < 0 || !/class MainActivity\s*:\s*TauriActivity\(\)\s*\{/.test(activity)) {
    throw new Error(`Expected initialized MainActivity body in ${activityPath}`)
  }
  activity = activity.slice(0, end) + `
    ${marker}
    private var startingFormattingActionMode = false

    override fun onWindowStartingActionMode(
        callback: android.view.ActionMode.Callback,
        type: Int,
    ): android.view.ActionMode? {
        if (!startingFormattingActionMode && type == android.view.ActionMode.TYPE_FLOATING) {
            val webView = currentFocus as? android.webkit.WebView
            if (webView != null) {
                startingFormattingActionMode = true
                try {
                    return webView.startActionMode(BalanceSelectionFormatting(webView, callback), type)
                } finally {
                    startingFormattingActionMode = false
                }
            }
        }
        return super.onWindowStartingActionMode(callback, type)
    }
` + activity.slice(end)
  await writeFile(activityPath, activity)
}
const script = await readFile(new URL('../android/selection-formatting.js', import.meta.url), 'utf8')
const template = await readFile(new URL('../android/BalanceSelectionFormatting.kt', import.meta.url), 'utf8')
// JSON string escaping is also valid for this Kotlin string once $ is escaped.
const source = template.replace('__SELECTION_SCRIPT__', () => JSON.stringify(script).replaceAll('$', '\\$'))
await writeFile(join(dirname(activityPath), 'BalanceSelectionFormatting.kt'), source)
